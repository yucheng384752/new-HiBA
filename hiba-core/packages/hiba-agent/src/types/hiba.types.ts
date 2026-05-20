import { z } from 'zod';

// ── Error Codes ───────────────────────────────────────────────────────────────

export type HiBAErrorCode =
  | 'SCHEMA_VALIDATION_ERROR'
  | 'TOOL_NOT_FOUND'
  | 'AGENT_NOT_REGISTERED'
  | 'PERMISSION_EXCEEDS_PARENT'
  | 'AUDIT_ANCHOR_FAILED'
  | 'TOOL_TIMEOUT'
  | 'MAX_DEPTH_EXCEEDED'
  | 'HANDLER_EXECUTION_FAILED';

// ── Tool Domain / Permission Types ───────────────────────────────────────────

export type ToolDomain = 'man' | 'machine' | 'material' | 'method' | 'env' | 'orchestrator';
export type ToolAction = 'read' | 'write';

export type ToolPermission = `${ToolDomain}.${ToolAction}`;
export type ToolName = `${ToolDomain}.${string}`;

// ── ResourceAction ────────────────────────────────────────────────────────────

export interface ResourceAction {
  domain: ToolDomain;
  action: ToolAction;
}

export type DecisionAction = 'install' | 'update' | 'execute' | 'dispatch';

export interface PlanStep {
  stepId: string;
  toolName: ToolName;
  nodeId: string;
  version: string;
  input: Record<string, unknown>;
  dependsOn: string[];
}

export interface HiBAToolbox {
  has(toolName: ToolName): boolean;
}

// ── ToolContext ───────────────────────────────────────────────────────────────

export interface ToolContext {
  hibaBaseUrl: string;
  traceId: string;
  agentId: string;
  depth: number;
  permissions: string[];
}

// ── AuditRecord ───────────────────────────────────────────────────────────────

export interface AuditRecord {
  traceId: string;
  agentId: string;
  depth: number;
  toolName: string;
  toolDomain: string;
  version: string;
  success: boolean;
  durationMs: number;
  executedAt: string;
  errorCode?: HiBAErrorCode;
  errorMsg?: string;
  auditHash: string;
}

// ── NodeCapability ────────────────────────────────────────────────────────────

export interface NodeCapability {
  nodeId: string;
  tools: Array<{ name: string; version: string }>;
  canInstall: boolean;
}

// ── Tool Result ───────────────────────────────────────────────────────────────

export interface ToolSuccess<T = unknown> {
  success: true;
  output: T;
  auditHash: string;
  durationMs: number;
  executedAt: string;
}

export interface ToolFailure {
  success: false;
  errorCode: HiBAErrorCode;
  error: string;
  auditHash?: string;
  durationMs: number;
  executedAt: string;
}

export type ToolResult<T = unknown> = ToolSuccess<T> | ToolFailure;

// ── Retry Policy ──────────────────────────────────────────────────────────────

export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  retryOn: HiBAErrorCode[];
}

// ── Tool Definition ───────────────────────────────────────────────────────────

export interface ToolDefinition<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  name: ToolName;
  version: string;
  tags: [ToolDomain, ToolAction, ...string[]];
  description: string;
  inputSchema: TInput;
  outputSchema: TOutput;
  permissions: ToolPermission[];
  timeout: number;
  retryPolicy?: RetryPolicy;
  handler: (input: z.infer<TInput>, ctx: ToolContext) => Promise<z.infer<TOutput>>;
}

// ── Execution Plan ────────────────────────────────────────────────────────────

export interface ExecutionPlan {
  steps: PlanStep[];
  supervisorPolicy: 'fail-fast' | 'partial-success';
  error?: string;
}

// ── Audit Writer ──────────────────────────────────────────────────────────────

export interface AuditWriter {
  write(record: AuditRecord): Promise<void>;
}

// ── Node Resource ─────────────────────────────────────────────────────────────

export interface ResourceItem {
  name: string;
  version: string;
  type: string;
}

export type NodeResourceMap = Record<string, ResourceItem[]>;
