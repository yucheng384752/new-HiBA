import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  RetryPolicy,
  ToolAction,
  ToolDefinition,
  ToolDomain,
  ToolName,
  ToolPermission,
  HiBAErrorCode,
  ToolSpec,
} from '../types/hiba.types';
import { HIBA_PROTOCOL_VERSION } from '../types/hiba.types';

export type RegisteredTool<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> = Omit<ToolDefinition<TInput, TOutput>, 'retryPolicy'> & {
  retryPolicy: RetryPolicy;
  registeredAt: number;
};

const DOMAIN_TAGS: readonly ToolDomain[] = [
  'man',
  'machine',
  'material',
  'method',
  'env',
  'orchestrator',
];

const TOOL_ACTIONS: readonly ToolAction[] = ['read', 'write'];
const DEFAULT_RETRY_ON: HiBAErrorCode[] = ['TOOL_TIMEOUT'];
const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 500,
  backoffMultiplier: 2,
  retryOn: DEFAULT_RETRY_ON,
};

export function defineTool<TInput extends z.ZodType, TOutput extends z.ZodType>(
  definition: ToolDefinition<TInput, TOutput>,
): RegisteredTool<TInput, TOutput> {
  validateToolName(definition.name);
  validateTags(definition.tags);
  validateDefinition(definition);

  return {
    ...definition,
    retryPolicy: normalizeRetryPolicy(definition.retryPolicy),
    registeredAt: Date.now(),
  };
}

function validateDefinition<TInput extends z.ZodType, TOutput extends z.ZodType>(
  definition: ToolDefinition<TInput, TOutput>,
): void {
  const [domain, action] = definition.tags;
  const nameDomain = definition.name.split('.')[0];
  if (nameDomain !== domain) {
    throw new Error(`Invalid tool '${definition.name}': name domain must match tags[0] '${domain}'`);
  }

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(definition.version)) {
    throw new Error(`Invalid tool version '${definition.version}': expected SemVer`);
  }

  const requiredPermission = `${domain}.${action}` as ToolPermission;
  if (!definition.permissions.includes(requiredPermission)) {
    throw new Error(`Invalid tool '${definition.name}': permissions must include '${requiredPermission}'`);
  }
  if (definition.permissions.some(permission => !permission.startsWith(`${domain}.`))) {
    throw new Error(`Invalid tool '${definition.name}': permissions must stay in domain '${domain}'`);
  }

  if (!Number.isInteger(definition.timeout) || definition.timeout <= 0) {
    throw new Error(`Invalid tool '${definition.name}': timeout must be a positive integer`);
  }

  const retry = definition.retryPolicy;
  if (retry && (
    !Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1
    || !Number.isInteger(retry.initialDelayMs) || retry.initialDelayMs < 0
    || !Number.isFinite(retry.backoffMultiplier) || retry.backoffMultiplier < 1
  )) {
    throw new Error(`Invalid tool '${definition.name}': retryPolicy values are out of range`);
  }
}

export function toToolSpec(tool: RegisteredTool): ToolSpec {
  return {
    protocolVersion: HIBA_PROTOCOL_VERSION,
    name: tool.name,
    version: tool.version,
    description: tool.description,
    tags: tool.tags,
    inputSchema: zodToJsonSchema(tool.inputSchema, { $refStrategy: 'none' }),
    outputSchema: zodToJsonSchema(tool.outputSchema, { $refStrategy: 'none' }),
    permissions: tool.permissions,
    timeoutMs: tool.timeout,
    retryPolicy: tool.retryPolicy,
  };
}

function validateToolName(name: ToolName): void {
  const parts = name.split('.');
  if (parts.length !== 2) {
    throw new Error(`Invalid tool name '${name}': expected {domain}.{verbObject}`);
  }

  const [domain, verbObject] = parts;
  if (!isDomainTag(domain)) {
    throw new Error(`Invalid tool name '${name}': domain '${domain}' is not allowed`);
  }

  if (verbObject === undefined || !/^[a-z][A-Za-z0-9]*$/.test(verbObject)) {
    throw new Error(`Invalid tool name '${name}': verbObject must be lower camel case`);
  }
}

function validateTags(tags: readonly unknown[]): void {
  const [domain, action] = tags;

  if (!isDomainTag(domain)) {
    throw new Error(`Invalid tool tags[0]: '${String(domain)}' is not a valid domain tag`);
  }

  if (!isToolAction(action)) {
    throw new Error(`Invalid tool tags[1]: '${String(action)}' is not a valid tool action`);
  }
}

function normalizeRetryPolicy(retryPolicy: RetryPolicy | undefined): RetryPolicy {
  if (retryPolicy === undefined) {
    return {
      ...DEFAULT_RETRY_POLICY,
      retryOn: [...DEFAULT_RETRY_ON],
    };
  }

  return {
    ...retryPolicy,
    retryOn: retryPolicy.retryOn ?? [...DEFAULT_RETRY_ON],
  };
}

function isDomainTag(value: unknown): value is ToolDomain {
  return typeof value === 'string' && DOMAIN_TAGS.includes(value as ToolDomain);
}

function isToolAction(value: unknown): value is ToolAction {
  return typeof value === 'string' && TOOL_ACTIONS.includes(value as ToolAction);
}
