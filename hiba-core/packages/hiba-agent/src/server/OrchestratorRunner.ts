import type { ExecutionPlan, PlanStep, ToolContext, ToolResult, ToolName } from '../types/hiba.types';
import type { HiBAToolbox } from '../core/HiBAToolbox';
import type { AuditTrail } from '../audit/AuditTrail';

// ── Public types ──────────────────────────────────────────────────────────────

export interface StepResult {
  stepId: string;
  toolName: ToolName;
  nodeId: string;
  dispatched: 'local' | 'remote';
  result: ToolResult;
}

export interface RunResult {
  runId: string;
  traceId: string;
  policy: 'fail-fast' | 'partial-success';
  steps: StepResult[];
  succeeded: number;
  failed: number;
  skipped: number;
  anchored: boolean;
  completedAt: string;
  error?: string;
}

export interface OrchestratorOptions {
  /** Static nodeId → AgentServer URL map. Takes precedence over dynamic discovery. */
  nodeAddresses?: Map<string, string>;
  /** Timeout for each remote /api/execute call (ms). Default: 30_000 */
  dispatchTimeoutMs?: number;
  /**
   * Accounting server base URL for dynamic node address lookup.
   * When set, calls GET /api/nodes once per run() to discover nodes not in nodeAddresses.
   * e.g. 'http://localhost:9090'
   */
  accountingUrl?: string;
}

// ── OrchestratorRunner ────────────────────────────────────────────────────────

export class OrchestratorRunner {
  private readonly nodeAddresses: Map<string, string>;
  private readonly dispatchTimeoutMs: number;
  private readonly accountingUrl: string | undefined;
  /** Cache: nodeUrl → Map<toolName, scriptName> for Pi-compat nodes */
  private readonly piManifestCache = new Map<string, Map<string, string>>();

  constructor(
    private readonly toolbox: HiBAToolbox,
    private readonly audit: AuditTrail,
    options: OrchestratorOptions = {},
  ) {
    this.nodeAddresses     = options.nodeAddresses    ?? new Map();
    this.dispatchTimeoutMs = options.dispatchTimeoutMs ?? 30_000;
    this.accountingUrl     = options.accountingUrl;
  }

  async run(plan: ExecutionPlan, baseCtx: ToolContext): Promise<RunResult> {
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const policy = plan.supervisorPolicy;

    if (plan.error) {
      return mkResult(runId, baseCtx, policy, [], 0, false, plan.error);
    }
    if (plan.steps.length === 0) {
      return mkResult(runId, baseCtx, policy, [], 0, false);
    }

    const { layers, cyclic } = buildLayers(plan.steps);
    if (cyclic.length > 0) {
      return mkResult(
        runId, baseCtx, policy, [], 0, false,
        `Cycle detected in steps: ${cyclic.join(', ')}`,
      );
    }

    // Resolve node addresses: static overrides dynamic
    const addresses = await this.buildAddressMap(plan.steps);

    const stepResults: StepResult[] = [];
    const failedIds = new Set<string>();
    let skipped = 0;
    let aborted = false;

    for (const layer of layers) {
      if (aborted) { skipped += layer.length; continue; }

      // Skip steps whose dependencies failed
      const [runnable, blocked] = partition(
        layer,
        step => !step.dependsOn.some(dep => failedIds.has(dep)),
      );
      skipped += blocked.length;
      if (runnable.length === 0) continue;

      // Execute current layer in parallel
      const layerResults = await Promise.all(
        runnable.map(async step => {
          const stepCtx: ToolContext = { ...baseCtx, depth: baseCtx.depth + 1 };
          const { result, dispatched } = await this.dispatchStep(step, stepCtx, addresses);
          return { step, result, dispatched } as
            { step: PlanStep; result: ToolResult; dispatched: 'local' | 'remote' };
        }),
      );

      for (const { step, result, dispatched } of layerResults) {
        stepResults.push({
          stepId:     step.stepId,
          toolName:   step.toolName,
          nodeId:     step.nodeId,
          dispatched,
          result,
        });
        if (!result.success) {
          failedIds.add(step.stepId);
          if (policy === 'fail-fast') aborted = true;
        }
      }
    }

    // Upload audit records to chain (non-fatal)
    let anchored = false;
    try {
      await this.audit.batchUploadToChain([baseCtx.traceId], baseCtx);
      anchored = true;
    } catch {
      // anchor failure is non-fatal for the run result
    }

    return mkResult(runId, baseCtx, policy, stepResults, skipped, anchored);
  }

