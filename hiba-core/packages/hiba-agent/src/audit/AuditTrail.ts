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
        error_msg TEXT
      );
    `);
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

  async batchUploadToChain(traceIds: string[], ctx: ToolContext): Promise<void> {
    if (traceIds.length === 0) {
      return Promise.resolve();
    }

    const records = this.queryByTraceIds(traceIds);
    if (records.length === 0) {
      return Promise.resolve();
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
    } catch (error) {
      throw new HiBAError('AUDIT_ANCHOR_FAILED', getErrorMessage(error));
    }

    return Promise.resolve();
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
        error_msg
      FROM audit_trail
      ${where}
      ORDER BY executed_at ASC
    `).all(...params) as AuditRecordRow[];

    return Promise.resolve(rows.map(rowToRecord));
  }

  private queryByTraceIds(traceIds: string[]): AuditRecord[] {
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
        error_msg
      FROM audit_trail
      WHERE trace_id IN (${placeholders})
      ORDER BY executed_at ASC
    `).all(...traceIds) as AuditRecordRow[];

    return rows.map(rowToRecord);
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
