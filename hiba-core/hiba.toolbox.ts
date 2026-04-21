/**
 * hiba.toolbox.ts — defineTool() + HiBAToolbox 核心骨架
 *
 * execute() 流程：
 *   1. Tool lookup（TOOL_NOT_FOUND）
 *   2. 深度檢查 ctx.depth ≤ MAX_DEPTH（MAX_DEPTH_EXCEEDED / T1 定理）
 *   3. 權限驗證 ctx.permissions ⊇ def.permissions（PERMISSION_EXCEEDS_PARENT / A2）
 *   4. Schema 驗證 inputSchema.safeParse（SCHEMA_VALIDATION_ERROR / A1）
 *   5. Handler 呼叫（含 timeout 保護）
 *   6. AuditTrail 寫入（A3 公理：成功與失敗皆記錄）
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  ToolFailure,
  AuditRecord,
  AuditWriter,
  HiBAErrorCode,
} from './hiba.types';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_DEPTH = 5;

// ── Internal Registry Type ───────────────────────────────────────────────────
// 型別參數在 registry 層被擦除，改用 unknown 以避免 variance 問題

interface InternalToolDef {
  name: string;
  version: string;
  tags: [string, string, ...string[]];
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  permissions: string[];
  timeout: number;
  handler: (input: unknown, ctx: ToolContext) => Promise<unknown>;
}

// ── Global Tool Registry ──────────────────────────────────────────────────────

const registry = new Map<string, InternalToolDef>();

/**
 * 將 Tool 定義注入全域 ToolRegistry（A1 公理：結構同構強制）。
 * 通常在模組頂層呼叫，與 Express route 定義模式相同。
 */
export function defineTool<TInput extends z.ZodType, TOutput extends z.ZodType>(
  def: ToolDefinition<TInput, TOutput>,
): void {
  if (registry.has(def.name)) {
    throw new Error(`Tool '${def.name}' is already registered`);
  }
  registry.set(def.name, {
    name: def.name,
    version: def.version,
    tags: def.tags,
    description: def.description,
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema,
    permissions: def.permissions,
    timeout: def.timeout,
    handler: def.handler as (input: unknown, ctx: ToolContext) => Promise<unknown>,
  });
}

// ── Audit Hash ────────────────────────────────────────────────────────────────

function computeAuditHash(
  traceId: string,
  toolName: string,
  executedAt: string,
  success: boolean,
): string {
  return createHash('sha256')
    .update(`${traceId}|${toolName}|${executedAt}|${success}`)
    .digest('hex');
}

// ── In-Memory Audit Writer ────────────────────────────────────────────────────

/** 預設的記憶體稽核寫入器，適用於開發與測試 */
export class MemoryAuditWriter implements AuditWriter {
  readonly records: AuditRecord[] = [];

  async write(record: AuditRecord): Promise<void> {
    this.records.push(record);
  }
}

// ── HiBAToolbox ───────────────────────────────────────────────────────────────

export class HiBAToolbox {
  constructor(private readonly auditWriter: AuditWriter = new MemoryAuditWriter()) {}

  /**
   * 執行指定 Tool，完整流程：lookup → depth → permissions → schema → handler → audit。
   * 無論成功或失敗，AuditRecord 均會寫入（A3 公理）。
   */
  async execute<T = unknown>(
    toolName: string,
    rawInput: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult<T>> {
    const executedAt = new Date().toISOString();
    const t0 = Date.now();

    const fail = async (
      errorCode: HiBAErrorCode,
      errorMsg: string,
      def?: InternalToolDef,
    ): Promise<ToolFailure> => {
      const durationMs = Date.now() - t0;
      const auditHash = def
        ? computeAuditHash(ctx.traceId, def.name, executedAt, false)
        : undefined;
      if (def !== undefined) {
        await this.auditWriter.write({
          traceId: ctx.traceId,
          agentId: ctx.agentId,
          depth: ctx.depth,
          toolName: def.name,
          toolDomain: def.tags[0],
          version: def.version,
          success: false,
          durationMs,
          executedAt,
          errorCode,
          errorMsg,
          auditHash: auditHash ?? '',
        });
      }
      return {
        success: false,
        errorCode,
        error: errorMsg,
        ...(auditHash !== undefined ? { auditHash } : {}),
        durationMs,
        executedAt,
      };
    };

    // ── 1. Tool lookup ───────────────────────────────────────────────────────
    const def = registry.get(toolName);
    if (def === undefined) {
      return fail('TOOL_NOT_FOUND', `Tool '${toolName}' not registered`);
    }

    // ── 2. Depth check（T1 定理）────────────────────────────────────────────
    if (ctx.depth > MAX_DEPTH) {
      return fail(
        'MAX_DEPTH_EXCEEDED',
        `Depth ${ctx.depth} exceeds max ${MAX_DEPTH}`,
        def,
      );
    }

    // ── 3. Permissions check（A2 公理）──────────────────────────────────────
    const missing = def.permissions.filter(p => !ctx.permissions.includes(p));
    if (missing.length > 0) {
      return fail(
        'PERMISSION_EXCEEDS_PARENT',
        `Missing permissions: ${missing.join(', ')}`,
        def,
      );
    }

    // ── 4. Schema validation（A1 公理）──────────────────────────────────────
    const parsed = def.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const msg = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return fail('SCHEMA_VALIDATION_ERROR', msg, def);
    }

    // ── 5. Handler execution with timeout ───────────────────────────────────
    let output: T;
    try {
      output = (await withTimeout(
        def.handler(parsed.data, ctx),
        def.timeout,
      )) as T;
    } catch (e) {
      const isTimeout = e instanceof Error && e.message === 'TOOL_TIMEOUT';
      const code: HiBAErrorCode = isTimeout ? 'TOOL_TIMEOUT' : 'SCHEMA_VALIDATION_ERROR';
      return fail(code, e instanceof Error ? e.message : String(e), def);
    }

    // ── 6. AuditTrail write（A3 公理）───────────────────────────────────────
    const durationMs = Date.now() - t0;
    const auditHash = computeAuditHash(ctx.traceId, toolName, executedAt, true);
    await this.auditWriter.write({
      traceId: ctx.traceId,
      agentId: ctx.agentId,
      depth: ctx.depth,
      toolName,
      toolDomain: def.tags[0],
      version: def.version,
      success: true,
      durationMs,
      executedAt,
      auditHash,
    });

    return { success: true, output, auditHash, durationMs, executedAt };
  }
}

// ── Private Helpers ───────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TOOL_TIMEOUT')), ms);
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}