  // ── Dispatch ────────────────────────────────────────────────────────────────

  private async buildAddressMap(steps: PlanStep[]): Promise<Map<string, string>> {
    const addresses = new Map(this.nodeAddresses);
    if (!this.accountingUrl) return addresses;

    // Only fetch if there are nodeIds not already covered by static map
    const unknown = [...new Set(steps.map(s => s.nodeId))].filter(id => !addresses.has(id));
    if (unknown.length === 0) return addresses;

    try {
      const res = await fetch(`${this.accountingUrl}/api/nodes`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const nodes = await res.json() as Array<{ nodeId: string; agentUrl: string | null }>;
        for (const { nodeId, agentUrl } of nodes) {
          if (agentUrl && !addresses.has(nodeId)) {
            addresses.set(nodeId, agentUrl);
          }
        }
      }
    } catch {
      // non-fatal: fall back to static addresses only
    }

    return addresses;
  }

  private async dispatchStep(
    step: PlanStep,
    ctx: ToolContext,
    addresses: Map<string, string>,
  ): Promise<{ result: ToolResult; dispatched: 'local' | 'remote' }> {
    const agentUrl = addresses.get(step.nodeId);
    if (agentUrl) {
      return { result: await this.remoteDispatch(agentUrl, step, ctx), dispatched: 'remote' };
    }
    return {
      result: await this.toolbox.execute(step.toolName as never, step.input, ctx),
      dispatched: 'local',
    };
  }

