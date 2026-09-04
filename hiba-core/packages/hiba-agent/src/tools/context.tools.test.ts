import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { HiBAToolbox } from '../core/HiBAToolbox';
import { AuditTrail } from '../audit/AuditTrail';
import { registerContextRetrievalTools } from './context.tools';
import type { AccountingClient } from '../planning/NLPlanningService';
import type { FacilityIndexEntry, FacilityTopologyDocument } from '../topology/FacilityTopology.types';
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

function makeFacilityDoc(overrides: Partial<FacilityTopologyDocument> = {}): FacilityTopologyDocument {
  return {
    schemaVersion: 1,
    facilityId: 'fac-1',
    name: 'Test Facility',
    processDescription: 'cut -> qc',
    stations: [
      { stationId: 's1', name: 'Station 1', nodeId: 'node1', description: 'first station', metadata: {} },
      { stationId: 's2', name: 'Station 2', nodeId: 'node2', description: 'second station', metadata: {} },
    ],
    edges: [],
    updatedAt: '2026-05-04T00:00:00.000Z',
    ...overrides,
  };
}

function makeAccounting(nodes: NodeDescriptor[] = []): jest.Mocked<AccountingClient> {
  return {
    listNodeResources: jest.fn<AccountingClient['listNodeResources']>().mockResolvedValue({}),
    getNodeResources: jest.fn<AccountingClient['getNodeResources']>().mockResolvedValue([]),
    listNodes: jest.fn<AccountingClient['listNodes']>().mockResolvedValue(nodes),
    listFacilitiesForNodes: jest.fn<AccountingClient['listFacilitiesForNodes']>().mockResolvedValue([]),
    getFacility: jest.fn<AccountingClient['getFacility']>().mockRejectedValue(new Error('unexpected getFacility call')),
    suggestFacilityEdge: jest.fn<AccountingClient['suggestFacilityEdge']>().mockRejectedValue(new Error('not used in this test')),
  };
}

const CTX: ToolContext = {
  agentId: 'test', traceId: 'trace-1', depth: 0,
  hibaBaseUrl: 'http://localhost:9090', permissions: ['orchestrator.read'],
};

