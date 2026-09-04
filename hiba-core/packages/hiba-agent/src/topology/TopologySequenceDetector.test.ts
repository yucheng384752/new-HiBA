import { describe, expect, it, jest } from '@jest/globals';
import { AuditTrail } from '../audit/AuditTrail';
import { TopologySequenceDetector } from './TopologySequenceDetector';
import type { AccountingClient } from '../planning/NLPlanningService';
import type { FacilityIndexEntry } from './FacilityTopology.types';

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

/** node1 → 站 s1、node2 → 站 s2，同屬 fac-1 的假 facility index。 */
const FAC_1_INDEX: FacilityIndexEntry = {
  facilityId: 'fac-1',
  name: 'Facility 1',
  stations: [
    { stationId: 's1', nodeId: 'node1', name: 'Station 1' },
    { stationId: 's2', nodeId: 'node2', name: 'Station 2' },
  ],
};

function makeAccounting(facilities: FacilityIndexEntry[] = [FAC_1_INDEX]): jest.Mocked<AccountingClient> {
  return {
    listNodeResources: jest.fn<AccountingClient['listNodeResources']>().mockResolvedValue({}),
    getNodeResources: jest.fn<AccountingClient['getNodeResources']>().mockResolvedValue([]),
    listNodes: jest.fn<AccountingClient['listNodes']>().mockResolvedValue([]),
    listFacilitiesForNodes: jest.fn<AccountingClient['listFacilitiesForNodes']>().mockResolvedValue(facilities),
    getFacility: jest.fn<AccountingClient['getFacility']>().mockRejectedValue(new Error('not used in this test')),
    suggestFacilityEdge: jest.fn<AccountingClient['suggestFacilityEdge']>()
      .mockResolvedValue({} as never),
  };
}

describe('TopologySequenceDetector', () => {
  it('suggests an edge once the same adjacency repeats past the threshold', async () => {
    // 為什麼重要：這是規格 §四「重複出現的序列模式」的核心行為——單一一次
    // node1→node2 不該被當成拓樸證據，門檻存在的意義就是過濾偶發雜訊。
    const audit = new AuditTrail(':memory:');
    const accounting = makeAccounting();
    for (let i = 0; i < 3; i += 1) {
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node1', occurredAt: recent(i * 2) });
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node2', occurredAt: recent(i * 2 + 1) });
    }
    const detector = new TopologySequenceDetector(audit, accounting, { minOccurrences: 3 });

    const detected = await detector.run();

    expect(detected).toEqual([{ fromNodeId: 'node1', toNodeId: 'node2', occurrences: 3 }]);
    expect(accounting.listFacilitiesForNodes).toHaveBeenCalledWith(['node1', 'node2']);
    expect(accounting.suggestFacilityEdge).toHaveBeenCalledWith('fac-1', {
      fromStationId: 's1', relation: 'upstream_of', toStationId: 's2',
    });
  });

  it('does not suggest below the occurrence threshold', async () => {
    const audit = new AuditTrail(':memory:');
    const accounting = makeAccounting();
    for (let i = 0; i < 2; i += 1) {
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node1', occurredAt: recent(i * 2) });
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node2', occurredAt: recent(i * 2 + 1) });
    }
    const detector = new TopologySequenceDetector(audit, accounting, { minOccurrences: 3 });

    const detected = await detector.run();

    expect(detected).toEqual([]);
    expect(accounting.suggestFacilityEdge).not.toHaveBeenCalled();
  });

  it('does not count consecutive steps on the same node as an edge', async () => {
    const audit = new AuditTrail(':memory:');
    const accounting = makeAccounting();
    for (let i = 0; i < 5; i += 1) {
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node1', occurredAt: recent(i * 2) });
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node1', occurredAt: recent(i * 2 + 1) });
    }
    const detector = new TopologySequenceDetector(audit, accounting, { minOccurrences: 3 });

    const detected = await detector.run();

    expect(detected).toEqual([]);
  });

  it('ignores failed transfers as evidence', async () => {
    // 為什麼重要：派工失敗不代表兩個節點之間真的有拓樸關係，混進失敗案例
    // 會讓偵測結果失真。
    const audit = new AuditTrail(':memory:');
    const accounting = makeAccounting();
    for (let i = 0; i < 3; i += 1) {
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node1', occurredAt: recent(i * 2) });
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node2', occurredAt: recent(i * 2 + 1), success: false });
    }
    const detector = new TopologySequenceDetector(audit, accounting, { minOccurrences: 3 });

    const detected = await detector.run();

    expect(detected).toEqual([]);
  });

  it('skips adjacencies where no single facility knows both nodes', async () => {
    // 為什麼重要：場域/站點要先有人工登記，自動偵測才有東西可以掛——這是
    // 預期中的冷啟動行為，不是要當成錯誤處理。
    const audit = new AuditTrail(':memory:');
    const accounting = makeAccounting([]); // 沒有任何場域認得這兩個節點
    for (let i = 0; i < 3; i += 1) {
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node1', occurredAt: recent(i * 2) });
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node2', occurredAt: recent(i * 2 + 1) });
    }
    const detector = new TopologySequenceDetector(audit, accounting, { minOccurrences: 3 });

    const detected = await detector.run();

    expect(detected).toEqual([]);
    expect(accounting.suggestFacilityEdge).not.toHaveBeenCalled();
  });

  it('ignores events outside the lookback window', async () => {
    const audit = new AuditTrail(':memory:');
    const accounting = makeAccounting();
    const oldTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 天前
    for (let i = 0; i < 3; i += 1) {
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node1', occurredAt: new Date(oldTimestamp).toISOString() });
      insertTransferEvent(audit, { traceId: `trace-${i}`, nodeId: 'node2', occurredAt: new Date(oldTimestamp + 1000).toISOString() });
    }
    const detector = new TopologySequenceDetector(audit, accounting, { minOccurrences: 3, lookbackMs: 7 * 24 * 60 * 60 * 1000 });

    const detected = await detector.run();

    expect(detected).toEqual([]);
  });
});
