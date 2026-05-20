import { describe, expect, it, jest, afterEach } from '@jest/globals';
import { z } from 'zod';
import { defineTool } from './defineTool';
import type { ToolDefinition, ToolName } from '../types/hiba.types';

const inputSchema = z.object({
  filePath: z.string(),
});

const outputSchema = z.object({
  ok: z.boolean(),
});

function createDefinition(
  overrides: Partial<ToolDefinition<typeof inputSchema, typeof outputSchema>> = {},
): ToolDefinition<typeof inputSchema, typeof outputSchema> {
  return {
    name: 'material.protectFile',
    version: '1.0.0',
    tags: ['material', 'write'],
    description: 'Protect file metadata',
    inputSchema,
    outputSchema,
    permissions: ['material.write'],
    timeout: 5_000,
    handler: async () => ({ ok: true }),
    ...overrides,
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('defineTool', () => {
  it('returns a RegisteredTool with registeredAt and default retryPolicy', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    const tool = defineTool(createDefinition());

    expect(tool.name).toBe('material.protectFile');
    expect(tool.version).toBe('1.0.0');
    expect(tool.tags).toEqual(['material', 'write']);
    expect(tool.permissions).toEqual(['material.write']);
    expect(tool.registeredAt).toBe(1_700_000_000_000);
    expect(tool.retryPolicy).toEqual({
      maxAttempts: 3,
      initialDelayMs: 500,
      backoffMultiplier: 2,
      retryOn: ['TOOL_TIMEOUT'],
    });
  });

  it('preserves provided retryPolicy values', () => {
    const tool = defineTool(createDefinition({
      retryPolicy: {
        maxAttempts: 5,
        initialDelayMs: 100,
        backoffMultiplier: 3,
        retryOn: ['TOOL_TIMEOUT', 'AUDIT_ANCHOR_FAILED'],
      },
    }));

    expect(tool.retryPolicy).toEqual({
      maxAttempts: 5,
      initialDelayMs: 100,
      backoffMultiplier: 3,
      retryOn: ['TOOL_TIMEOUT', 'AUDIT_ANCHOR_FAILED'],
    });
  });

  it('fills retryOn when retryPolicy is present without retryOn at runtime', () => {
    const tool = defineTool(createDefinition({
      retryPolicy: {
        maxAttempts: 2,
        initialDelayMs: 250,
        backoffMultiplier: 2,
      } as ToolDefinition['retryPolicy'],
    }));

    expect(tool.retryPolicy).toEqual({
      maxAttempts: 2,
      initialDelayMs: 250,
      backoffMultiplier: 2,
      retryOn: ['TOOL_TIMEOUT'],
    });
  });

  it('throws when name does not match {domain}.{verbObject}', () => {
    expect(() => defineTool(createDefinition({
      name: 'material' as ToolName,
    }))).toThrow('{domain}.{verbObject}');

    expect(() => defineTool(createDefinition({
      name: 'material.protect.file' as ToolName,
    }))).toThrow('{domain}.{verbObject}');
  });

  it('throws when name domain is not in the ToolDomain whitelist', () => {
    expect(() => defineTool(createDefinition({
      name: 'finance.protectFile' as ToolName,
    }))).toThrow("domain 'finance' is not allowed");
  });

  it('throws when name verbObject is not lower camel case', () => {
    expect(() => defineTool(createDefinition({
      name: 'material.ProtectFile',
    }))).toThrow('verbObject must be lower camel case');
  });

  it('throws when tags[0] is not a legal ToolDomain', () => {
    expect(() => defineTool(createDefinition({
      tags: ['finance', 'write'] as unknown as ToolDefinition['tags'],
    }))).toThrow("tags[0]: 'finance'");
  });

  it("throws when tags[1] is not 'read' or 'write'", () => {
    expect(() => defineTool(createDefinition({
      tags: ['material', 'execute'] as unknown as ToolDefinition['tags'],
    }))).toThrow("tags[1]: 'execute'");
  });
});
