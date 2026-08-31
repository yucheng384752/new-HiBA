import { describe, expect, it } from '@jest/globals';
import { AuditTrail } from '../audit/AuditTrail';
import { TopologyRegistry } from './TopologyRegistry';
import { TopologySequenceDetector } from './TopologySequenceDetector';

// recordEvent() always stamps real wall-clock time and can't take a custom
// occurredAt, which would make ordering-sensitive tests flaky (two fast
// sequential calls can land in the same millisecond). Insert directly via
// the already-public `db` handle instead — same pattern TrustRegistry.test.ts
// uses (jest.spyOn(registry.db, ...)) — so occurredAt is fully controlled.
function insertTransferEvent(audit: AuditTrail, opts: {
  traceId: string; nodeId: string; occurredAt: string; success?: boolean;
}): void {
  const success = opts.success ?? true;
  audit.db.prepare(`
    INSERT INTO critical_events (
      event_hash, event_id, event_type, trace_id, actor_id, subject_id,
      payload_hash, metadata_json, success, occurred_at
    ) VALUES (?, ?, 'DATA_TRANSFERRED', ?, 'orchestrator', 'run-1', 'payload-hash', ?, ?, ?)
  `).run(
    `hash-${opts.traceId}-${opts.nodeId}-${opts.occurredAt}`,
    `evt-${opts.traceId}-${opts.nodeId}-${opts.occurredAt}`,
    opts.traceId,
    JSON.stringify({ stepId: 'S1', nodeId: opts.nodeId, toolName: 'machine.executeOrder' }),
    success ? 1 : 0,
    opts.occurredAt,
  );
}

// 產生一組落在預設 7 天 lookback 窗口內、且遞增（offsetSeconds 越大越晚）
// 的 ISO 時間字串——不能用寫死的日期（其他測試檔常見的 2026-05-04 之類
// 佔位日期），因為這個偵測器真的會用 Date.now() 過濾，寫死的過去日期一旦
// 超過 lookbackMs 就會被濾掉。錨點訂在 60 秒前，往後用 offsetSeconds 遞增，
// 確保呼叫端只要讓 to 的 offset 比 from 大，排序就一定正確。
const RECENT_ANCHOR_MS = Date.now() - 60_000;
function recent(offsetSeconds: number): string {
  return new Date(RECENT_ANCHOR_MS + offsetSeconds * 1000).toISOString();
}

describe('TopologySequenceDetector', () => {
  it('suggests an edge once the same adjacency repeats past the threshold', async () => {
    // 為什麼重要：這是規格 §四「重複出現的序列模式」的核心行為——單一一次
    // node1→node2 不該被當成拓樸證據，門檻存在的意義就是過濾偶發雜訊。
    const audit = new AuditTrail(':memory:');
    const topology = new TopologyRegistry(':memory:');
    for (let i = 0; i < 3; i += 1) {
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node1', occurredAt: recent(i * 2) });
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node2', occurredAt: recent(i * 2 + 1) });
    }
    const detector = new TopologySequenceDetector(audit, topology, { minOccurrences: 3 });

    const detected = await detector.run();

    expect(detected).toEqual([{ fromNodeId: 'node1', toNodeId: 'node2', occurrences: 3 }]);
    const edge = topology.find('node1', 'upstream_of', 'node2');
    expect(edge?.status).toBe('suggested');
    expect(edge?.source).toBe('audit_trail_inference');
  });

  it('does not suggest below the occurrence threshold', async () => {
    const audit = new AuditTrail(':memory:');
    const topology = new TopologyRegistry(':memory:');
    for (let i = 0; i < 2; i += 1) {
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node1', occurredAt: recent(i * 2) });
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node2', occurredAt: recent(i * 2 + 1) });
    }
    const detector = new TopologySequenceDetector(audit, topology, { minOccurrences: 3 });

    const detected = await detector.run();

    expect(detected).toEqual([]);
    expect(topology.list()).toHaveLength(0);
  });

  it('does not count consecutive steps on the same node as an edge', async () => {
    const audit = new AuditTrail(':memory:');
    const topology = new TopologyRegistry(':memory:');
    for (let i = 0; i < 5; i += 1) {
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node1', occurredAt: recent(i * 2) });
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node1', occurredAt: recent(i * 2 + 1) });
    }
    const detector = new TopologySequenceDetector(audit, topology, { minOccurrences: 3 });

    const detected = await detector.run();

    expect(detected).toEqual([]);
  });

  it('ignores failed transfers as evidence', async () => {
    // 為什麼重要：派工失敗不代表兩個節點之間真的有拓樸關係，混進失敗案例
    // 會讓偵測結果失真。
    const audit = new AuditTrail(':memory:');
    const topology = new TopologyRegistry(':memory:');
    for (let i = 0; i < 3; i += 1) {
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node1', occurredAt: recent(i * 2) });
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node2', occurredAt: recent(i * 2 + 1), success: false });
    }
    const detector = new TopologySequenceDetector(audit, topology, { minOccurrences: 3 });

    const detected = await detector.run();

    expect(detected).toEqual([]);
  });

  it('does not re-suggest (or downgrade) an edge that is already approved', async () => {
    const audit = new AuditTrail(':memory:');
    const topology = new TopologyRegistry(':memory:');
    topology.upsertManual({ fromNodeId: 'node1', relation: 'upstream_of', toNodeId: 'node2' });
    for (let i = 0; i < 3; i += 1) {
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node1', occurredAt: recent(i * 2) });
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node2', occurredAt: recent(i * 2 + 1) });
    }
    const detector = new TopologySequenceDetector(audit, topology, { minOccurrences: 3 });

    await detector.run();

    const edge = topology.find('node1', 'upstream_of', 'node2');
    expect(edge?.status).toBe('approved');
  });

  it('ignores events outside the lookback window', async () => {
    const audit = new AuditTrail(':memory:');
    const topology = new TopologyRegistry(':memory:');
    const oldTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 天前
    for (let i = 0; i < 3; i += 1) {
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node1', occurredAt: new Date(oldTimestamp).toISOString() });
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node2', occurredAt: new Date(oldTimestamp + 1000).toISOString() });
    }
    const detector = new TopologySequenceDetector(audit, topology, { minOccurrences: 3, lookbackMs: 7 * 24 * 60 * 60 * 1000 });

    const detected = await detector.run();

    expect(detected).toEqual([]);
  });
});
