import { HiBAError } from '../core/ScopedToolbox';

/**
 * 產線拓樸邊（物理/作業順序拓樸——上下游、站點流程），跟 74d8381 節點註冊 relay
 * 的網路拓樸（parentNodeId）是不同概念，不要混用。
 * 規格：實作規格/plan()_LLM生成品質改善與輕量RAG檢索設計.md §四
 */
export type TopologyRelation = 'upstream_of' | 'downstream_of' | 'backup_for' | 'same_line';
export type TopologyEdgeStatus = 'suggested' | 'approved';
export type TopologyEdgeSource = 'manual' | 'audit_trail_inference';

export interface TopologyEdge {
  fromNodeId: string;
  relation: TopologyRelation;
  toNodeId: string;
  lineId: string | null;
  status: TopologyEdgeStatus;
  source: TopologyEdgeSource;
  metadata: Record<string, unknown>;
  updatedAt: number;
}

export interface TopologyEdgeInput {
  fromNodeId: string;
  relation: TopologyRelation;
  toNodeId: string;
  lineId?: string;
  metadata?: Record<string, unknown>;
}

const VALID_RELATIONS: readonly TopologyRelation[] = [
  'upstream_of', 'downstream_of', 'backup_for', 'same_line',
];

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

interface TopologyEdgeRow {
  from_node_id: string;
  relation: TopologyRelation;
  to_node_id: string;
  line_id: string | null;
  status: TopologyEdgeStatus;
  source: TopologyEdgeSource;
  metadata: string | null;
  updated_at: number;
}

export class TopologyRegistry {
  readonly db: SqliteDatabase;

  constructor(dbPath: string) {
    const Database = require('better-sqlite3') as new (path: string) => SqliteDatabase;
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topology_edges (
        from_node_id  TEXT NOT NULL,
        relation      TEXT NOT NULL,
        to_node_id    TEXT NOT NULL,
        line_id       TEXT,
        status        TEXT NOT NULL DEFAULT 'suggested',
        source        TEXT NOT NULL,
        metadata      TEXT,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (from_node_id, relation, to_node_id)
      );
    `);
  }

  /**
   * 人工維護：Dashboard 直接新增/編輯，立即生效（status='approved'）。
   * 解決冷啟動問題——新產線上線當下就能有拓樸資料，不用等歷史執行量累積。
   */
  upsertManual(input: TopologyEdgeInput): TopologyEdge {
    return this.upsert(input, 'manual', 'approved');
  }

  /**
   * AuditTrail 自動偵測寫入候選邊，預設 status='suggested'，不自動生效。
   * 已核准的邊不會被新的推論訊號降級回 suggested。
   */
  suggest(input: TopologyEdgeInput): TopologyEdge {
    const existing = this.find(input.fromNodeId, input.relation, input.toNodeId);
    const status: TopologyEdgeStatus = existing?.status === 'approved' ? 'approved' : 'suggested';
    return this.upsert(input, 'audit_trail_inference', status);
  }

  /** 把 suggested 的邊人工核准成 approved；邊不存在時拋錯，已是 approved 時為 no-op。 */
  approve(fromNodeId: string, relation: string, toNodeId: string): TopologyEdge {
    const existing = this.find(fromNodeId, relation, toNodeId);
    if (existing === null) {
      throw new HiBAError(
        'RESOURCE_NOT_FOUND',
        `Topology edge '${fromNodeId} --${relation}--> ${toNodeId}' not found`,
      );
    }
    if (existing.status === 'approved') {
      return existing;
    }

    const updatedAt = Date.now();
    this.db.prepare(`
      UPDATE topology_edges SET status = 'approved', updated_at = ?
      WHERE from_node_id = ? AND relation = ? AND to_node_id = ?
    `).run(updatedAt, fromNodeId, relation, toNodeId);
    return { ...existing, status: 'approved', updatedAt };
  }

  find(fromNodeId: string, relation: string, toNodeId: string): TopologyEdge | null {
    const row = this.db.prepare(`
      SELECT * FROM topology_edges WHERE from_node_id = ? AND relation = ? AND to_node_id = ?
    `).get(fromNodeId, relation, toNodeId) as TopologyEdgeRow | undefined;
    return row === undefined ? null : rowToEdge(row);
  }

  list(filter: { status?: TopologyEdgeStatus; lineId?: string } = {}): TopologyEdge[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.status !== undefined) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.lineId !== undefined) {
      clauses.push('line_id = ?');
      params.push(filter.lineId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT * FROM topology_edges ${where} ORDER BY updated_at DESC
    `).all(...params) as TopologyEdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * plan() / orchestrator.retrieveContext 只讀 approved 的邊——suggested 的邊
   * 只出現在 Dashboard 待審核清單，不會未經人工確認就影響 LLM 看到的 prompt。
   */
  listApproved(lineId?: string): TopologyEdge[] {
    return this.list(lineId !== undefined ? { status: 'approved', lineId } : { status: 'approved' });
  }

  private upsert(
    input: TopologyEdgeInput,
    source: TopologyEdgeSource,
    status: TopologyEdgeStatus,
  ): TopologyEdge {
    if (!VALID_RELATIONS.includes(input.relation)) {
      throw new HiBAError('REQUEST_INVALID', `Invalid topology relation '${input.relation}'`);
    }
    if (!input.fromNodeId.trim() || !input.toNodeId.trim()) {
      throw new HiBAError('REQUEST_INVALID', 'fromNodeId and toNodeId are required');
    }

    const updatedAt = Date.now();
    const lineId = input.lineId ?? null;
    const metadata = input.metadata ?? {};
    this.db.prepare(`
      INSERT INTO topology_edges (from_node_id, relation, to_node_id, line_id, status, source, metadata, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (from_node_id, relation, to_node_id)
      DO UPDATE SET line_id = excluded.line_id, status = excluded.status, source = excluded.source,
                    metadata = excluded.metadata, updated_at = excluded.updated_at
    `).run(
      input.fromNodeId, input.relation, input.toNodeId,
      lineId, status, source, JSON.stringify(metadata), updatedAt,
    );

    return {
      fromNodeId: input.fromNodeId,
      relation: input.relation,
      toNodeId: input.toNodeId,
      lineId,
      status,
      source,
      metadata,
      updatedAt,
    };
  }
}

function rowToEdge(row: TopologyEdgeRow): TopologyEdge {
  return {
    fromNodeId: row.from_node_id,
    relation: row.relation,
    toNodeId: row.to_node_id,
    lineId: row.line_id,
    status: row.status,
    source: row.source,
    metadata: row.metadata !== null ? JSON.parse(row.metadata) as Record<string, unknown> : {},
    updatedAt: row.updated_at,
  };
}
