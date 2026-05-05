import { z } from 'zod';
import type { ExecutionPlan, PlanStep, ToolContext, ToolName } from '../types/hiba.types';

// ── Pluggable Interfaces ───────────────────────────────────────────────────────
// Both interfaces are minimal — swap any implementation without touching the service.

export interface LLMPayload {
  task: string;
  resources: NodeResourceMap;
  availableTools: string[];
  /** Override to inject a custom system prompt at call time */
  systemPrompt?: string;
}

export interface LLMClient {
  complete(payload: LLMPayload): Promise<{ rawJson: unknown }>;
}

export interface ResourceItem {
  name: string;
  type: string;          // 'script' | 'model' | 'dataset' | ...
  version?: string;
  path?: string;
  metadata?: Record<string, unknown>;
}

/** nodeId → list of resources on that node */
export type NodeResourceMap = Record<string, ResourceItem[]>;

export interface AccountingClient {
  listNodeResources(): Promise<NodeResourceMap>;
  getNodeResources(nodeId: string): Promise<ResourceItem[]>;
}

// ── Zod Runtime Validation ────────────────────────────────────────────────────

const planStepSchema = z.object({
  stepId:    z.string().min(1),
  toolName:  z.string().min(3),   // ToolName validated at execution time by defineTool()
  nodeId:    z.string().min(1),
  version:   z.string().default('1.0.0'),
  input:     z.record(z.unknown()),
  dependsOn: z.array(z.string()).default([]),
});

const executionPlanSchema = z.object({
  steps:            z.array(planStepSchema),
  supervisorPolicy: z.enum(['fail-fast', 'partial-success']).default('fail-fast'),
  error:            z.string().optional(),
});

// ── NLPlanningService ─────────────────────────────────────────────────────────

export interface NLPlanningOptions {
  /** Fallback supervisorPolicy when LLM omits it */
  supervisorPolicy?: 'fail-fast' | 'partial-success';
  /** If provided, tool names are included in LLM context */
  toolbox?: { list(): Array<{ name: string }> };
}

export class NLPlanningService {
  constructor(
    private readonly llm: LLMClient,
    private readonly accounting: AccountingClient,
    private readonly options: NLPlanningOptions = {},
  ) {}

  async plan(task: string, _ctx: ToolContext): Promise<ExecutionPlan> {
    const resources = await this.accounting.listNodeResources();
    const availableTools = this.options.toolbox
      ? this.options.toolbox.list().map(t => t.name)
      : [];

    const { rawJson } = await this.llm.complete({ task, resources, availableTools });
    return this.parsePlan(rawJson);
  }

  /** Expose resource map for AgentServer /api/resources proxy */
  async getResources(): Promise<NodeResourceMap> {
    return this.accounting.listNodeResources();
  }

  private parsePlan(raw: unknown): ExecutionPlan {
    const result = executionPlanSchema.safeParse(raw);
    if (result.success) {
      return {
        ...result.data,
        steps: result.data.steps as unknown as PlanStep[],
        supervisorPolicy: result.data.supervisorPolicy,
      } satisfies ExecutionPlan;
    }
    return {
      steps: [],
      supervisorPolicy: this.options.supervisorPolicy ?? 'fail-fast',
      error: `Plan parse failed: ${result.error.message}`,
    };
  }
}
