import type { NodeDescriptor } from '../types/hiba.types';
import type { AccountingClient, NodeResourceMap, ResourceItem } from './NLPlanningService';

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
}
