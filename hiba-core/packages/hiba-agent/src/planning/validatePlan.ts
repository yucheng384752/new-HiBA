import type { ZodIssue } from 'zod';
import type { RegisteredTool } from '../core/defineTool';
import type {
  ExecutionPlan,
  MissingPlanInput,
  NodeDescriptor,
  PlanStep,
  PlanValidationIssue,
  PlanValidationResult,
} from '../types/hiba.types';

export interface PlanValidationContext {
  tools: RegisteredTool[];
  nodes: NodeDescriptor[];
}

export function validatePlan(
  plan: ExecutionPlan,
  { tools, nodes }: PlanValidationContext,
): PlanValidationResult {
  const issues: PlanValidationIssue[] = [];
  const missingInputs: MissingPlanInput[] = [];
  const toolMap = new Map(tools.map(tool => [tool.name, tool]));
  const stepIds = new Set(plan.steps.map(step => step.stepId));

  for (const step of plan.steps) {
    validateDependencies(step, stepIds, issues);

    const tool = toolMap.get(step.toolName);
    if (!tool) {
      issues.push({ stepId: step.stepId, code: 'TOOL_NOT_FOUND', message: `Tool '${step.toolName}' is not registered` });
      continue;
    }
    if (tool.version !== step.version) {
      issues.push({
        stepId: step.stepId,
        code: 'VERSION_INCOMPATIBLE',
        message: `Tool '${step.toolName}' requires version '${tool.version}', received '${step.version}'`,
      });
    }

    const schemaIssues = tool.inputSchema.safeParse(step.input);
    if (!schemaIssues.success) {
      const relevant = schemaIssues.error.issues.filter(issue => !isReferenceAtPath(step.input, issue.path));
      const missing = relevant.filter(isMissingIssue).map(issue => issue.path.join('.'));
      if (missing.length > 0) {
        missingInputs.push({ stepId: step.stepId, toolName: step.toolName, fields: missing });
      }
      for (const issue of relevant) {
        issues.push({
          stepId: step.stepId,
          code: isMissingIssue(issue) ? 'INPUT_REQUIRED' : 'INPUT_INVALID',
          field: issue.path.join('.') || undefined,
          message: issue.message,
        });
      }
    }

    if (step.nodeId !== 'local' && !hasExecutableNode(step, nodes)) {
      issues.push({
        stepId: step.stepId,
        code: 'AGENT_NOT_REGISTERED',
        message: `No online node can execute '${step.toolName}@${step.version}'`,
      });
    }
  }

  if (hasCycle(plan.steps)) {
    issues.push({ code: 'DEPENDENCY_FAILED', message: 'Execution plan contains a dependency cycle' });
  }

  return issues.length === 0
    ? { valid: true, plan }
    : { valid: false, issues, missingInputs };
}

function validateDependencies(
  step: PlanStep,
  stepIds: Set<string>,
  issues: PlanValidationIssue[],
): void {
  for (const dependency of step.dependsOn) {
    if (!stepIds.has(dependency)) {
      issues.push({
        stepId: step.stepId,
        code: 'DEPENDENCY_FAILED',
        message: `Unknown dependency '${dependency}'`,
      });
    }
  }
}

function hasExecutableNode(step: PlanStep, nodes: NodeDescriptor[]): boolean {
  return nodes.some(node => {
    if (node.status !== 'online') return false;
    return node.canInstall || node.resources.some(resource =>
      resource.name === step.toolName && resource.version === step.version,
    );
  });
}

function isMissingIssue(issue: ZodIssue): boolean {
  return issue.code === 'invalid_type' && issue.received === 'undefined';
}

function isReferenceAtPath(input: unknown, path: Array<string | number>): boolean {
  let value = input;
  for (const part of path) {
    if (value === null || typeof value !== 'object') return false;
    value = (value as Record<string | number, unknown>)[part];
  }
  return typeof value === 'string' && /^\$steps\.[^.]+\.output(?:\..+)?$/.test(value);
}

function hasCycle(steps: PlanStep[]): boolean {
  const inDegree = new Map(steps.map(step => [step.stepId, 0]));
  const dependents = new Map(steps.map(step => [step.stepId, [] as string[]]));
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!inDegree.has(dependency)) continue;
      inDegree.set(step.stepId, (inDegree.get(step.stepId) ?? 0) + 1);
      dependents.get(dependency)?.push(step.stepId);
    }
  }
  const queue = [...inDegree].filter(([, degree]) => degree === 0).map(([stepId]) => stepId);
  let visited = 0;
  while (queue.length > 0) {
    const stepId = queue.shift()!;
    visited += 1;
    for (const dependent of dependents.get(stepId) ?? []) {
      const degree = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, degree);
      if (degree === 0) queue.push(dependent);
    }
  }
  return visited !== steps.length;
}
