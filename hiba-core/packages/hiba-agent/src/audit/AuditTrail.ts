import { createHash, randomUUID } from 'node:crypto';
import { HiBAError } from '../core/ScopedToolbox';
import type {
  AuditRecord,
  AuditWriter,
  HiBAErrorCode,
  ToolContext,
} from '../types/hiba.types';

interface SqliteRunResult {
  changes: number;
}

interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

interface AuditRecordRow {
  audit_hash: string;
  trace_id: string;
  agent_id: string;
  depth: number;
  tool_name: string;
  tool_domain: string;
  version: string;
  success: 0 | 1;
  duration_ms: number;
  executed_at: string;
  error_code: HiBAErrorCode | null;
  error_msg: string | null;
  anchored_at?: string | null;
  anchor_tx_hash?: string | null;
}

export type CriticalEventType = 'WORKFLOW_CREATED' | 'WORKFLOW_APPROVED' | 'DATA_TRANSFERRED';

export interface CriticalEventInput {
  eventType: CriticalEventType;
  traceId: string;
  actorId: string;
  subjectId: string;
  payload: unknown;
  metadata?: Record<string, unknown>;
  success?: boolean;
}

export interface CriticalEventRecord {
  protocolVersion: '1.0';
  eventId: string;
  eventType: CriticalEventType;
  traceId: string;
  actorId: string;
  subjectId: string;
  payloadHash: string;
  metadata: Record<string, unknown>;
  success: boolean;
  occurredAt: string;
  eventHash: string;
  anchoredAt: string | null;
  anchorTxHash: string | null;
}

interface CriticalEventRow {
  event_hash: string;
  event_id: string;
  event_type: CriticalEventType;
  trace_id: string;
  actor_id: string;
  subject_id: string;
  payload_hash: string;
  metadata_json: string;
  success: 0 | 1;
  occurred_at: string;
  anchored_at: string | null;
  anchor_tx_hash: string | null;
}

export interface ChainAnchorResult {
  anchored: number;
  txHash: string;
  blockHash?: string;
  blockNumber?: number;
  contractAddress?: string;
  chainId?: number;
  mode?: string;
}

export interface AnchorableAuditRecord extends AuditRecord {
  anchoredAt: string | null;
  anchorTxHash: string | null;
}

export class AuditTrail implements AuditWriter {
  readonly db: SqliteDatabase;

