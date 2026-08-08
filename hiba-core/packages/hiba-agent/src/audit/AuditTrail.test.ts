import { describe, expect, it, jest, afterEach } from '@jest/globals';
import { AuditTrail } from './AuditTrail';
import { HiBAError } from '../core/ScopedToolbox';
import type {
  AuditRecord,
  ToolContext,
} from '../types/hiba.types';

function createRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    traceId: 'trace-001',
    agentId: 'agent-001',
    depth: 1,
    toolName: 'material.readFile',
    toolDomain: 'material',
    version: '1.0.0',
    success: true,
    durationMs: 12,
    executedAt: '2026-05-04T00:00:00.000Z',
    auditHash: 'audit-hash-001',
    ...overrides,
  };
}

const ctx: ToolContext = {
  hibaBaseUrl: 'http://localhost:8080',
  traceId: 'trace-upload',
  agentId: 'agent-upload',
  depth: 2,
  permissions: [],
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('AuditTrail', () => {
  it('write + query returns the correct AuditRecord with all fields', async () => {
    const auditTrail = new AuditTrail(':memory:');
    const record = createRecord({
      success: false,
      errorCode: 'TOOL_TIMEOUT',
      errorMsg: 'timed out',
    });

    await auditTrail.write(record);
    const records = await auditTrail.query({});

    expect(records).toEqual([record]);
  });

  it('writing the same audit_hash twice remains idempotent with one row', async () => {
    const auditTrail = new AuditTrail(':memory:');
    const record = createRecord();

    await auditTrail.write(record);
    await auditTrail.write(record);
    const records = await auditTrail.query({});

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(record);
  });

  it('query({ traceId }) returns only matching traceId records', async () => {
    const auditTrail = new AuditTrail(':memory:');
    const first = createRecord({
      traceId: 'trace-a',
      auditHash: 'hash-a',
      executedAt: '2026-05-04T00:00:00.000Z',
    });
    const second = createRecord({
      traceId: 'trace-b',
      auditHash: 'hash-b',
      executedAt: '2026-05-04T00:01:00.000Z',
    });

    await auditTrail.write(first);
    await auditTrail.write(second);
    const records = await auditTrail.query({ traceId: 'trace-a' });

    expect(records).toEqual([first]);
  });

  it('query({ agentId }) returns only matching agentId records', async () => {
    const auditTrail = new AuditTrail(':memory:');
    const first = createRecord({
      agentId: 'agent-a',
      auditHash: 'hash-a',
      executedAt: '2026-05-04T00:00:00.000Z',
    });
    const second = createRecord({
      agentId: 'agent-b',
      auditHash: 'hash-b',
      executedAt: '2026-05-04T00:01:00.000Z',
    });

    await auditTrail.write(first);
    await auditTrail.write(second);
    const records = await auditTrail.query({ agentId: 'agent-b' });

    expect(records).toEqual([second]);
  });

  it('query({ since }) returns only records with executedAt >= since', async () => {
    const auditTrail = new AuditTrail(':memory:');
    const before = createRecord({
      auditHash: 'hash-before',
      executedAt: '2026-05-03T23:59:59.000Z',
    });
    const atSince = createRecord({
      auditHash: 'hash-at-since',
      executedAt: '2026-05-04T00:00:00.000Z',
    });
    const after = createRecord({
      auditHash: 'hash-after',
      executedAt: '2026-05-04T00:00:01.000Z',
    });

    await auditTrail.write(before);
    await auditTrail.write(atSince);
    await auditTrail.write(after);
    const records = await auditTrail.query({
      since: Date.parse('2026-05-04T00:00:00.000Z'),
    });

    expect(records).toEqual([atSince, after]);
  });

  it('query({}) returns all records ordered by executedAt ASC', async () => {
    const auditTrail = new AuditTrail(':memory:');
    const second = createRecord({
      auditHash: 'hash-second',
      executedAt: '2026-05-04T00:01:00.000Z',
    });
    const first = createRecord({
      auditHash: 'hash-first',
      executedAt: '2026-05-04T00:00:00.000Z',
    });

    await auditTrail.write(second);
    await auditTrail.write(first);
    const records = await auditTrail.query({});

    expect(records).toEqual([first, second]);
  });

  it('records critical events as hashes without persisting the raw payload', async () => {
    const auditTrail = new AuditTrail(':memory:');
    const event = await auditTrail.recordEvent({
      eventType: 'WORKFLOW_APPROVED',
      traceId: 'trace-workflow',
      actorId: 'user-7',
      subjectId: 'wf-7',
      payload: { secret: 'must-not-be-stored', plan: { steps: 2 } },
      metadata: { stepCount: 2 },
    });

    const records = await auditTrail.queryEvents({ subjectId: 'wf-7' });
    expect(records).toEqual([event]);
    expect(event.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(event.eventHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(records)).not.toContain('must-not-be-stored');
  });

  it('anchors tool audits and critical events in one transaction', async () => {
    const auditTrail = new AuditTrail(':memory:');
    await auditTrail.write(createRecord());
    await auditTrail.recordEvent({
      eventType: 'WORKFLOW_CREATED',
      traceId: 'trace-001',
      actorId: 'agent-001',
      subjectId: 'wf-001',
      payload: { steps: [] },
    });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ anchored: 2, txHash: '0xanchor' }),
    } as Response);

    const result = await auditTrail.batchUploadToChain(['trace-001'], ctx);

    expect(result?.anchored).toBe(2);
    expect(auditTrail.queryUnanchored()).toHaveLength(0);
    expect(auditTrail.queryUnanchoredEvents()).toHaveLength(0);
    expect((await auditTrail.queryEvents({ traceId: 'trace-001' }))[0]?.anchorTxHash).toBe('0xanchor');
  });

  it('batchUploadToChain does not call fetch when no records match traceIds', async () => {
    const auditTrail = new AuditTrail(':memory:');
    const fetchMock = jest.fn();
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);

    await auditTrail.batchUploadToChain(['missing-trace'], ctx);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('batchUploadToChain throws HiBAError(AUDIT_ANCHOR_FAILED) when HTTP fails', async () => {
    const auditTrail = new AuditTrail(':memory:');
    await auditTrail.write(createRecord());
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    await expect(auditTrail.batchUploadToChain(['trace-001'], ctx)).rejects.toMatchObject({
      name: 'HiBAError',
      errorCode: 'AUDIT_ANCHOR_FAILED',
    });
    await expect(auditTrail.batchUploadToChain(['trace-001'], ctx)).rejects.toBeInstanceOf(HiBAError);
  });
});
