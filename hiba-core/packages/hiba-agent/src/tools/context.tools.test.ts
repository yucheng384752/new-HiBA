import { describe, expect, it, beforeEach } from '@jest/globals';
import { HiBAToolbox } from '../core/HiBAToolbox';
import { AuditTrail } from '../audit/AuditTrail';
import { TopologyRegistry } from '../topology/TopologyRegistry';
import { registerContextRetrievalTools } from './context.tools';
import type { AccountingClient } from '../planning/NLPlanningService';
import type { AuditRecord, NodeDescriptor, ToolContext } from '../types/hiba.types';
import { HIBA_PROTOCOL_VERSION } from '../types/hiba.types';

function makeNode(overrides: Partial<NodeDescriptor> = {}): NodeDescriptor {
  return {
    protocolVersion: HIBA_PROTOCOL_VERSION,
    nodeId: 'node1',
    agentUrl: 'http://node1:3000',
    status: 'online',
    canInstall: true,
    resources: [],
    registeredAt: '2026-05-04T00:00:00.000Z',
    lastSeenAt: '2026-05-04T00:00:00.000Z',
    ...overrides,
  };
}

function makeAccounting(nodes: NodeDescriptor[]): AccountingClient {
  return {
    listNodeResources: async () => ({}),
    getNodeResources: async () => [],
    listNodes: async () => nodes,
  };
}

const CTX: ToolContext = {
  agentId: 'test', traceId: 'trace-1', depth: 0,
  hibaBaseUrl: 'http://localhost:9090', permissions: ['orchestrator.read'],
};

describe('registerContextRetrievalTools', () => {
  let toolbox: HiBAToolbox;
  let audit: AuditTrail;
  let topology: TopologyRegistry;

  beforeEach(() => {
    audit = new AuditTrail(':memory:');
    topology = new TopologyRegistry(':memory:');
    toolbox = new HiBAToolbox({ auditWriter: audit, permissions: ['orchestrator.read'] });
  });

  it('registers orchestrator.retrieveContext', () => {
    registerContextRetrievalTools(toolbox, { topology, audit, accounting: makeAccounting([]) });
    expect(toolbox.has('orchestrator.retrieveContext')).toBe(true);
  });

  it('with no domains filter, returns every registered tool unfiltered', async () => {
    // 為什麼重要：目前沒有真正的語意窄化能力，回傳完整目錄是誠實的預設值
    // ——假裝有窄化但其實隨機截斷，比完全不窄化更危險（會靜默漏掉相關工具）。
    registerContextRetrievalTools(toolbox, { topology, audit, accounting: makeAccounting([]) });

    const result = await toolbox.execute('orchestrator.retrieveContext', { intent: '查詢庫存' }, CTX);

    expect(result.success).toBe(true);
    if (result.success) {
      const out = result.output as { tools: Array<{ name: string }> };
      expect(out.tools).toEqual([{ name: 'orchestrator.retrieveContext', score: 1 }]);
    }
  });

  it('domains filter narrows tools to the matching domain prefix', async () => {
    registerContextRetrievalTools(toolbox, { topology, audit, accounting: makeAccounting([]) });

    const result = await toolbox.execute('orchestrator.retrieveContext', {
      intent: '查詢庫存', domains: ['material'],
    }, CTX);

    expect(result.success).toBe(true);
    if (result.success) {
      const out = result.output as { tools: unknown[] };
      expect(out.tools).toEqual([]);
    }
  });

  it('nodes are filtered to online status only', async () => {
    // 為什麼重要：離線節點不該被當成候選派工目標，這是規格 §四/§三 明確要求
    // 的「線上狀態用結構化過濾，不進向量」——這裡驗證的是最基本的過濾正確性。
    const accounting = makeAccounting([
      makeNode({ nodeId: 'node1', status: 'online' }),
      makeNode({ nodeId: 'node2', status: 'offline' }),
    ]);
    registerContextRetrievalTools(toolbox, { topology, audit, accounting });

    const result = await toolbox.execute('orchestrator.retrieveContext', { intent: '查詢庫存' }, CTX);

    expect(result.success).toBe(true);
    if (result.success) {
      const out = result.output as { nodes: Array<{ nodeId: string }> };
      expect(out.nodes).toEqual([{ nodeId: 'node1', score: 1 }]);
    }
  });

  it('topology only includes approved edges, never suggested ones', async () => {
    // 為什麼重要：這是規格 §四 的核心安全保證——AuditTrail 推論出的候選邊
    // 在人工核准前絕對不能出現在 LLM 看到的檢索結果裡。
    topology.upsertManual({ fromNodeId: 'node1', relation: 'upstream_of', toNodeId: 'node2' });
    topology.suggest({ fromNodeId: 'node2', relation: 'upstream_of', toNodeId: 'node3' });
    registerContextRetrievalTools(toolbox, { topology, audit, accounting: makeAccounting([]) });

    const result = await toolbox.execute('orchestrator.retrieveContext', { intent: '查詢庫存' }, CTX);

    expect(result.success).toBe(true);
    if (result.success) {
      const out = result.output as { topology: unknown[] };
      expect(out.topology).toEqual([{ from: 'node1', relation: 'upstream_of', to: 'node2' }]);
    }
  });

  it('exemplars only include successful audit records, capped by topK', async () => {
    for (let i = 0; i < 5; i += 1) {
      await audit.write(exemplarRecord({
        traceId: `trace-${i}`, auditHash: `hash-${i}`, executedAt: `2026-05-04T00:00:0${i}.000Z`,
      }));
    }
    registerContextRetrievalTools(toolbox, { topology, audit, accounting: makeAccounting([]) });

    const result = await toolbox.execute('orchestrator.retrieveContext', {
      intent: '查詢庫存', topK: { tools: 10, nodes: 5, exemplars: 2 },
    }, CTX);

    expect(result.success).toBe(true);
    if (result.success) {
      const out = result.output as { exemplars: unknown[] };
      expect(out.exemplars).toHaveLength(2);
    }
  });

  it('topK.exemplars = 0 returns no exemplars without querying', async () => {
    await audit.write(exemplarRecord({ traceId: 'trace-x', auditHash: 'hash-x' }));
    registerContextRetrievalTools(toolbox, { topology, audit, accounting: makeAccounting([]) });

    const result = await toolbox.execute('orchestrator.retrieveContext', {
      intent: '查詢庫存', topK: { tools: 10, nodes: 5, exemplars: 0 },
    }, CTX);

    expect(result.success).toBe(true);
    if (result.success) {
      const out = result.output as { exemplars: unknown[] };
      expect(out.exemplars).toEqual([]);
    }
  });
});

function exemplarRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    traceId: 'trace-001',
    agentId: 'agent-001',
    depth: 1,
    toolName: 'material.queryStock',
    toolDomain: 'material',
    version: '1.0.0',
    success: true,
    durationMs: 12,
    executedAt: '2026-05-04T00:00:00.000Z',
    auditHash: 'audit-hash-001',
    ...overrides,
  };
}
