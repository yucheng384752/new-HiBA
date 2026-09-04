/**
 * 場域拓樸檔案的型別定義。
 *
 * 取代原本 TopologyRegistry.ts 的 SQLite 邊資料表設計——真實來源改成
 * accounting-server.mjs 管理的 hiba-core/facilities/<facilityId>.json 檔案，
 * 每個場域一份，描述該場域完整的產線生產過程（站點 + 站點間關係），不是
 * 攤平的點對點邊集合。詳見 hiba-core/facilities/README.md。
 */

export type TopologyRelation = 'upstream_of' | 'downstream_of' | 'backup_for' | 'same_line';
export type TopologyEdgeStatus = 'suggested' | 'approved';
export type TopologyEdgeSource = 'manual' | 'audit_trail_inference';

export interface FacilityStation {
  /** 場域內唯一。 */
  stationId: string;
  name: string;
  /** 綁定 accounting-server 節點登錄的 nodeId；null 表示非自動化/未綁定站點。 */
  nodeId: string | null;
  description: string;
  metadata: Record<string, unknown>;
}

export interface FacilityEdge {
  fromStationId: string;
  relation: TopologyRelation;
  toStationId: string;
  lineId: string | null;
  status: TopologyEdgeStatus;
  source: TopologyEdgeSource;
  metadata: Record<string, unknown>;
  /** ISO 8601——檔案要人可讀/可 diff，不用 epoch ms。 */
  updatedAt: string;
}

export interface FacilityTopologyDocument {
  schemaVersion: 1;
  /** 必須等於檔名（不含副檔名）。 */
  facilityId: string;
  name: string;
  /** 整體產線生產過程敘述（自由文字）。 */
  processDescription: string;
  stations: FacilityStation[];
  edges: FacilityEdge[];
  updatedAt: string;
}

/** GET /api/facilities 回傳的精簡版，供索引/反查用。 */
export interface FacilityIndexEntry {
  facilityId: string;
  name: string;
  stations: Array<{ stationId: string; nodeId: string | null; name: string }>;
}