  private async remoteDispatch(
    agentUrl: string,
    step: PlanStep,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    const commonHeaders = {
      'Content-Type': 'application/json',
      'X-Agent-Id':   ctx.agentId,
      'X-Trace-Id':   ctx.traceId,
      'X-Depth':      String(ctx.depth),
    };
    try {
      const res = await fetch(`${agentUrl}/api/execute`, {
        method:  'POST',
        headers: commonHeaders,
        body:    JSON.stringify({ toolName: step.toolName, input: step.input }),
        signal:  AbortSignal.timeout(this.dispatchTimeoutMs),
      });

      // Pi sub-web nodes expose /execute (not /api/execute) — auto-fallback
      if (res.status === 404) {
        const text = await res.text();
        if (text.includes('Cannot POST')) {
          return this.piCompatDispatch(agentUrl, step, ctx, commonHeaders, startedAt);
        }
      }

      const executedAt = new Date().toISOString();
      const durationMs = Date.now() - startedAt;

      if (!res.ok) {
        return {
          success:   false,
          errorCode: 'HANDLER_EXECUTION_FAILED',
          error:     `Remote node '${step.nodeId}' returned HTTP ${res.status}`,
          durationMs,
          executedAt,
        };
      }

      const body = await res.json() as unknown;
      if (typeof body !== 'object' || body === null || typeof (body as ToolResult).success !== 'boolean') {
        return {
          success:   false,
          errorCode: 'HANDLER_EXECUTION_FAILED',
          error:     `Remote node '${step.nodeId}' returned unexpected response shape`,
          durationMs,
          executedAt,
        };
      }
      return body as ToolResult;
    } catch (err) {
      return {
        success:   false,
        errorCode: 'HANDLER_EXECUTION_FAILED',
        error:     `Dispatch to '${step.nodeId}' (${agentUrl}) failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs:  Date.now() - startedAt,
        executedAt:  new Date().toISOString(),
      };
    }
  }

  /**
   * Fallback for Pi sub-web nodes that expose POST /execute (scriptName+params)
   * instead of POST /api/execute (toolName+input).
   * Fetches /scripts once per node URL to build toolName→scriptName mapping.
   */
  private async piCompatDispatch(
    agentUrl: string,
    step: PlanStep,
    ctx: ToolContext,
    headers: Record<string, string>,
    startedAt: number,
  ): Promise<ToolResult> {
    const executedAt = new Date().toISOString();

    // Resolve toolName → scriptName (cached per node)
    let toolMap = this.piManifestCache.get(agentUrl);
    if (!toolMap) {
      const mRes = await fetch(`${agentUrl}/scripts`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!mRes.ok) {
        return {
          success: false, errorCode: 'HANDLER_EXECUTION_FAILED',
          error:   `Pi /scripts fetch failed: HTTP ${mRes.status}`,
          durationMs: Date.now() - startedAt, executedAt,
        };
      }
      const manifest = await mRes.json() as { scripts: Array<{ name: string; toolName: string }> };
      toolMap = new Map(manifest.scripts.map(s => [s.toolName, s.name]));
      this.piManifestCache.set(agentUrl, toolMap);
    }

    const scriptName = toolMap.get(step.toolName);
    if (!scriptName) {
      return {
        success: false, errorCode: 'TOOL_NOT_FOUND',
        error:   `Pi node has no script registered for toolName '${step.toolName}'`,
        durationMs: Date.now() - startedAt, executedAt,
      };
    }

    const res = await fetch(`${agentUrl}/execute`, {
      method:  'POST',
      headers,
      body:    JSON.stringify({ scriptName, params: step.input }),
      signal:  AbortSignal.timeout(this.dispatchTimeoutMs),
    });

    const durationMs = Date.now() - startedAt;
    if (!res.ok) {
      return {
        success: false, errorCode: 'HANDLER_EXECUTION_FAILED',
        error:   `Pi /execute returned HTTP ${res.status} for '${step.toolName}'`,
        durationMs, executedAt: new Date().toISOString(),
      };
    }

    const body = await res.json() as unknown;
    if (typeof body !== 'object' || body === null || typeof (body as ToolResult).success !== 'boolean') {
      return {
        success: false, errorCode: 'HANDLER_EXECUTION_FAILED',
        error:   `Pi /execute returned unexpected response shape for '${step.toolName}'`,
        durationMs, executedAt: new Date().toISOString(),
      };
    }
    return body as ToolResult;
  }
}

// ── Topological sort — Kahn's algorithm → execution layers ───────────────────

function buildLayers(steps: PlanStep[]): { layers: PlanStep[][]; cyclic: string[] } {
  const ids = new Set(steps.map(s => s.stepId));
  const inDegree = new Map<string, number>(steps.map(s => [s.stepId, 0]));
  const dependents = new Map<string, string[]>(steps.map(s => [s.stepId, []]));

  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) continue;  // unknown dep → ignore
      inDegree.set(step.stepId, (inDegree.get(step.stepId) ?? 0) + 1);
      dependents.get(dep)!.push(step.stepId);
    }
  }

  const stepMap = new Map(steps.map(s => [s.stepId, s]));
  const layers: PlanStep[][] = [];
  const visited = new Set<string>();
  let queue = steps.filter(s => (inDegree.get(s.stepId) ?? 0) === 0);

  while (queue.length > 0) {
    layers.push(queue);
    const next: PlanStep[] = [];
    for (const step of queue) {
      visited.add(step.stepId);
      for (const depId of dependents.get(step.stepId) ?? []) {
        const deg = (inDegree.get(depId) ?? 1) - 1;
        inDegree.set(depId, deg);
        if (deg === 0) {
          const s = stepMap.get(depId);
          if (s) next.push(s);
        }
      }
    }
    queue = next;
  }

  const cyclic = steps.filter(s => !visited.has(s.stepId)).map(s => s.stepId);
  return { layers, cyclic };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function partition<T>(arr: T[], pred: (x: T) => boolean): [T[], T[]] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const x of arr) (pred(x) ? yes : no).push(x);
  return [yes, no];
}

function mkResult(
  runId: string,
  ctx: ToolContext,
  policy: 'fail-fast' | 'partial-success',
  steps: StepResult[],
  skipped: number,
  anchored: boolean,
  error?: string,
): RunResult {
  return {
    runId,
    traceId:     ctx.traceId,
    policy,
    steps,
    succeeded:   steps.filter(s =>  s.result.success).length,
    failed:      steps.filter(s => !s.result.success).length,
    skipped,
    anchored,
    completedAt: new Date().toISOString(),
    ...(error !== undefined ? { error } : {}),
  };
}

/** Parse a NODE_ADDRESSES env string into a Map.
 *  Format: "nodeId=url,nodeId=url"  e.g. "node-2=http://10.0.0.2:8090,node-3=http://..."
 */
export function parseNodeAddresses(env: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of env.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const nodeId = pair.slice(0, eq).trim();
    const url    = pair.slice(eq + 1).trim();
    if (nodeId && url) map.set(nodeId, url);
  }
  return map;
}