  constructor(dbPath: string) {
    const Database = require('better-sqlite3') as new (path: string) => SqliteDatabase;
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_trail (
        audit_hash TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        depth INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        tool_domain TEXT NOT NULL,
        version TEXT NOT NULL,
        success INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        executed_at TEXT NOT NULL,
        error_code TEXT,
        error_msg TEXT,
        anchored_at TEXT,
        anchor_tx_hash TEXT
      );
      CREATE TABLE IF NOT EXISTS critical_events (
        event_hash TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        success INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        anchored_at TEXT,
        anchor_tx_hash TEXT
      );
    `);
    this.migrateAnchorColumns();
  }

  private migrateAnchorColumns(): void {
    for (const sql of [
      'ALTER TABLE audit_trail ADD COLUMN anchored_at TEXT',
      'ALTER TABLE audit_trail ADD COLUMN anchor_tx_hash TEXT',
    ]) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }
  }

  async write(record: AuditRecord): Promise<void> {
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO audit_trail (
          audit_hash,
          trace_id,
          agent_id,
          depth,
          tool_name,
          tool_domain,
          version,
          success,
          duration_ms,
          executed_at,
          error_code,
          error_msg
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.auditHash,
        record.traceId,
        record.agentId,
        record.depth,
        record.toolName,
        record.toolDomain,
        record.version,
        record.success ? 1 : 0,
        record.durationMs,
        record.executedAt,
        record.errorCode ?? null,
        record.errorMsg ?? null,
      );
    } catch (error) {
      throw new HiBAError('AUDIT_ANCHOR_FAILED', getErrorMessage(error));
    }

    return Promise.resolve();
  }

  async recordEvent(input: CriticalEventInput): Promise<CriticalEventRecord> {
    const event = createCriticalEvent(input);
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO critical_events (
          event_hash, event_id, event_type, trace_id, actor_id, subject_id,
          payload_hash, metadata_json, success, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.eventHash,
        event.eventId,
        event.eventType,
        event.traceId,
        event.actorId,
        event.subjectId,
        event.payloadHash,
        JSON.stringify(event.metadata),
        event.success ? 1 : 0,
        event.occurredAt,
      );
      return event;
    } catch (error) {
      throw new HiBAError('AUDIT_ANCHOR_FAILED', getErrorMessage(error));
    }
  }

  async batchUploadToChain(traceIds: string[], ctx: ToolContext): Promise<ChainAnchorResult | null> {
    if (traceIds.length === 0) {
      return null;
    }

    const auditRecords = this.queryUnanchoredByTraceIds(traceIds);
    const eventRecords = this.queryUnanchoredEventsByTraceIds(traceIds);
    const records = [...auditRecords, ...eventRecords];
    if (records.length === 0) {
      return null;
    }

    try {
      const response = await fetch(`${ctx.hibaBaseUrl}/api/audit/anchor`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Id': ctx.traceId,
          'X-Agent-Id': ctx.agentId,
          'X-Depth': String(ctx.depth),
        },
        body: JSON.stringify({ records }),
      });

      if (!response.ok) {
        throw new Error(`Audit anchor failed with HTTP ${response.status}`);
      }
      const result = await response.json() as ChainAnchorResult;
      if (!result.txHash) throw new Error('Audit anchor response did not include txHash');
      this.markAnchored(auditRecords.map(record => record.auditHash), result.txHash);
      this.markEventsAnchored(eventRecords.map(record => record.eventHash), result.txHash);
      return result;
    } catch (error) {
      throw new HiBAError('AUDIT_ANCHOR_FAILED', getErrorMessage(error));
    }
  }

  async query(filter: {
    traceId?: string;
    agentId?: string;
    since?: number;
  }): Promise<AuditRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.traceId !== undefined) {
      clauses.push('trace_id = ?');
      params.push(filter.traceId);
    }

    if (filter.agentId !== undefined) {
      clauses.push('agent_id = ?');
      params.push(filter.agentId);
    }

    if (filter.since !== undefined) {
      clauses.push('executed_at >= ?');
      params.push(new Date(filter.since).toISOString());
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT
        audit_hash,
        trace_id,
        agent_id,
        depth,
        tool_name,
        tool_domain,
        version,
        success,
        duration_ms,
        executed_at,
        error_code,
        error_msg,
        anchored_at,
        anchor_tx_hash
      FROM audit_trail
      ${where}
      ORDER BY executed_at ASC
    `).all(...params) as AuditRecordRow[];

