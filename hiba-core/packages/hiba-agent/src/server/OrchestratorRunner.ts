import { HIBA_PROTOCOL_VERSION } from '../types/hiba.types';
import type { ExecutionPlan, NodeDescriptor, PlanStep, ToolContext, ToolResult, ToolName } from '../types/hiba.types';
import type { HiBAToolbox } from '../core/HiBAToolbox';
import type { AuditTrail } from '../audit/AuditTrail';
import { createToolFailure, isHiBAErrorCode } from '../core/errors';

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
  /** Extra attempts on the same node before failover. Default: 1 */
  reconnectAttempts?: number;
  /** Delay between reconnect attempts (ms). Default: 1_000 */
  reconnectDelayMs?: number;
  /**
   * Accounting server base URL for dynamic node address lookup.
   * When set, calls GET /api/nodes once per run() to discover nodes not in nodeAddresses.
   * e.g. 'http://localhost:9090'
   */
  accountingUrl?: string;
}

export interface RunHooks {
  runId?: string;
  completedSteps?: StepResult[];
  onStepStart?: (step: PlanStep) => void;
  onStepComplete?: (step: StepResult) => void;
  onStepSkipped?: (step: PlanStep) => void;
}

// ── OrchestratorRunner ────────────────────────────────────────────────────────

export class OrchestratorRunner {
  private readonly nodeAddresses: Map<string, string>;
  private readonly dispatchTimeoutMs: number;
  private readonly reconnectAttempts: number;
  private readonly reconnectDelayMs: number;
  private readonly accountingUrl: string | undefined;
  /** Cache: nodeUrl → Map<toolName, scriptName> for Pi-compat nodes */
  private readonly piManifestCache = new Map<string, Map<string, string>>();

  constructor(
    private readonly toolbox: HiBAToolbox,
    private readonly audit: AuditTrail,
    options: OrchestratorOptions = {},
  ) {
    this.nodeAddresses     = options.nodeAddresses    ?? new Map();
    this.dispatchTimeoutMs = safeInteger(options.dispatchTimeoutMs, 30_000, 1);
    this.reconnectAttempts = safeInteger(options.reconnectAttempts, 1);
    this.reconnectDelayMs  = safeInteger(options.reconnectDelayMs, 1_000);
    this.accountingUrl     = options.accountingUrl;
  }

