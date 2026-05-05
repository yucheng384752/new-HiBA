/**
 * hiba.audit.sqlite.ts — SQLite 持久化 AuditWriter（T2 定理落地）
 *
 * 使用 Node.js v22 內建 node:sqlite，無需外部依賴。
 *
 * 提供兩個 public export：
 *   SqliteAuditWriter  — 實作 AuditWriter 介面，寫入 tool_audit_log
 *   verifyIntegrity    — 重算 auditHash 比對 DB 記錄，偵測投毒竄改（C2 實驗）
 *
 * 資料表欄位說明：
 *   toolDomain  → 計費分類（Accounting Server 需要）
 *   auditHash   → SHA-256(traceId|toolName|executedAt|success)，比對用
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { AuditRecord, AuditWriter } from './hiba.types';

// ── Schema ────────────────────────────────────────────────────────────────────

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS tool_audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  traceId     TEXT    NOT NULL,
  agentId     TEXT    NOT NULL,
  depth       INTEGER NOT NULL,
  toolName    TEXT    NOT NULL,
  toolDomain  TEXT    NOT NULL,
  version     TEXT    NOT NULL,
  success     INTEGER NOT NULL,
  durationMs  INTEGER NOT NULL,
  executedAt  TEXT    NOT NULL,
  errorCode   TEXT,
  errorMsg    TEXT,
  auditHash   TEXT    NOT NULL
)`.trim();

const INSERT_SQL = `
INSERT INTO tool_audit_log
  (traceId, agentId, depth, toolName, toolDomain, version,
   success, durationMs, executedAt, errorCode, errorMsg, auditHash)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`.trim();

// ── SqliteAuditWriter ─────────────────────────────────────────────────────────

export class SqliteAuditWriter implements AuditWriter {
  private readonly db: DatabaseSync;

  /**
   * @param dbPath SQLite 檔案路徑，傳入 ':memory:' 可用於測試
   */
  constructor(dbPath: string = 'audit_trail.db') {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(CREATE_TABLE_SQL);
  }

  async write(record: AuditRecord): Promise<void> {
    this.db.prepare(INSERT_SQL).run(
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
      record.errorMsg  ?? null,
      record.auditHash,
    );
  }

  /** 查詢指定 traceId 的所有稽核記錄（依 id 升序） */
  queryByTraceId(traceId: string): AuditRow[] {
    return this.db
      .prepare('SELECT * FROM tool_audit_log WHERE traceId = ? ORDER BY id ASC')
      .all(traceId) as unknown as AuditRow[];
  }

  /** 查詢全部記錄（測試用） */
  queryAll(): AuditRow[] {
    return this.db
      .prepare('SELECT * FROM tool_audit_log ORDER BY id ASC')
      .all() as unknown as AuditRow[];
  }

  close(): void {
    this.db.close();
  }
}

// ── AuditRow（DB 原始列型別）─────────────────────────────────────────────────

export interface AuditRow {
  id: number;
  traceId: string;
  agentId: string;
  depth: number;
  toolName: string;
  toolDomain: string;
  version: string;
  success: number;   // 0 | 1
  durationMs: number;
  executedAt: string;
  errorCode: string | null;
  errorMsg: string | null;
  auditHash: string;
}

// ── verifyIntegrity ───────────────────────────────────────────────────────────

export interface IntegrityResult {
  rowId: number;
  traceId: string;
  toolName: string;
  ok: boolean;
  storedHash: string;
  computedHash: string;
}

/**
 * 重算每筆記錄的 auditHash，比對 DB 儲存值。
 * 任何不一致即表示記錄遭竄改（C2 投毒偵測實驗）。
 *
 * @returns 每筆記錄的驗證結果，ok=false 表示偵測到竄改
 */
export function verifyIntegrity(writer: SqliteAuditWriter): IntegrityResult[] {
  return writer.queryAll().map(row => {
    const computedHash = createHash('sha256')
      .update(`${row.traceId}|${row.toolName}|${row.executedAt}|${row.success === 1}`)
      .digest('hex');
    return {
      rowId:        row.id,
      traceId:      row.traceId,
      toolName:     row.toolName,
      ok:           computedHash === row.auditHash,
      storedHash:   row.auditHash,
      computedHash,
    };
  });
}
