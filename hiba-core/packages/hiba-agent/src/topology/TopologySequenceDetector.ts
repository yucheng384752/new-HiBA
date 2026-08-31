import type { AuditTrail } from '../audit/AuditTrail';
import type { TopologyRegistry } from './TopologyRegistry';

/**
 * 從 AuditTrail 推論產線拓樸候選邊。
 * 規格：實作規格/plan()_LLM生成品質改善與輕量RAG檢索設計.md §四。
 *
 * 為什麼掃 critical_events 而不是規格原文寫的 audit_trail：查證後發現
 * audit_trail 表根本沒有 nodeId 欄位（只有 agentId，是發起的 agent 不是
 * 實際執行的物理節點）——nodeId 只有在 OrchestratorRunner 把步驟派工到
 * 遠端節點時，才會透過 DATA_TRANSFERRED 事件的 metadata.nodeId 記錄下來
 * （見 OrchestratorRunner.run()）。這其實也符合拓樸邊的本質：local 執行
 * 本來就不代表任何產線站點，只有真正派工到不同物理節點之間的順序才有
 * 拓樸意義，所以只看 remote 派工的 DATA_TRANSFERRED 事件是對的範圍，不是
 * 退而求其次的妥協。
 */
export interface TopologySequenceDetectorOptions {
  /**
   * 同一組 (fromNodeId, toNodeId) 相鄰關係至少要出現幾次，才寫入 suggested
   * 候選邊。規格 §四原文把這個門檻留給實作階段決定；這裡先定 3（連續三次
   * 出現不像巧合的常見經驗法則），不是理論推導出來的數字，有真實資料後
   * 應該回頭校準。
   */
  minOccurrences?: number;
  /** 只看最近 N 毫秒內的事件，避免每次執行都重新掃全表歷史。 */
  lookbackMs?: number;
}

const DEFAULT_MIN_OCCURRENCES = 3;
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

export interface DetectedEdge {
  fromNodeId: string;
  toNodeId: string;
  occurrences: number;
}

interface NodeTransfer {
  traceId: string;
  nodeId: string;
  occurredAt: string;
}

export class TopologySequenceDetector {
  private readonly minOccurrences: number;
  private readonly lookbackMs: number;

  constructor(
    private readonly audit: AuditTrail,
    private readonly topology: TopologyRegistry,
    options: TopologySequenceDetectorOptions = {},
  ) {
    this.minOccurrences = options.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
    this.lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  }

  /**
   * 掃一次，把達到門檻的候選邊寫入 topology（status='suggested'，見
   * TopologyRegistry.suggest()——已核准的邊不會被降級）。回傳這次偵測到
   * 的邊，供呼叫端記錄或測試使用。
   */
  async run(): Promise<DetectedEdge[]> {
    const events = await this.audit.queryEvents({
      eventType: 'DATA_TRANSFERRED',
      since: Date.now() - this.lookbackMs,
    });

    const transfers: NodeTransfer[] = [];
    for (const event of events) {
      const nodeId = event.metadata['nodeId'];
      if (event.success && typeof nodeId === 'string') {
        transfers.push({ traceId: event.traceId, nodeId, occurredAt: event.occurredAt });
      }
    }

    const byTrace = new Map<string, NodeTransfer[]>();
    for (const transfer of transfers) {
      const list = byTrace.get(transfer.traceId) ?? [];
      list.push(transfer);
      byTrace.set(transfer.traceId, list);
    }

    // key 用 JSON.stringify([from, to])，不是用分隔符號拼字串再 split——
    // nodeId 本身可能含有任意字元，拼字串再拆回來在邊界情況下會拆錯。
    const adjacencyCounts = new Map<string, number>();
    for (const list of byTrace.values()) {
      list.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
      for (let i = 0; i < list.length - 1; i += 1) {
        const from = list[i]!.nodeId;
        const to = list[i + 1]!.nodeId;
        if (from === to) continue; // 同一節點連續執行不構成拓樸邊
        const key = JSON.stringify([from, to]);
        adjacencyCounts.set(key, (adjacencyCounts.get(key) ?? 0) + 1);
      }
    }

    const detected: DetectedEdge[] = [];
    for (const [key, occurrences] of adjacencyCounts) {
      if (occurrences < this.minOccurrences) continue;
      const [fromNodeId, toNodeId] = JSON.parse(key) as [string, string];
      this.topology.suggest({ fromNodeId, relation: 'upstream_of', toNodeId });
      detected.push({ fromNodeId, toNodeId, occurrences });
    }

    return detected;
  }
}