  async run(plan: ExecutionPlan, baseCtx: ToolContext, hooks: RunHooks = {}): Promise<RunResult> {
    const runId = hooks.runId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    const { addresses, nodes } = await this.buildNodeDirectory(plan.steps);

    const stepResults: StepResult[] = [...(hooks.completedSteps ?? [])];
    const completedIds = new Set(stepResults.filter(s => s.result.success).map(s => s.stepId));
    const outputs = new Map(stepResults.filter(s => s.result.success).map(s => [s.stepId, (s.result as { output: unknown }).output]));
    const failedIds = new Set<string>();
    let skipped = 0;
    let aborted = false;

    for (const layer of layers) {
      const pendingLayer = layer.filter(step => !completedIds.has(step.stepId));
      if (aborted) {
        skipped += pendingLayer.length;
        pendingLayer.forEach(step => hooks.onStepSkipped?.(step));
        continue;
      }

      // Skip steps whose dependencies failed
      const [runnable, blocked] = partition(
        pendingLayer,
        step => !step.dependsOn.some(dep => failedIds.has(dep)),
      );
      skipped += blocked.length;
      blocked.forEach(step => hooks.onStepSkipped?.(step));
      if (runnable.length === 0) continue;

      // Execute current layer in parallel
      const layerResults = await Promise.all(
        runnable.map(async step => {
          const stepCtx: ToolContext = { ...baseCtx, depth: baseCtx.depth + 1 };
          hooks.onStepStart?.(step);
          let executable = step;
          let result: ToolResult;
          let dispatched: 'local' | 'remote';
          let nodeId = step.nodeId;
          try {
            executable = { ...step, input: resolveStepReferences(step.input, outputs) as Record<string, unknown> };
            ({ result, dispatched, nodeId } = await this.dispatchStep(executable, stepCtx, addresses, nodes));
          } catch (error) {
            result = failure('SCHEMA_VALIDATION_ERROR', error instanceof Error ? error.message : String(error));
            dispatched = step.nodeId === 'local' ? 'local' : 'remote';
          }
          return { step: executable, result, dispatched, nodeId } as
            { step: PlanStep; result: ToolResult; dispatched: 'local' | 'remote'; nodeId: string };
        }),
      );

      for (const { step, result, dispatched, nodeId } of layerResults) {
        const stepResult: StepResult = {
          stepId:     step.stepId,
          toolName:   step.toolName,
          nodeId,
          dispatched,
          result,
        };
        stepResults.push(stepResult);
        hooks.onStepComplete?.(stepResult);
        if (dispatched === 'remote') {
          try {
            await this.audit.recordEvent({
              eventType: 'DATA_TRANSFERRED',
              traceId: baseCtx.traceId,
              actorId: baseCtx.agentId,
              subjectId: runId,
              payload: { toolName: step.toolName, input: step.input },
              metadata: { stepId: step.stepId, nodeId, toolName: step.toolName },
              success: result.success,
            });
          } catch (error) {
            console.error('[OrchestratorRunner] failed to persist DATA_TRANSFERRED event:', error);
          }
        }
        if (result.success) outputs.set(step.stepId, result.output);
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

  private async buildNodeDirectory(steps: PlanStep[]): Promise<{ addresses: Map<string, string>; nodes: NodeDescriptor[] }> {
    const addresses = new Map(this.nodeAddresses);
    if (!this.accountingUrl) return { addresses, nodes: [] };

    // Always fetch: ensureNodeTool() needs canInstall/tool availability for discovered nodes
    let nodes: NodeDescriptor[] = [];

    try {
      const res = await fetch(`${this.accountingUrl}/api/nodes`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        nodes = await res.json() as NodeDescriptor[];
        for (const { nodeId, agentUrl } of nodes) {
          if (agentUrl && !addresses.has(nodeId)) {
            addresses.set(nodeId, agentUrl);
          }
        }
      }
    } catch {
      // non-fatal: fall back to static addresses only
    }

    return { addresses, nodes };
  }

  private async dispatchStep(
    step: PlanStep,
    ctx: ToolContext,
    addresses: Map<string, string>,
    nodes: NodeDescriptor[],
  ): Promise<{ result: ToolResult; dispatched: 'local' | 'remote'; nodeId: string }> {
    if (step.nodeId === 'local') {
      return { result: await this.toolbox.execute(step.toolName as never, step.input, ctx), dispatched: 'local', nodeId: 'local' };
    }

    const attempted = new Set<string>();
    let target = await this.ensureNodeTool(step, addresses, nodes, attempted);
    let lastResult: ToolResult | undefined;
    let lastNodeId = step.nodeId;

    while (target) {
      const targetStep = { ...step, nodeId: target.nodeId };
      lastNodeId = target.nodeId;
      for (let attempt = 0; attempt <= this.reconnectAttempts; attempt++) {
        const result = await this.remoteDispatch(target.agentUrl, targetStep, ctx);
        if (result.success || !result.retryable) {
          return { result, dispatched: 'remote', nodeId: target.nodeId };
        }
        lastResult = result;
        if (attempt < this.reconnectAttempts && this.reconnectDelayMs > 0) {
          await delay(this.reconnectDelayMs);
        }
      }
      attempted.add(target.nodeId);
      target = await this.ensureNodeTool(step, addresses, nodes, attempted);
    }

    return {
      result: lastResult ?? failure('AGENT_NOT_REGISTERED', `No online node can execute '${step.toolName}@${step.version}'`),
      dispatched: 'remote',
      nodeId: lastNodeId,
    };
  }

  private async ensureNodeTool(
    step: PlanStep,
    addresses: Map<string, string>,
    nodes: NodeDescriptor[],
    excluded: Set<string>,
  ): Promise<{ nodeId: string; agentUrl: string } | null> {
    const assignedUrl = addresses.get(step.nodeId);
    if (assignedUrl && !excluded.has(step.nodeId)) return { nodeId: step.nodeId, agentUrl: assignedUrl };

    const online = nodes
      .filter(node => node.agentUrl && node.status !== 'offline' && !excluded.has(node.nodeId))
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    const hasTool = (node: NodeDescriptor) => node.resources.some(
      tool => tool.name === step.toolName && (tool.version ?? '1.0.0') === step.version,
    );
    const assigned = online.find(node => node.nodeId === step.nodeId);
    const exact = assigned && hasTool(assigned) ? assigned : online.find(hasTool);
    if (exact?.agentUrl) return { nodeId: exact.nodeId, agentUrl: exact.agentUrl };

    const installable = assigned?.canInstall ? assigned : online.find(node => node.canInstall);
    if (!installable?.agentUrl || !this.accountingUrl) return null;
    try {
      const res = await fetch(`${this.accountingUrl}/api/nodes/${encodeURIComponent(installable.nodeId)}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolName: step.toolName, version: step.version }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      const verify = await fetch(`${installable.agentUrl}/scripts`, { signal: AbortSignal.timeout(5_000) });
      if (!verify.ok) return null;
      const manifest = await verify.json() as { scripts?: Array<{ name: string; version?: string }> };
      const installed = manifest.scripts?.some(
        tool => tool.name === step.toolName && (tool.version ?? '1.0.0') === step.version,
      );
      if (!installed) return null;
      this.piManifestCache.delete(installable.agentUrl);
      return { nodeId: installable.nodeId, agentUrl: installable.agentUrl };
    } catch {
      return null;
    }
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
      'X-Step-Id':    step.stepId,
      'X-Idempotency-Key': `${ctx.traceId}:${step.stepId}`,
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
        const unavailable = res.status === 502 || res.status === 503 || res.status === 504;
        const responseText = (await res.text().catch(() => '')).slice(0, 2_000);
        let remoteResponse: unknown = responseText;
        try { remoteResponse = JSON.parse(responseText); } catch { /* keep text */ }
        const remote = remoteResponse && typeof remoteResponse === 'object'
          ? remoteResponse as Record<string, unknown>
          : {};
        const remoteError = typeof remote['stderr'] === 'string'
          ? remote['stderr']
          : typeof remote['error'] === 'string' ? remote['error'] : responseText;
        return createToolFailure(
          unavailable ? 'SERVICE_UNAVAILABLE' : 'HANDLER_EXECUTION_FAILED',
          `Remote node '${step.nodeId}' returned HTTP ${res.status}${remoteError ? `: ${remoteError}` : ''}`,
          { durationMs, executedAt, details: { httpStatus: res.status, nodeId: step.nodeId, remoteResponse } },
        );
      }

      const body = await res.json() as unknown;
      return this.validateRemoteResult(body, step, durationMs, executedAt);
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return createToolFailure(
        timedOut ? 'TOOL_TIMEOUT' : 'NODE_OFFLINE',
        `Dispatch to '${step.nodeId}' (${agentUrl}) failed: ${err instanceof Error ? err.message : String(err)}`,
        { durationMs: Date.now() - startedAt, details: { nodeId: step.nodeId, agentUrl } },
      );
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
        return createToolFailure(
          'HANDLER_EXECUTION_FAILED',
          `Pi /scripts fetch failed: HTTP ${mRes.status}`,
          { durationMs: Date.now() - startedAt, executedAt, details: { httpStatus: mRes.status } },
        );
      }
      const manifest = await mRes.json() as { scripts: Array<{ name: string; scriptName: string }> };
      toolMap = new Map(manifest.scripts.map(s => [s.name, s.scriptName]));
      this.piManifestCache.set(agentUrl, toolMap);
    }

    const scriptName = toolMap.get(step.toolName);
    if (!scriptName) {
      return createToolFailure(
        'TOOL_NOT_FOUND',
        `Pi node has no script registered for toolName '${step.toolName}'`,
        { durationMs: Date.now() - startedAt, executedAt },
      );
    }

    const res = await fetch(`${agentUrl}/execute`, {
      method:  'POST',
      headers,
      body:    JSON.stringify({ scriptName, params: step.input }),
      signal:  AbortSignal.timeout(this.dispatchTimeoutMs),
    });

    const durationMs = Date.now() - startedAt;
    if (!res.ok) {
      return createToolFailure(
        'HANDLER_EXECUTION_FAILED',
        `Pi /execute returned HTTP ${res.status} for '${step.toolName}'`,
        { durationMs, details: { httpStatus: res.status, nodeId: step.nodeId } },
      );
    }

    const body = await res.json() as unknown;
    return this.validateRemoteResult(body, step, durationMs, new Date().toISOString());
  }

  private validateRemoteResult(
    body: unknown,
    step: PlanStep,
    durationMs: number,
    executedAt: string,
  ): ToolResult {
    if (typeof body !== 'object' || body === null || typeof (body as { success?: unknown }).success !== 'boolean') {
      return createToolFailure(
        'HANDLER_EXECUTION_FAILED',
        `Remote node '${step.nodeId}' returned unexpected response shape`,
        { durationMs, executedAt, details: { nodeId: step.nodeId } },
      );
    }

    const result = body as Record<string, unknown>;
    if (result['success'] === false) {
      const errorCode = isHiBAErrorCode(result['errorCode']) ? result['errorCode'] : 'HANDLER_EXECUTION_FAILED';
      const error = typeof result['error'] === 'string' ? result['error'] : `Remote tool '${step.toolName}' failed`;
      return createToolFailure(errorCode, error, {
        durationMs,
        executedAt,
        details: { nodeId: step.nodeId, remoteErrorCode: result['errorCode'] ?? null },
      });
    }

    const tool = this.toolbox.getToolRegistry().get(step.toolName);
    if (!tool) {
      return createToolFailure('TOOL_NOT_FOUND', `Tool '${step.toolName}' is not registered locally for output validation`, {
        durationMs,
        executedAt,
      });
    }
    const output = tool.outputSchema.safeParse(result['output']);
    if (!output.success) {
      return createToolFailure('OUTPUT_INVALID', output.error.issues.map(issue =>
        `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ).join('; '), { durationMs, executedAt, details: { nodeId: step.nodeId } });
    }

    return {
      success: true,
      protocolVersion: HIBA_PROTOCOL_VERSION,
      output: output.data,
      auditHash: typeof result['auditHash'] === 'string' ? result['auditHash'] : '',
      durationMs,
      executedAt,
    };
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeInteger(value: number | undefined, fallback: number, minimum = 0): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback;
}

function resolveStepReferences(value: unknown, outputs: Map<string, unknown>): unknown {
  if (typeof value === 'string') {
    const match = /^\$steps\.([^.]+)\.output(?:\.(.+))?$/.exec(value);
    if (!match) return value;
    const stepId = match[1]!;
    if (!outputs.has(stepId)) throw new Error(`Step output '${stepId}' is not available`);
    let resolved = outputs.get(stepId);
    for (const part of match[2]?.split('.') ?? []) {
      if (resolved === null || typeof resolved !== 'object' || !(part in resolved)) {
        throw new Error(`Step output reference '${value}' does not exist`);
      }
      resolved = (resolved as Record<string, unknown>)[part];
    }
    return resolved;
  }
  if (Array.isArray(value)) return value.map(item => resolveStepReferences(item, outputs));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveStepReferences(item, outputs)]));
  }
  return value;
}

function failure(errorCode: 'SCHEMA_VALIDATION_ERROR' | 'AGENT_NOT_REGISTERED', error: string): ToolResult {
  return createToolFailure(errorCode, error);
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
