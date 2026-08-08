import { z } from 'zod';

export const HIBA_PROTOCOL_VERSION = '1.0' as const;
export type HiBAProtocolVersion = typeof HIBA_PROTOCOL_VERSION;
export type JsonSchema = Record<string, unknown>;

// ── Error Codes ───────────────────────────────────────────────────────────────

export type HiBAErrorCode =
  | 'SCHEMA_VALIDATION_ERROR'
  | 'TOOL_NOT_FOUND'
  | 'AGENT_NOT_REGISTERED'
  | 'PERMISSION_EXCEEDS_PARENT'
  | 'AUDIT_ANCHOR_FAILED'
  | 'TOOL_TIMEOUT'
  | 'MAX_DEPTH_EXCEEDED'
  | 'HANDLER_EXECUTION_FAILED'
  | 'NODE_OFFLINE'
  | 'VERSION_INCOMPATIBLE'
  | 'INPUT_REQUIRED'
  | 'INPUT_INVALID'
  | 'OUTPUT_INVALID'
  | 'DEPENDENCY_FAILED'
  | 'REQUEST_INVALID'
  | 'RESOURCE_NOT_FOUND'
  | 'SERVICE_UNAVAILABLE'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

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
  protocolVersion: HiBAProtocolVersion;
  nodeId: string;
  status: 'online' | 'offline';
  lastSeenAt: string | null;
  tools: Array<{ name: string; version: string }>;
  canInstall: boolean;
}

export interface ResourceItem {
  name: string;
  version: string;
  type: string;
  path?: string;
  metadata?: Record<string, unknown>;
}

export type NodeResourceMap = Record<string, ResourceItem[]>;

export interface NodeDescriptor {
  protocolVersion: HiBAProtocolVersion;
  nodeId: string;
  agentUrl: string | null;
  status: 'online' | 'offline';
  canInstall: boolean;
  resources: ResourceItem[];
  registeredAt: string | null;
  lastSeenAt: string | null;
}

// ── Tool Result ───────────────────────────────────────────────────────────────

export interface ToolSuccess<T = unknown> {
  success: true;
  protocolVersion: HiBAProtocolVersion;
  output: T;
  auditHash: string;
  durationMs: number;
  executedAt: string;
}

export interface ToolFailure {
  success: false;
  protocolVersion: HiBAProtocolVersion;
  errorCode: HiBAErrorCode;
  error: string;
  retryable: boolean;
  details?: Record<string, unknown>;
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

export interface ToolSpec {
  protocolVersion: HiBAProtocolVersion;
  name: ToolName;
  version: string;
  description: string;
  tags: [ToolDomain, ToolAction, ...string[]];
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  permissions: ToolPermission[];
  timeoutMs: number;
  retryPolicy?: RetryPolicy;
}

// ── Execution Plan ────────────────────────────────────────────────────────────

export interface ExecutionPlan {
  protocolVersion?: HiBAProtocolVersion;
  steps: PlanStep[];
  supervisorPolicy: 'fail-fast' | 'partial-success';
  error?: string;
  validationIssues?: PlanValidationIssue[];
  missingInputs?: MissingPlanInput[];
}

export interface PlanValidationIssue {
  stepId?: string;
  code: HiBAErrorCode;
  field?: string;
  message: string;
}

export interface MissingPlanInput {
  stepId: string;
  toolName: ToolName;
  fields: string[];
}

export type PlanValidationResult =
  | { valid: true; plan: ExecutionPlan }
  | { valid: false; issues: PlanValidationIssue[]; missingInputs: MissingPlanInput[] };

// ── Audit Writer ──────────────────────────────────────────────────────────────

export interface AuditWriter {
  write(record: AuditRecord): Promise<void>;
}
