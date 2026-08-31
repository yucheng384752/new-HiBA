import { describe, expect, it } from '@jest/globals';
import { HiBAError } from '../core/ScopedToolbox';
import { TopologyRegistry, type TopologyEdgeInput } from './TopologyRegistry';

function edge(overrides: Partial<TopologyEdgeInput> = {}): TopologyEdgeInput {
  return {
    fromNodeId: 'node7',
    relation: 'upstream_of',
    toNodeId: 'node8',
    ...overrides,
  };
}

describe('TopologyRegistry', () => {
  it('upsertManual writes an edge that is immediately approved', () => {
    // 為什麼重要：人工維護是規格 §四 定案的冷啟動解法——新產線上線當下就要有
    // 拓樸資料可用，不能等 AuditTrail 累積歷史執行量才生效。
    const registry = new TopologyRegistry(':memory:');

    const result = registry.upsertManual(edge());

    expect(result.status).toBe('approved');
    expect(result.source).toBe('manual');
    expect(registry.find('node7', 'upstream_of', 'node8')).toEqual(result);
  });

  it('suggest writes a pending edge that does not appear in listApproved', () => {
    // 為什麼重要：這是避免「推論雜訊污染拓樸資料」的核心保護——AuditTrail
    // 自動偵測到的邊在人工核准前，絕對不能被 plan() 看到。
    const registry = new TopologyRegistry(':memory:');

    registry.suggest(edge());

    expect(registry.list({ status: 'suggested' })).toHaveLength(1);
    expect(registry.listApproved()).toHaveLength(0);
  });

  it('suggest does not downgrade an already-approved edge back to suggested', () => {
    // 為什麼重要：AuditTrail 背景掃描是持續執行的——如果每次重新偵測到同一
    // 序列都把已核准的邊打回待審，人工核准的結果會被自動推論悄悄覆蓋掉。
    const registry = new TopologyRegistry(':memory:');
    registry.upsertManual(edge());

    registry.suggest(edge());

    const found = registry.find('node7', 'upstream_of', 'node8');
    expect(found?.status).toBe('approved');
  });

  it('approve moves a suggested edge to approved', () => {
    const registry = new TopologyRegistry(':memory:');
    registry.suggest(edge());

    const approved = registry.approve('node7', 'upstream_of', 'node8');

    expect(approved.status).toBe('approved');
    expect(registry.listApproved()).toHaveLength(1);
  });

  it('approve throws HiBAError when the edge does not exist', () => {
    const registry = new TopologyRegistry(':memory:');

    expect(() => registry.approve('node7', 'upstream_of', 'node8')).toThrow(HiBAError);
    expect(() => registry.approve('node7', 'upstream_of', 'node8')).toThrow(
      expect.objectContaining({ errorCode: 'RESOURCE_NOT_FOUND' }),
    );
  });

  it('upsertManual rejects an invalid relation instead of silently accepting it', () => {
    // 為什麼重要：relation 是 plan() 之後會直接讀出來塞進 prompt 的欄位，
    // 未經檢查的自由字串會讓拓樸資料變成沒有結構保證的垃圾輸入。
    const registry = new TopologyRegistry(':memory:');

    expect(() => registry.upsertManual(edge({ relation: 'flies_over' as never }))).toThrow(
      expect.objectContaining({ errorCode: 'REQUEST_INVALID' }),
    );
  });

  it('listApproved filters by lineId', () => {
    const registry = new TopologyRegistry(':memory:');
    registry.upsertManual(edge({ lineId: 'line-A' }));
    registry.upsertManual(edge({ fromNodeId: 'node9', toNodeId: 'node10', lineId: 'line-B' }));

    const lineA = registry.listApproved('line-A');

    expect(lineA).toHaveLength(1);
    expect(lineA[0]?.fromNodeId).toBe('node7');
  });

  it('upsertManual on an existing key overwrites metadata rather than duplicating rows', () => {
    const registry = new TopologyRegistry(':memory:');
    registry.upsertManual(edge({ metadata: { station: 1 } }));

    registry.upsertManual(edge({ metadata: { station: 3 } }));

    const all = registry.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.metadata).toEqual({ station: 3 });
  });
});
