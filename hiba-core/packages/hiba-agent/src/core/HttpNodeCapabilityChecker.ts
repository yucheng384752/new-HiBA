import type {
  NodeCapability,
  ToolContext,
} from '../types/hiba.types';

export interface NodeCapabilityChecker {
  canInstall(nodeId: string, ctx: ToolContext): Promise<boolean>;
  isStale(
    nodeId: string,
    toolName: string,
    version: string,
    ctx: ToolContext,
  ): Promise<boolean>;
  clearCache(): void;
}

export class HttpNodeCapabilityChecker implements NodeCapabilityChecker {
  private readonly cache = new Map<string, NodeCapability>();

  async canInstall(nodeId: string, ctx: ToolContext): Promise<boolean> {
    const cap = await this.fetchCapability(nodeId, ctx);
    if (cap === null) {
      return false;
    }

    return cap.canInstall;
  }

  async isStale(
    nodeId: string,
    toolName: string,
    version: string,
    ctx: ToolContext,
  ): Promise<boolean> {
    const cap = await this.fetchCapability(nodeId, ctx);
    if (cap === null) {
      return false;
    }

    const tool = cap.tools.find(candidate => candidate.name === toolName);
    if (tool === undefined) {
      return false;
    }

    return tool.version !== version;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private async fetchCapability(
    nodeId: string,
    ctx: ToolContext,
  ): Promise<NodeCapability | null> {
    const cached = this.cache.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const url = new URL('/api/nodes/capabilities', ctx.hibaBaseUrl);
      url.searchParams.set('nodeId', nodeId);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-Trace-Id': ctx.traceId,
          'X-Agent-Id': ctx.agentId,
          'X-Depth': String(ctx.depth),
        },
      });

      if (!response.ok) {
        return null;
      }

      const capability = await response.json() as NodeCapability;
      this.cache.set(nodeId, capability);
      return capability;
    } catch {
      return null;
    }
  }
}
