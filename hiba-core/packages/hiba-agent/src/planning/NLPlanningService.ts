import { z } from 'zod';
import type { RegisteredTool } from '../core/defineTool';
import { toToolSpec } from '../core/defineTool';
import { HIBA_PROTOCOL_VERSION } from '../types/hiba.types';
import type {
  ExecutionPlan,
  NodeDescriptor,
  NodeResourceMap,
  PlanStep,
  ResourceItem,
  ToolContext,
  ToolSpec,
} from '../types/hiba.types';
import { validatePlan } from './validatePlan';

export type { NodeResourceMap, ResourceItem } from '../types/hiba.types';

// ── Pluggable Interfaces ───────────────────────────────────────────────────────
// Both interfaces are minimal — swap any implementation without touching the service.

export interface LLMPayload {
  task: string;
  resources: NodeResourceMap;
  nodes: NodeDescriptor[];
  tools: ToolSpec[];
  /** Override to inject a custom system prompt at call time */
  systemPrompt?: string;
}

export interface LLMClient {
  complete(payload: LLMPayload): Promise<{ rawJson: unknown }>;
}

export interface AccountingClient {
  listNodeResources(): Promise<NodeResourceMap>;
  getNodeResources(nodeId: string): Promise<ResourceItem[]>;
  listNodes(): Promise<NodeDescriptor[]>;
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
  protocolVersion:  z.literal(HIBA_PROTOCOL_VERSION).default(HIBA_PROTOCOL_VERSION),
  steps:            z.array(planStepSchema),
  supervisorPolicy: z.enum(['fail-fast', 'partial-success']).default('fail-fast'),
  error:            z.string().optional(),
}).superRefine((plan, ctx) => {
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.stepId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate stepId '${step.stepId}'` });
    }
    ids.add(step.stepId);
  }
  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown dependency '${dependency}' in '${step.stepId}'` });
      }
    }
  }
});

// ── NLPlanningService ─────────────────────────────────────────────────────────

export interface NLPlanningOptions {
  /** Fallback supervisorPolicy when LLM omits it */
  supervisorPolicy?: 'fail-fast' | 'partial-success';
  /** If provided, tool names are included in LLM context */
  toolbox?: { list(): RegisteredTool[] };
}

export class NLPlanningService {
  constructor(
    private readonly llm: LLMClient,
    private readonly accounting: AccountingClient,
    private readonly options: NLPlanningOptions = {},
  ) {}

  async plan(task: string, _ctx: ToolContext): Promise<ExecutionPlan> {
    const [resources, nodes] = await Promise.all([
      this.accounting.listNodeResources(),
      this.accounting.listNodes(),
    ]);
    const registeredTools = this.options.toolbox?.list() ?? [];
    const tools = registeredTools.map(toToolSpec);
    const isPlannerVisible = (resource: ResourceItem) => resource.metadata?.['plannerVisible'] !== false;
    const planningResources = Object.fromEntries(
      Object.entries(resources).map(([nodeId, items]) => [nodeId, items.filter(isPlannerVisible)]),
    );
    const planningNodes = nodes.map(node => ({
      ...node,
      resources: node.resources.filter(isPlannerVisible),
    }));

    const { rawJson } = await this.llm.complete({ task, resources: planningResources, nodes: planningNodes, tools });
    let plan = this.parsePlan(rawJson);
    if (this.options.toolbox && !plan.error) {
      const toolMap = new Map(registeredTools.map(tool => [tool.name, tool]));
      plan = {
        ...plan,
        steps: plan.steps.map(step => {
          const parsed = toolMap.get(step.toolName)?.inputSchema.safeParse(step.input);
          return parsed?.success ? { ...step, input: parsed.data } : step;
        }),
      };
      if (/(接續|依序|然後|再由|\bafter\b|\bthen\b)/i.test(task)
          && plan.steps.length > 1
          && plan.steps.every(step => step.dependsOn.length === 0)) {
        plan = {
          ...plan,
          steps: plan.steps.map((step, index) => index === 0
            ? step
            : { ...step, dependsOn: [plan.steps[index - 1]!.stepId] }),
        };
      }
    }
    if (plan.error || !this.options.toolbox) return plan;

    const validation = validatePlan(plan, { tools: registeredTools, nodes });
    if (validation.valid) return validation.plan;
    const canAskUser = validation.issues.every(issue => issue.code === 'INPUT_REQUIRED' || issue.code === 'INPUT_INVALID');
    if (canAskUser) {
      return {
        ...plan,
        validationIssues: validation.issues,
        missingInputs: validation.missingInputs,
      };
    }
    return {
      ...plan,
      steps: [],
      error: `Plan validation failed: ${validation.issues.map(issue => issue.message).join('; ')}`,
      validationIssues: validation.issues,
      missingInputs: validation.missingInputs,
    };
  }

  /** Expose resource map for AgentServer /api/resources proxy */
  async getResources(): Promise<NodeResourceMap> {
    return this.accounting.listNodeResources();
  }

  async getNodes(): Promise<NodeDescriptor[]> {
    return this.accounting.listNodes();
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
