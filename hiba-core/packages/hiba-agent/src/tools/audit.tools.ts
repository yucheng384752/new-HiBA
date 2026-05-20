import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '../core/defineTool';
import type { AuditTrail } from '../audit/AuditTrail';
import type { HiBAToolbox } from '../core/HiBAToolbox';

// ── Audit integrity verification ──────────────────────────────────────────────

function recomputeHash(traceId: string, toolName: string, executedAt: string, success: boolean): string {
  return createHash('sha256')
    .update(`${traceId}|${toolName}|${executedAt}|${String(success)}`)
    .digest('hex');
}

// ── Factory: returns tools bound to an AuditTrail instance ───────────────────

export function registerAuditTools(toolbox: HiBAToolbox, audit: AuditTrail): void {

  const verifyAuditIntegrity = defineTool({
    name: 'orchestrator.verifyAuditIntegrity',
    version: '1.0.0',
    tags: ['orchestrator', 'read'],
    description: '重算 auditHash 比對 DB 儲存值，偵測稽核記錄遭竄改',
    inputSchema: z.object({
      traceId: z.string().optional().describe('指定過濾的 traceId，省略時驗證全部記錄'),
    }),
    outputSchema: z.object({
      totalChecked: z.number().describe('驗證筆數'),
      tamperedCount: z.number().describe('偵測到竄改的筆數'),
      tampered: z.array(z.object({
        traceId:      z.string(),
        toolName:     z.string(),
        storedHash:   z.string(),
        computedHash: z.string(),
      })).describe('竄改記錄清單（正常時為空陣列）'),
    }),
    permissions: ['orchestrator.read'],
    timeout: 30_000,
    handler: async (input, _ctx) => {
      const records = await audit.query(input.traceId ? { traceId: input.traceId } : {});
      const tampered = records
        .map(r => {
          const computedHash = recomputeHash(r.traceId, r.toolName, r.executedAt, r.success);
          return computedHash !== r.auditHash
            ? { traceId: r.traceId, toolName: r.toolName, storedHash: r.auditHash, computedHash }
            : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      if (tampered.length > 0) {
        throw Object.assign(
          new Error(`AUDIT_ANCHOR_FAILED: ${tampered.length} tampered record(s) detected`),
          { errorCode: 'AUDIT_ANCHOR_FAILED' },
        );
      }

      return { totalChecked: records.length, tamperedCount: 0, tampered: [] };
    },
  });

  const getAuditSummary = defineTool({
    name: 'orchestrator.getAuditSummary',
    version: '1.0.0',
    tags: ['orchestrator', 'read'],
    description: '取得指定時間區間的 AuditTrail 摘要統計',
    inputSchema: z.object({
      timeRange: z.object({
        from: z.string().describe('開始時間 ISO 8601'),
        to:   z.string().describe('結束時間 ISO 8601'),
      }),
    }),
    outputSchema: z.object({
      timeRange:       z.object({ from: z.string(), to: z.string() }),
      totalExecutions: z.number(),
      successCount:    z.number(),
      failureCount:    z.number(),
      topTools: z.array(z.object({
        toolName: z.string(),
        count:    z.number(),
      })).describe('最常用 Tool 排行（Top 10）'),
    }),
    permissions: ['orchestrator.read'],
    timeout: 15_000,
    handler: async (input, _ctx) => {
      const { from, to } = input.timeRange;
      const since = new Date(from).getTime();
      const all   = (await audit.query({ since })).filter(r => r.executedAt <= to);

      const toolCount = new Map<string, number>();
      for (const r of all) {
        toolCount.set(r.toolName, (toolCount.get(r.toolName) ?? 0) + 1);
      }
      const topTools = [...toolCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([toolName, count]) => ({ toolName, count }));

      return {
        timeRange:       input.timeRange,
        totalExecutions: all.length,
        successCount:    all.filter(r => r.success).length,
        failureCount:    all.filter(r => !r.success).length,
        topTools,
      };
    },
  });

  toolbox.register(verifyAuditIntegrity);
  toolbox.register(getAuditSummary);
}
