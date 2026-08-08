import { describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import { HiBAToolbox } from './HiBAToolbox';
import { defineTool } from './defineTool';
import type {
  AuditRecord,
  AuditWriter,
  HiBAErrorCode,
  ToolContext,
} from '../types/hiba.types';

const baseCtx: ToolContext = {
  hibaBaseUrl: 'http://localhost:8080',
  traceId: 'trace-001',
  agentId: 'agent-001',
  depth: 1,
  permissions: ['material.read'],
};

function createAuditWriter(): AuditWriter & { records: AuditRecord[] } {
  const records: AuditRecord[] = [];

  return {
    records,
    write: jest.fn(async (record: AuditRecord) => {
      records.push(record);
    }),
  };
}

function createTimeoutError(): Error & { errorCode: HiBAErrorCode } {
  const error = new Error('timeout') as Error & { errorCode: HiBAErrorCode };
  error.errorCode = 'TOOL_TIMEOUT';
  return error;
}

describe('HiBAToolbox', () => {
  it('rejects duplicate tool names instead of silently replacing them', () => {
    const toolbox = new HiBAToolbox({ auditWriter: createAuditWriter() });
    const tool = defineTool({
      name: 'material.readFile',
      version: '1.0.0',
      tags: ['material', 'read'],
      description: 'Read file',
      inputSchema: z.object({ filePath: z.string() }),
      outputSchema: z.object({ content: z.string() }),
      permissions: ['material.read'],
      timeout: 1_000,
      handler: async input => ({ content: input.filePath }),
    });

    toolbox.register(tool);
    expect(() => toolbox.register(tool)).toThrow("already registered");
  });

  it('executes a registered tool and returns ToolSuccess with non-empty auditHash', async () => {
    const auditWriter = createAuditWriter();
    const toolbox = new HiBAToolbox({ auditWriter });
    const tool = defineTool({
      name: 'material.readFile',
      version: '1.0.0',
      tags: ['material', 'read'],
      description: 'Read file',
      inputSchema: z.object({ filePath: z.string() }),
      outputSchema: z.object({ content: z.string() }),
      permissions: ['material.read'],
      timeout: 1_000,
      handler: async input => ({ content: input.filePath }),
    });

    toolbox.register(tool);

    const result = await toolbox.execute<{ content: string }>(
      'material.readFile',
      { filePath: '/tmp/a.txt' },
      baseCtx,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toEqual({ content: '/tmp/a.txt' });
      expect(result.auditHash).toEqual(expect.any(String));
      expect(result.auditHash.length).toBeGreaterThan(0);
    }
    expect(auditWriter.records).toHaveLength(1);
    expect(auditWriter.records[0]?.success).toBe(true);
    expect(auditWriter.records[0]?.auditHash).toEqual(result.auditHash);
  });

  it("returns TOOL_NOT_FOUND and writes AuditRecord when tool isn't registered", async () => {
    const auditWriter = createAuditWriter();
    const toolbox = new HiBAToolbox({ auditWriter });

    const result = await toolbox.execute('material.readFile', {}, baseCtx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe('TOOL_NOT_FOUND');
    }
    expect(auditWriter.records).toHaveLength(1);
    expect(auditWriter.records[0]?.success).toBe(false);
    expect(auditWriter.records[0]?.errorCode).toBe('TOOL_NOT_FOUND');
  });

  it('returns SCHEMA_VALIDATION_ERROR and writes AuditRecord when input fails schema validation', async () => {
    const auditWriter = createAuditWriter();
    const toolbox = new HiBAToolbox({ auditWriter });
    const tool = defineTool({
      name: 'material.readFile',
      version: '1.0.0',
      tags: ['material', 'read'],
      description: 'Read file',
      inputSchema: z.object({ filePath: z.string() }),
      outputSchema: z.object({ content: z.string() }),
      permissions: ['material.read'],
      timeout: 1_000,
      handler: async input => ({ content: input.filePath }),
    });

    toolbox.register(tool);

    const result = await toolbox.execute('material.readFile', { filePath: 123 }, baseCtx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe('SCHEMA_VALIDATION_ERROR');
    }
    expect(auditWriter.records).toHaveLength(1);
    expect(auditWriter.records[0]?.success).toBe(false);
    expect(auditWriter.records[0]?.errorCode).toBe('SCHEMA_VALIDATION_ERROR');
  });

  it('returns PERMISSION_EXCEEDS_PARENT and writes AuditRecord when permissions are insufficient', async () => {
    const auditWriter = createAuditWriter();
    const toolbox = new HiBAToolbox({ auditWriter });
    const tool = defineTool({
      name: 'material.writeFile',
      version: '1.0.0',
      tags: ['material', 'write'],
      description: 'Write file',
      inputSchema: z.object({ filePath: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      permissions: ['material.write'],
      timeout: 1_000,
      handler: async () => ({ ok: true }),
    });

    toolbox.register(tool);

    const result = await toolbox.execute('material.writeFile', { filePath: '/tmp/a.txt' }, baseCtx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe('PERMISSION_EXCEEDS_PARENT');
    }
    expect(auditWriter.records).toHaveLength(1);
    expect(auditWriter.records[0]?.success).toBe(false);
    expect(auditWriter.records[0]?.errorCode).toBe('PERMISSION_EXCEEDS_PARENT');
  });

  it('returns MAX_DEPTH_EXCEEDED and writes AuditRecord when depth is greater than maxDepth', async () => {
    const auditWriter = createAuditWriter();
    const toolbox = new HiBAToolbox({ auditWriter, maxDepth: 5 });
    const tool = defineTool({
      name: 'material.readFile',
      version: '1.0.0',
      tags: ['material', 'read'],
      description: 'Read file',
      inputSchema: z.object({ filePath: z.string() }),
      outputSchema: z.object({ content: z.string() }),
      permissions: ['material.read'],
      timeout: 1_000,
      handler: async input => ({ content: input.filePath }),
    });

    toolbox.register(tool);

    const result = await toolbox.execute(
      'material.readFile',
      { filePath: '/tmp/a.txt' },
      { ...baseCtx, depth: 6 },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe('MAX_DEPTH_EXCEEDED');
    }
    expect(auditWriter.records).toHaveLength(1);
    expect(auditWriter.records[0]?.success).toBe(false);
    expect(auditWriter.records[0]?.errorCode).toBe('MAX_DEPTH_EXCEEDED');
  });

  it('writes a failed AuditRecord when handler throws', async () => {
    const auditWriter = createAuditWriter();
    const toolbox = new HiBAToolbox({ auditWriter });
    const tool = defineTool({
      name: 'material.readFile',
      version: '1.0.0',
      tags: ['material', 'read'],
      description: 'Read file',
      inputSchema: z.object({ filePath: z.string() }),
      outputSchema: z.object({ content: z.string() }),
      permissions: ['material.read'],
      timeout: 1_000,
      handler: async () => {
        throw new Error('handler failed');
      },
    });

    toolbox.register(tool);

    const result = await toolbox.execute('material.readFile', { filePath: '/tmp/a.txt' }, baseCtx);

    expect(result.success).toBe(false);
    expect(auditWriter.records).toHaveLength(1);
    expect(auditWriter.records[0]?.success).toBe(false);
    expect(auditWriter.records[0]?.errorMsg).toBe('handler failed');
    expect(auditWriter.records[0]?.auditHash).toEqual(expect.any(String));
  });

  it('rejects handler output that does not match outputSchema', async () => {
    const auditWriter = createAuditWriter();
    const toolbox = new HiBAToolbox({ auditWriter });
    toolbox.register(defineTool({
      name: 'material.readFile',
      version: '1.0.0',
      tags: ['material', 'read'],
      description: 'Read file',
      inputSchema: z.object({ filePath: z.string() }),
      outputSchema: z.object({ content: z.string() }),
      permissions: ['material.read'],
      timeout: 1_000,
      handler: async () => ({ content: 123 } as never),
    }));

    const result = await toolbox.execute('material.readFile', { filePath: '/tmp/a.txt' }, baseCtx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.protocolVersion).toBe('1.0');
      expect(result.errorCode).toBe('OUTPUT_INVALID');
      expect(result.retryable).toBe(false);
    }
  });

  it('marks timeout failures as retryable in the shared error contract', async () => {
    const auditWriter = createAuditWriter();
    const toolbox = new HiBAToolbox({ auditWriter });
    toolbox.register(defineTool({
      name: 'material.readFile',
      version: '1.0.0',
      tags: ['material', 'read'],
      description: 'Read file',
      inputSchema: z.object({ filePath: z.string() }),
      outputSchema: z.object({ content: z.string() }),
      permissions: ['material.read'],
      timeout: 1_000,
      retryPolicy: { maxAttempts: 1, initialDelayMs: 0, backoffMultiplier: 1, retryOn: ['TOOL_TIMEOUT'] },
      handler: async () => { throw createTimeoutError(); },
    }));

    const result = await toolbox.execute('material.readFile', { filePath: '/tmp/a.txt' }, baseCtx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe('TOOL_TIMEOUT');
      expect(result.retryable).toBe(true);
    }
  });

  it('retries TOOL_TIMEOUT according to retryPolicy and returns ToolSuccess after retry succeeds', async () => {
    const auditWriter = createAuditWriter();
    const toolbox = new HiBAToolbox({ auditWriter });
    const handler = jest.fn(async () => {
      if (handler.mock.calls.length === 1) {
        throw createTimeoutError();
      }

      return { content: 'ok' };
    });
    const tool = defineTool({
      name: 'material.readFile',
      version: '1.0.0',
      tags: ['material', 'read'],
      description: 'Read file',
      inputSchema: z.object({ filePath: z.string() }),
      outputSchema: z.object({ content: z.string() }),
      permissions: ['material.read'],
      timeout: 1_000,
      retryPolicy: {
        maxAttempts: 2,
        initialDelayMs: 0,
        backoffMultiplier: 1,
        retryOn: ['TOOL_TIMEOUT'],
      },
      handler,
    });

    toolbox.register(tool);

    const result = await toolbox.execute<{ content: string }>(
      'material.readFile',
      { filePath: '/tmp/a.txt' },
      baseCtx,
    );

    expect(handler).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toEqual({ content: 'ok' });
    }
    expect(auditWriter.records).toHaveLength(1);
    expect(auditWriter.records[0]?.success).toBe(true);
  });
});
