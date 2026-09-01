import type { NodeDescriptor } from '../types/hiba.types';
import type { AccountingClient, NodeResourceMap, ResourceItem } from './NLPlanningService';
import type {
  FacilityEdge,
  FacilityIndexEntry,
  FacilityTopologyDocument,
  TopologyEdgeStatus,
  TopologyRelation,
} from '../topology/FacilityTopology.types';

export interface HttpAccountingClientOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/**
 * Calls the independent Accounting Server (HiBA resource registry).
 *
 * Expected API contract:
 *   GET /api/resources              → NodeResourceMap  (全節點資源清單)
 *   GET /api/resources/:nodeId      → ResourceItem[]   (單節點資源清單)
 */
export class HttpAccountingClient implements AccountingClient {
  constructor(
    private readonly baseUrl: string,
    private readonly options: HttpAccountingClientOptions = {},
  ) {}

  async listNodeResources(): Promise<NodeResourceMap> {
    const res = await fetch(`${this.baseUrl}/api/resources`, {
      headers: this.options.headers,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 8_000),
    });
    if (!res.ok) throw new Error(`Accounting server ${this.baseUrl} → HTTP ${res.status}`);
    return res.json() as Promise<NodeResourceMap>;
  }

  async getNodeResources(nodeId: string): Promise<ResourceItem[]> {
    const res = await fetch(
      `${this.baseUrl}/api/resources/${encodeURIComponent(nodeId)}`,
      {
        headers: this.options.headers,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 8_000),
      },
    );
    if (!res.ok) throw new Error(`Accounting server ${this.baseUrl} → HTTP ${res.status}`);
    return res.json() as Promise<ResourceItem[]>;
  }

  async listNodes(): Promise<NodeDescriptor[]> {
    const res = await fetch(`${this.baseUrl}/api/nodes`, {
      headers: this.options.headers,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 8_000),
    });
    if (!res.ok) throw new Error(`Accounting server ${this.baseUrl} → HTTP ${res.status}`);
    return res.json() as Promise<NodeDescriptor[]>;
  }

  async listFacilitiesForNodes(nodeIds: string[]): Promise<FacilityIndexEntry[]> {
    const qs = nodeIds.length > 0 ? `?nodeIds=${encodeURIComponent(nodeIds.join(','))}` : '';
    const res = await fetch(`${this.baseUrl}/api/facilities${qs}`, {
      headers: this.options.headers,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 8_000),
    });
    if (!res.ok) throw new Error(`Accounting server ${this.baseUrl} → HTTP ${res.status}`);
    return res.json() as Promise<FacilityIndexEntry[]>;
  }

  async getFacility(facilityId: string, opts?: { status?: TopologyEdgeStatus }): Promise<FacilityTopologyDocument> {
    const qs = opts?.status ? `?status=${encodeURIComponent(opts.status)}` : '';
    const res = await fetch(
      `${this.baseUrl}/api/facilities/${encodeURIComponent(facilityId)}${qs}`,
      {
        headers: this.options.headers,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 8_000),
      },
    );
    if (!res.ok) throw new Error(`Accounting server ${this.baseUrl} → HTTP ${res.status}`);
    return res.json() as Promise<FacilityTopologyDocument>;
  }

  async suggestFacilityEdge(facilityId: string, input: {
    fromStationId: string;
    relation: TopologyRelation;
    toStationId: string;
    lineId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<FacilityEdge> {
    const res = await fetch(
      `${this.baseUrl}/api/facilities/${encodeURIComponent(facilityId)}/edges/suggest`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.options.headers },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 8_000),
      },
    );
    if (!res.ok) throw new Error(`Accounting server ${this.baseUrl} → HTTP ${res.status}`);
    return res.json() as Promise<FacilityEdge>;
  }
}