    return Promise.resolve(rows.map(rowToRecord));
  }

  private queryUnanchoredByTraceIds(traceIds: string[]): AnchorableAuditRecord[] {
    const placeholders = traceIds.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT
        audit_hash,
        trace_id,
        agent_id,
        depth,
        tool_name,
        tool_domain,
        version,
        success,
        duration_ms,
        executed_at,
        error_code,
        error_msg,
        anchored_at,
        anchor_tx_hash
      FROM audit_trail
      WHERE trace_id IN (${placeholders}) AND anchored_at IS NULL
      ORDER BY executed_at ASC
    `).all(...traceIds) as AuditRecordRow[];

    return rows.map(rowToAnchorableRecord);
  }

  async queryEvents(filter: {
    traceId?: string;
    subjectId?: string;
    eventType?: CriticalEventType;
  }): Promise<CriticalEventRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of [
      ['trace_id', filter.traceId],
      ['subject_id', filter.subjectId],
      ['event_type', filter.eventType],
    ] as const) {
      if (value !== undefined) {
        clauses.push(`${column} = ?`);
        params.push(value);
      }
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM critical_events ${where} ORDER BY occurred_at ASC`).all(...params) as CriticalEventRow[];
    return rows.map(rowToCriticalEvent);
  }

  queryUnanchoredEvents(limit = 100): CriticalEventRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM critical_events
      WHERE anchored_at IS NULL
      ORDER BY occurred_at ASC
      LIMIT ?
    `).all(limit) as CriticalEventRow[];
    return rows.map(rowToCriticalEvent);
  }

  private queryUnanchoredEventsByTraceIds(traceIds: string[]): CriticalEventRecord[] {
    const placeholders = traceIds.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT * FROM critical_events
      WHERE trace_id IN (${placeholders}) AND anchored_at IS NULL
      ORDER BY occurred_at ASC
    `).all(...traceIds) as CriticalEventRow[];
    return rows.map(rowToCriticalEvent);
  }

  queryUnanchored(limit = 100): AnchorableAuditRecord[] {
    const rows = this.db.prepare(`
      SELECT
        audit_hash,
        trace_id,
        agent_id,
        depth,
        tool_name,
        tool_domain,
        version,
        success,
        duration_ms,
        executed_at,
        error_code,
        error_msg,
        anchored_at,
        anchor_tx_hash
      FROM audit_trail
      WHERE anchored_at IS NULL
      ORDER BY executed_at ASC
      LIMIT ?
    `).all(limit) as AuditRecordRow[];

    return rows.map(rowToAnchorableRecord);
  }

  markAnchored(auditHashes: string[], txHash: string): void {
    if (auditHashes.length === 0) {
      return;
    }

    const anchoredAt = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE audit_trail
      SET anchored_at = ?, anchor_tx_hash = ?
      WHERE audit_hash = ?
    `);
    for (const auditHash of auditHashes) {
      stmt.run(anchoredAt, txHash, auditHash);
    }
  }

  markEventsAnchored(eventHashes: string[], txHash: string): void {
    if (eventHashes.length === 0) return;
    const anchoredAt = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE critical_events SET anchored_at = ?, anchor_tx_hash = ? WHERE event_hash = ?
    `);
    for (const eventHash of eventHashes) stmt.run(anchoredAt, txHash, eventHash);
  }
}

function rowToRecord(row: AuditRecordRow): AuditRecord {
  return {
    traceId: row.trace_id,
    agentId: row.agent_id,
    depth: row.depth,
    toolName: row.tool_name,
    toolDomain: row.tool_domain,
    version: row.version,
    success: row.success === 1,
    durationMs: row.duration_ms,
    executedAt: row.executed_at,
    ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
    ...(row.error_msg !== null ? { errorMsg: row.error_msg } : {}),
    auditHash: row.audit_hash,
  };
}

function rowToAnchorableRecord(row: AuditRecordRow): AnchorableAuditRecord {
  return {
    ...rowToRecord(row),
    anchoredAt: row.anchored_at ?? null,
    anchorTxHash: row.anchor_tx_hash ?? null,
  };
}

function rowToCriticalEvent(row: CriticalEventRow): CriticalEventRecord {
  return {
    protocolVersion: '1.0',
    eventId: row.event_id,
    eventType: row.event_type,
    traceId: row.trace_id,
    actorId: row.actor_id,
    subjectId: row.subject_id,
    payloadHash: row.payload_hash,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    success: row.success === 1,
    occurredAt: row.occurred_at,
    eventHash: row.event_hash,
    anchoredAt: row.anchored_at,
    anchorTxHash: row.anchor_tx_hash,
  };
}

function createCriticalEvent(input: CriticalEventInput): CriticalEventRecord {
  const metadata = JSON.parse(canonicalJson(input.metadata ?? {})) as Record<string, unknown>;
  const event = {
    protocolVersion: '1.0' as const,
    eventId: `evt-${randomUUID()}`,
    eventType: input.eventType,
    traceId: input.traceId,
    actorId: input.actorId,
    subjectId: input.subjectId,
    payloadHash: sha256(canonicalJson(input.payload)),
    metadata,
    success: input.success ?? true,
    occurredAt: new Date().toISOString(),
  };
  return {
    ...event,
    eventHash: sha256(canonicalJson(event)),
    anchoredAt: null,
    anchorTxHash: null,
  };
}

export function verifyCriticalEvent(record: CriticalEventRecord): boolean {
  const {
    eventHash,
    anchoredAt: _anchoredAt,
    anchorTxHash: _anchorTxHash,
    ...content
  } = record;
  return sha256(canonicalJson(content)) === eventHash;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
