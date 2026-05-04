import { HiBAError } from '../core/ScopedToolbox';

export interface AgentRecord {
  agentId: string;
  role: 'orchestrator' | 'domain' | 'training';
  permissions: string[];
  parentAgentId: string | null;
  publicKeyPem: string;
  registeredAt: number;
  status: 'active' | 'revoked';
}

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

interface AgentRecordRow {
  agent_id: string;
  role: 'orchestrator' | 'domain' | 'training';
  permissions: string;
  parent_agent_id: string | null;
  public_key_pem: string;
  registered_at: number;
  status: 'active' | 'revoked';
}

interface CacheEntry {
  record: AgentRecord;
  touchedAt: number;
}

const CACHE_MAX_SIZE = 100;
const CACHE_TTL_MS = 60_000;

export class TrustRegistry {
  readonly db: SqliteDatabase;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(dbPath: string) {
    const Database = require('better-sqlite3') as new (path: string) => SqliteDatabase;
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trust_registry (
        agent_id        TEXT PRIMARY KEY,
        role            TEXT NOT NULL,
        permissions     TEXT NOT NULL,
        parent_agent_id TEXT,
        public_key_pem  TEXT NOT NULL,
        registered_at   INTEGER NOT NULL,
        status          TEXT NOT NULL DEFAULT 'active'
      );
    `);
  }

  async register(record: AgentRecord): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO trust_registry (
        agent_id,
        role,
        permissions,
        parent_agent_id,
        public_key_pem,
        registered_at,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.agentId,
      record.role,
      JSON.stringify(record.permissions),
      record.parentAgentId,
      record.publicKeyPem,
      record.registeredAt,
      record.status,
    );

    this.cache.delete(record.agentId);
    return Promise.resolve();
  }

  async lookup(agentId: string): Promise<AgentRecord | null> {
    const cached = this.getCached(agentId);
    if (cached !== null) {
      return Promise.resolve(cached);
    }

    const row = this.db.prepare(`
      SELECT
        agent_id,
        role,
        permissions,
        parent_agent_id,
        public_key_pem,
        registered_at,
        status
      FROM trust_registry
      WHERE agent_id = ?
    `).get(agentId) as AgentRecordRow | undefined;

    if (row === undefined) {
      return Promise.resolve(null);
    }

    const record = rowToRecord(row);
    this.setCached(record);
    return Promise.resolve(record);
  }

  async revoke(agentId: string): Promise<void> {
    const result = this.db.prepare(`
      UPDATE trust_registry
      SET status = 'revoked'
      WHERE agent_id = ?
    `).run(agentId);

    this.cache.delete(agentId);

    if (result.changes === 0) {
      throw new HiBAError('AGENT_NOT_REGISTERED', `Agent '${agentId}' is not registered`);
    }

    return Promise.resolve();
  }

  async listAll(): Promise<AgentRecord[]> {
    const rows = this.db.prepare(`
      SELECT
        agent_id,
        role,
        permissions,
        parent_agent_id,
        public_key_pem,
        registered_at,
        status
      FROM trust_registry
      ORDER BY registered_at ASC, agent_id ASC
    `).all() as AgentRecordRow[];

    return Promise.resolve(rows.map(rowToRecord));
  }

  private getCached(agentId: string): AgentRecord | null {
    const entry = this.cache.get(agentId);
    if (entry === undefined) {
      return null;
    }

    const now = Date.now();
    if (now - entry.touchedAt > CACHE_TTL_MS) {
      this.cache.delete(agentId);
      return null;
    }

    this.cache.delete(agentId);
    this.cache.set(agentId, {
      record: entry.record,
      touchedAt: now,
    });
    return entry.record;
  }

  private setCached(record: AgentRecord): void {
    this.cache.delete(record.agentId);
    this.cache.set(record.agentId, {
      record,
      touchedAt: Date.now(),
    });

    while (this.cache.size > CACHE_MAX_SIZE) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        return;
      }
      this.cache.delete(oldestKey);
    }
  }
}

function rowToRecord(row: AgentRecordRow): AgentRecord {
  return {
    agentId: row.agent_id,
    role: row.role,
    permissions: JSON.parse(row.permissions) as string[],
    parentAgentId: row.parent_agent_id,
    publicKeyPem: row.public_key_pem,
    registeredAt: row.registered_at,
    status: row.status,
  };
}
