import {
  HIBA_PROTOCOL_VERSION,
  type HiBAErrorCode,
  type ToolFailure,
} from '../types/hiba.types';

export interface ToolFailureOptions {
  durationMs?: number;
  executedAt?: string;
  auditHash?: string;
  details?: Record<string, unknown>;
}

export function createToolFailure(
  errorCode: HiBAErrorCode,
  error: string,
  options: ToolFailureOptions = {},
): ToolFailure {
  return {
    success: false,
    protocolVersion: HIBA_PROTOCOL_VERSION,
    errorCode,
    error,
    retryable: isRetryableErrorCode(errorCode),
    durationMs: options.durationMs ?? 0,
    executedAt: options.executedAt ?? new Date().toISOString(),
    ...(options.auditHash !== undefined ? { auditHash: options.auditHash } : {}),
    ...(options.details !== undefined ? { details: options.details } : {}),
  };
}

export function isRetryableErrorCode(errorCode: HiBAErrorCode): boolean {
  return (
    errorCode === 'TOOL_TIMEOUT' ||
    errorCode === 'AUDIT_ANCHOR_FAILED' ||
    errorCode === 'NODE_OFFLINE' ||
    errorCode === 'SERVICE_UNAVAILABLE'
  );
}

export function isHiBAErrorCode(value: unknown): value is HiBAErrorCode {
  return (
    value === 'SCHEMA_VALIDATION_ERROR' ||
    value === 'TOOL_NOT_FOUND' ||
    value === 'AGENT_NOT_REGISTERED' ||
    value === 'PERMISSION_EXCEEDS_PARENT' ||
    value === 'AUDIT_ANCHOR_FAILED' ||
    value === 'TOOL_TIMEOUT' ||
    value === 'MAX_DEPTH_EXCEEDED' ||
    value === 'HANDLER_EXECUTION_FAILED' ||
    value === 'NODE_OFFLINE' ||
    value === 'VERSION_INCOMPATIBLE' ||
    value === 'INPUT_REQUIRED' ||
    value === 'INPUT_INVALID' ||
    value === 'OUTPUT_INVALID' ||
    value === 'DEPENDENCY_FAILED' ||
    value === 'REQUEST_INVALID' ||
    value === 'RESOURCE_NOT_FOUND' ||
    value === 'SERVICE_UNAVAILABLE' ||
    value === 'CONFLICT' ||
    value === 'INTERNAL_ERROR'
  );
}
