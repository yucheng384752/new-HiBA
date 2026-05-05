/**
 * hiba.types.ts — HiBA-AB 核心介面契約
 *
 * 此檔案是所有 handler 的介面來源，對應三個公理：
 *   A1 工具同構 — ToolDefinition<TInput, TOutput> 結構固定
 *   A2 權限遞減 — ToolContext.permissions + ToolPermission 類型強制
 *   A3 稽核完整 — AuditRecord 記錄所有執行（成功與失敗）
 */

import { z } from 'zod';

// ── Error Codes ───────────────────────────────────────────────────────────────

export type HiBAErrorCode =
  | 'SCHEMA_VALIDATION_ERROR'   // 輸入不符合 inputSchema 定義
  | 'TOOL_NOT_FOUND'            // Tool 不在 Toolbox 中，或越權呼叫
  | 'AGENT_NOT_REGISTERED'      // TrustRegistry 中找不到 AgentID
  | 'PERMISSION_EXCEEDS_PARENT' // 子 Agent 權限超過父層（A2 違反）
  | 'AUDIT_ANCHOR_FAILED'       // AuditTrail 雜湊驗證失敗（投毒偵測）
  | 'TOOL_TIMEOUT'              // handler 執行超過 timeout 限制
  | 'MAX_DEPTH_EXCEEDED'        // 委派深度超過上限（T1 定理）
  | 'HANDLER_EXECUTION_FAILED'; // handler 拋出非預期例外（非 timeout、非 schema 問題，例如內部邏輯錯誤或外部呼叫失敗）

// ── Tool Domain / Permission Types ───────────────────────────────────────────

export type ToolDomain = 'man' | 'machine' | 'material' | 'method' | 'env' | 'orchestrator';
export type ToolAction = 'read' | 'write';

/** 格式：'{domain}.{action}'，例如 'material.write' */
export type ToolPermission = `${ToolDomain}.${ToolAction}`;

/**
 * 格式：'{domain}.{verbObject}'，verbObject 強制 lowerCamelCase（由 defineTool() 在 runtime 驗證）
 * 型別層面確保 domain 合法，lowerCamelCase 部分由 defineTool() validateToolName 保證
 */
export type ToolName = `${ToolDomain}.${string}`;

// ── ResourceAction ────────────────────────────────────────────────────────────

/**
 * 解析後的權限物件（A2 公理）。
 * ToolPermission 字串（'material.write'）在 permissions 驗證邏輯中
 * 以此結構表示，使比對與推導可型別安全地進行。
 */
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

/**
 * 每次 Tool 執行時注入的執行上下文（A1/A2 公理）。
 * 禁止在 handler 中硬編碼任何 URL 或 ID，
 * 所有外部端點均透過 hibaBaseUrl 組裝。
 */
export interface ToolContext {
  hibaBaseUrl: string;    // 禁止在 handler 中硬編碼 URL
  traceId: string;        // 對應 X-Trace-Id header
  agentId: string;        // 對應 X-Agent-Id header
  depth: number;          // 委派深度，對應 T1 定理
  permissions: string[];  // 執行此 Tool 的 Agent 所持有的權限集合
}

// ── AuditRecord ───────────────────────────────────────────────────────────────

/**
 * 每次 Tool 執行產生的稽核記錄（A3 公理）。
 * auditHash = SHA-256(traceId|toolName|executedAt|success)
 * 可選擇性透過 POST /api/audit/anchor 上鏈。
 */
export interface AuditRecord {
  traceId: string;
  agentId: string;
  depth: number;
  toolName: string;
  toolDomain: string;
  version: string;
  success: boolean;
  durationMs: number;
  executedAt: string;       // ISO 8601
  errorCode?: HiBAErrorCode;
  errorMsg?: string;
  auditHash: string;        // SHA-256(traceId|toolName|executedAt|success)
}

// ── NodeCapability ────────────────────────────────────────────────────────────

/**
 * Sub-Web 節點能力描述。
 * 對應 GET /api/nodes/capabilities?nodeId={nodeId} 回傳格式，
 * 由 ResourceDecisionService 使用於工具路由決策。
 */
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

/**
 * defineTool() 的參數介面（A1 公理：Tool 同構）。
 * TInput / TOutput 為 Zod schema 型別，由 TypeScript 推導。
 * 所有 Tool 必須符合此結構，保證 ToolRegistry 同構性。
 */
export interface ToolDefinition<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  name: ToolName;                            // '{domain}.{verbObject}' lower camel case
  version: string;                           // semver
  tags: [ToolDomain, ToolAction, ...string[]]; // [domain, read|write, ...]
  description: string;
  inputSchema: TInput;
  outputSchema: TOutput;
  permissions: ToolPermission[];
  timeout: number;                           // ms
  retryPolicy?: RetryPolicy;
  handler: (input: z.infer<TInput>, ctx: ToolContext) => Promise<z.infer<TOutput>>;
}

// ── Execution Plan ────────────────────────────────────────────────────────────

/**
 * NLPlanningService.plan() 的輸出。
 * steps 為有序執行步驟（可含 dependsOn DAG）；
 * supervisorPolicy 控制任一步驟失敗時的後續行為。
 */
export interface ExecutionPlan {
  steps: PlanStep[];
  supervisorPolicy: 'fail-fast' | 'partial-success';
  error?: string;   // 規劃失敗時填入，steps 為空陣列
}

// ── Audit Writer ──────────────────────────────────────────────────────────────

/** 稽核寫入介面，可替換為 SQLite / PostgreSQL / Blockchain 實作 */
export interface AuditWriter {
  write(record: AuditRecord): Promise<void>;
}