describe('registerContextRetrievalTools', () => {
  let toolbox: HiBAToolbox;
  let audit: AuditTrail;

  beforeEach(() => {
    audit = new AuditTrail(':memory:');
    toolbox = new HiBAToolbox({ auditWriter: audit, permissions: ['orchestrator.read'] });
  });

  it('registers orchestrator.retrieveContext', () => {
    registerContextRetrievalTools(toolbox, { audit, accounting: makeAccounting([]) });
    expect(toolbox.has('orchestrator.retrieveContext')).toBe(true);
  });

  it('with no domains filter, returns every registered tool unfiltered', async () => {
    // 為什麼重要：目前沒有真正的語意窄化能力，回傳完整目錄是誠實的預設值
    // ——假裝有窄化但其實隨機截斷，比完全不窄化更危險（會靜默漏掉相關工具）。
    registerContextRetrievalTools(toolbox, { audit, accounting: makeAccounting([]) });

    const result = await toolbox.execute('orchestrator.retrieveContext', { intent: '查詢庫存' }, CTX);

    expect(result.success).toBe(true);
    if (result.success) {
      const out = result.output as { tools: Array<{ name: string }> };
      expect(out.tools).toEqual([{ name: 'orchestrator.retrieveContext', score: 1 }]);
    }
  });

  it('domains filter narrows tools to the matching domain prefix', async () => {
    registerContextRetrievalTools(toolbox, { audit, accounting: makeAccounting([]) });

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
    registerContextRetrievalTools(toolbox, { audit, accounting });

    const result = await toolbox.execute('orchestrator.retrieveContext', { intent: '查詢庫存' }, CTX);

    expect(result.success).toBe(true);
    if (result.success) {
      const out = result.output as { nodes: Array<{ nodeId: string }> };
      expect(out.nodes).toEqual([{ nodeId: 'node1', score: 1 }]);
    }
  });

  it('resolves facilities from the online-node candidate set and only surfaces approved edges', async () => {
    // 為什麼重要：這是新設計的核心安全保證——AuditTrail 推論出的候選邊在
    // 人工核准前絕對不能出現在 LLM 看到的檢索結果裡；場域反查也必須只用
    // online 節點清單，不能拿離線節點去問 accounting-server。
    const accounting = makeAccounting([makeNode({ nodeId: 'node1', status: 'online' })]);
    const indexEntry: FacilityIndexEntry = {
      facilityId: 'fac-1', name: 'Test Facility',
      stations: [{ stationId: 's1', nodeId: 'node1', name: 'Station 1' }],
    };
    accounting.listFacilitiesForNodes.mockResolvedValue([indexEntry]);
    accounting.getFacility.mockResolvedValue(makeFacilityDoc({
      edges: [
        {
          fromStationId: 's1', relation: 'upstream_of', toStationId: 's2', lineId: null,
          status: 'approved', source: 'manual', metadata: {}, updatedAt: '2026-05-04T00:00:00.000Z',
        },
      ],
    }));
    registerContextRetrievalTools(toolbox, { audit, accounting });

    const result = await toolbox.execute('orchestrator.retrieveContext', { intent: '查詢庫存' }, CTX);

    expect(accounting.listFacilitiesForNodes).toHaveBeenCalledWith(['node1']);
    expect(accounting.getFacility).toHaveBeenCalledWith('fac-1', { status: 'approved' });
    expect(result.success).toBe(true);
    if (result.success) {
      const out = result.output as { topology: Array<{ facilityId: string; edges: unknown[] }> };
      expect(out.topology).toEqual([{
        facilityId: 'fac-1',
        name: 'Test Facility',
        processDescription: 'cut -> qc',
        stations: [
          { stationId: 's1', name: 'Station 1', nodeId: 'node1', description: 'first station' },
          { stationId: 's2', name: 'Station 2', nodeId: 'node2', description: 'second station' },
        ],
        edges: [{ fromStationId: 's1', relation: 'upstream_of', toStationId: 's2', lineId: null }],
      }]);
    }
  });

  it('no online nodes → topology is empty and getFacility is never called', async () => {
    const accounting = makeAccounting([makeNode({ nodeId: 'node1', status: 'offline' })]);
    registerContextRetrievalTools(toolbox, { audit, accounting });

    const result = await toolbox.execute('orchestrator.retrieveContext', { intent: '查詢庫存' }, CTX);

    expect(accounting.listFacilitiesForNodes).not.toHaveBeenCalled();
    expect(accounting.getFacility).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    if (result.success) {
      const out = result.output as { topology: unknown[] };
      expect(out.topology).toEqual([]);
    }
  });

  it('exemplars only include successful audit records, capped by topK', async () => {
    for (let i = 0; i < 5; i += 1) {
      await audit.write(exemplarRecord({
        traceId: `trace-${i}`, auditHash: `hash-${i}`, executedAt: `2026-05-04T00:00:0${i}.000Z`,
      }));
    }
    registerContextRetrievalTools(toolbox, { audit, accounting: makeAccounting([]) });

    const result = await toolbox.execute('orchestrator.retrieveContext', {
      intent: '查詢庫存', topK: { tools: 10, nodes: 5, exemplars: 2, facilities: 5 },
    }, CTX);

    expect(result.success).toBe(true);
    if (result.success) {
      const out = result.output as { exemplars: unknown[] };
      expect(out.exemplars).toHaveLength(2);
    }
  });

  it('topK.exemplars = 0 returns no exemplars without querying', async () => {
    await audit.write(exemplarRecord({ traceId: 'trace-x', auditHash: 'hash-x' }));
    registerContextRetrievalTools(toolbox, { audit, accounting: makeAccounting([]) });

    const result = await toolbox.execute('orchestrator.retrieveContext', {
      intent: '查詢庫存', topK: { tools: 10, nodes: 5, exemplars: 0, facilities: 5 },
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
