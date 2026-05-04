import { z } from 'zod';
import type {
  RetryPolicy,
  ToolAction,
  ToolDefinition,
  ToolDomain,
  ToolName,
  HiBAErrorCode,
} from '../../../../hiba.types';

export type RegisteredTool<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> = ToolDefinition<TInput, TOutput> & {
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

  return {
    ...definition,
    retryPolicy: normalizeRetryPolicy(definition.retryPolicy),
    registeredAt: Date.now(),
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
