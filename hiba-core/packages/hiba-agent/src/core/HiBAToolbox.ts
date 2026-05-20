import { createHash } from 'node:crypto';
import { ZodError } from 'zod';
import type {
  AuditRecord,
  AuditWriter,
  HiBAErrorCode,
  ToolContext,
  ToolFailure,
  ToolName,
  ToolResult,
} from '../types/hiba.types';
import type { RegisteredTool } from './defineTool';

export interface HiBAToolboxOptions {
  auditWriter: AuditWriter;
  maxDepth?: number;
  permissions?: readonly string[];
}

export class HiBAToolbox {
  protected tools = new Map<ToolName, RegisteredTool>();
  protected readonly auditWriter: AuditWriter;
  protected readonly maxDepth: number;
  private readonly toolboxPermissions: readonly string[];

  constructor(options: HiBAToolboxOptions) {
    this.auditWriter = options.auditWriter;
    this.maxDepth = options.maxDepth ?? 5;
    this.toolboxPermissions = options.permissions ?? [];
  }

  get permissions(): readonly string[] {
    return this.toolboxPermissions;
  }

  getAuditWriter(): AuditWriter {
    return this.auditWriter;
  }

  getMaxDepth(): number {
    return this.maxDepth;
  }

  getToolRegistry(): Map<ToolName, RegisteredTool> {
    return this.tools;
  }

  register(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  has(toolName: ToolName): boolean {
    return this.tools.has(toolName);
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  async execute<TOutput = unknown>(
    toolName: ToolName,
    rawInput: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult<TOutput>> {
    const startedAt = Date.now();

    const tool = this.tools.get(toolName);
    if (tool === undefined) {
      return this.fail(
        'TOOL_NOT_FOUND',
        `Tool '${toolName}' is not registered`,
        toolName,
        undefined,
        ctx,
        startedAt,
      );
    }

    let input: unknown;
    try {
      input = tool.inputSchema.parse(rawInput);
    } catch (error) {
      return this.fail(
        'SCHEMA_VALIDATION_ERROR',
        formatSchemaError(error),
        toolName,
        tool,
        ctx,
        startedAt,
      );
    }

    const missingPermissions = tool.permissions.filter(permission => !ctx.permissions.includes(permission));
    if (missingPermissions.length > 0) {
      return this.fail(
        'PERMISSION_EXCEEDS_PARENT',
        `Missing permissions: ${missingPermissions.join(', ')}`,
        toolName,
        tool,
        ctx,
        startedAt,
      );
    }

    if (ctx.depth > this.maxDepth) {
      return this.fail(
        'MAX_DEPTH_EXCEEDED',
        `Depth ${ctx.depth} exceeds max depth ${this.maxDepth}`,
        toolName,
        tool,
        ctx,
        startedAt,
      );
    }

    try {
      const output = await this.executeWithRetry(tool, input, ctx);
      const executedAt = new Date().toISOString();
      const durationMs = Date.now() - startedAt;
      const auditHash = computeAuditHash(ctx.traceId, toolName, executedAt, true);

      await this.auditWriter.write({
        traceId: ctx.traceId,
        agentId: ctx.agentId,
        depth: ctx.depth,
        toolName,
        toolDomain: tool.tags[0],
        version: tool.version,
        success: true,
        durationMs,
        executedAt,
        auditHash,
      });

      return {
        success: true,
        output: output as TOutput,
        auditHash,
        durationMs,
        executedAt,
      };
    } catch (error) {
      return this.fail(
        getErrorCode(error),
        getErrorMessage(error),
        toolName,
        tool,
        ctx,
        startedAt,
      );
    }
  }

  private async executeWithRetry(
    tool: RegisteredTool,
    input: unknown,
    ctx: ToolContext,
  ): Promise<unknown> {
    const retryPolicy = tool.retryPolicy;
    const maxAttempts = retryPolicy?.maxAttempts ?? 1;
    let attempt = 0;
    let delayMs = retryPolicy?.initialDelayMs ?? 0;

    while (attempt < maxAttempts) {
      attempt += 1;

      try {
        return await withTimeout(
          tool.handler(input as never, ctx),
          tool.timeout,
        );
      } catch (error) {
        const shouldRetry =
          attempt < maxAttempts &&
          retryPolicy !== undefined &&
          retryPolicy.retryOn.includes('TOOL_TIMEOUT') &&
          getErrorCode(error) === 'TOOL_TIMEOUT';

        if (!shouldRetry) {
          throw error;
        }

        if (delayMs > 0) {
          await sleep(delayMs);
        }
        delayMs *= retryPolicy.backoffMultiplier;
      }
    }

    throw createToolError('TOOL_TIMEOUT', 'Tool execution timed out');
  }

  private async fail(
    errorCode: HiBAErrorCode,
    error: string,
    toolName: ToolName,
    tool: RegisteredTool | undefined,
    ctx: ToolContext,
    startedAt: number,
  ): Promise<ToolFailure> {
    const executedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAt;
    const auditHash = computeAuditHash(ctx.traceId, toolName, executedAt, false);

    await this.auditWriter.write({
      traceId: ctx.traceId,
      agentId: ctx.agentId,
      depth: ctx.depth,
      toolName,
      toolDomain: tool?.tags[0] ?? getDomainFromToolName(toolName),
      version: tool?.version ?? '',
      success: false,
      durationMs,
      executedAt,
      errorCode,
      errorMsg: error,
      auditHash,
    });

    return {
      success: false,
      errorCode,
      error,
      auditHash,
      durationMs,
      executedAt,
    };
  }
}

function computeAuditHash(
  traceId: string,
  toolName: string,
  executedAt: string,
  success: boolean,
): string {
  return createHash('sha256')
    .update(`${traceId}|${toolName}|${executedAt}|${String(success)}`)
    .digest('hex');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(createToolError('TOOL_TIMEOUT', 'Tool execution timed out'));
    }, timeoutMs);

    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createToolError(errorCode: HiBAErrorCode, message: string): Error & { errorCode: HiBAErrorCode } {
  const error = new Error(message) as Error & { errorCode: HiBAErrorCode };
  error.errorCode = errorCode;
  return error;
}

function getErrorCode(error: unknown): HiBAErrorCode {
  if (hasErrorCode(error)) {
    return error.errorCode;
  }

  return 'HANDLER_EXECUTION_FAILED';
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function formatSchemaError(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
  }

  return getErrorMessage(error);
}

function hasErrorCode(error: unknown): error is { errorCode: HiBAErrorCode } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'errorCode' in error &&
    isHiBAErrorCode((error as { errorCode: unknown }).errorCode)
  );
}

function isHiBAErrorCode(value: unknown): value is HiBAErrorCode {
  return (
    value === 'SCHEMA_VALIDATION_ERROR' ||
    value === 'TOOL_NOT_FOUND' ||
    value === 'AGENT_NOT_REGISTERED' ||
    value === 'PERMISSION_EXCEEDS_PARENT' ||
    value === 'AUDIT_ANCHOR_FAILED' ||
    value === 'TOOL_TIMEOUT' ||
    value === 'MAX_DEPTH_EXCEEDED' ||
    value === 'HANDLER_EXECUTION_FAILED'
  );
}

function getDomainFromToolName(toolName: ToolName): string {
  return toolName.split('.')[0] ?? '';
}
