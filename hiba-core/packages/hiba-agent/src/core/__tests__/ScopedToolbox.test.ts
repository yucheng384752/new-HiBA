import { describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import { defineTool } from '../defineTool';
import { HiBAToolbox } from '../HiBAToolbox';
import { HiBAError, ScopedToolbox } from '../ScopedToolbox';
import type {
  AuditRecord,
  AuditWriter,
  ToolContext,
} from '../../../../../hiba.types';

const baseCtx: ToolContext = {
  hibaBaseUrl: 'http://localhost:8080',
  traceId: 'trace-scoped-001',
  agentId: 'agent-scoped-001',
  depth: 1,
  permissions: ['material.read', 'material.write'],
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

describe('ScopedToolbox', () => {
  it('creates a child toolbox when childPermissions is a subset of parent.permissions', () => {
    const parent = new HiBAToolbox({
      auditWriter: createAuditWriter(),
      permissions: ['material.read', 'material.write'],
    });

    expect(() => ScopedToolbox.fromParent(parent, ['material.read'])).not.toThrow();
  });

  it('throws HiBAError with PERMISSION_EXCEEDS_PARENT when childPermissions exceeds parent.permissions', () => {
    const parent = new HiBAToolbox({
      auditWriter: createAuditWriter(),
      permissions: ['material.read'],
    });

    expect(() => ScopedToolbox.fromParent(parent, ['material.write'])).toThrow(HiBAError);

    try {
      ScopedToolbox.fromParent(parent, ['material.write']);
    } catch (error) {
      expect(error).toBeInstanceOf(HiBAError);
      if (error instanceof HiBAError) {
        expect(error.errorCode).toBe('PERMISSION_EXCEEDS_PARENT');
      }
    }
  });

  it('narrows ctx.permissions to childPermissions when executing', async () => {
    const auditWriter = createAuditWriter();
    const parent = new HiBAToolbox({
      auditWriter,
      permissions: ['material.read', 'material.write'],
    });
    const readTool = defineTool({
      name: 'material.readFile',
      version: '1.0.0',
      tags: ['material', 'read'],
      description: 'Read file',
      inputSchema: z.object({ filePath: z.string() }),
      outputSchema: z.object({ content: z.string() }),
      permissions: ['material.read'],
      timeout: 1_000,
      handler: async (_input, ctx) => ({
        content: ctx.permissions.join(','),
      }),
    });
    const writeTool = defineTool({
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

    parent.register(readTool);
    parent.register(writeTool);

    const scoped = ScopedToolbox.fromParent(parent, ['material.read']);

    const readResult = await scoped.execute<{ content: string }>(
      'material.readFile',
      { filePath: '/tmp/a.txt' },
      baseCtx,
    );
    const writeResult = await scoped.execute(
      'material.writeFile',
      { filePath: '/tmp/a.txt' },
      baseCtx,
    );

    expect(readResult.success).toBe(true);
    if (readResult.success) {
      expect(readResult.output.content).toBe('material.read');
    }

    expect(writeResult.success).toBe(false);
    if (!writeResult.success) {
      expect(writeResult.errorCode).toBe('PERMISSION_EXCEEDS_PARENT');
    }
    expect(auditWriter.records).toHaveLength(2);
    expect(auditWriter.records[1]?.errorCode).toBe('PERMISSION_EXCEEDS_PARENT');
  });
});
