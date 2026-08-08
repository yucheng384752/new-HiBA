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

  const anchorAuditBatch = defineTool({
    name: 'orchestrator.anchorAuditBatch',
    version: '1.0.0',
    tags: ['orchestrator', 'write'],
    description: 'Anchor unanchored audit records through POST /api/audit/anchor and persist the returned txHash.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(1000).default(100),
    }),
    outputSchema: z.object({
      anchored: z.number(),
      txHash: z.string().nullable(),
      skipped: z.number(),
    }),
    permissions: ['orchestrator.write'],
    timeout: 30_000,
    handler: async (input, ctx) => {
      const records = audit.queryUnanchored(input.limit);
      const events = audit.queryUnanchoredEvents(Math.max(0, input.limit - records.length));
      const pending = [...records, ...events];
      if (pending.length === 0) {
        return { anchored: 0, txHash: null, skipped: 0 };
      }

      const response = await fetch(`${ctx.hibaBaseUrl}/api/audit/anchor`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Id': ctx.traceId,
          'X-Agent-Id': ctx.agentId,
          'X-Depth': String(ctx.depth),
        },
        body: JSON.stringify({ records: pending }),
      });

      if (!response.ok) {
        throw Object.assign(
          new Error(`AUDIT_ANCHOR_FAILED: HTTP ${response.status} from /api/audit/anchor`),
          { errorCode: 'AUDIT_ANCHOR_FAILED' },
        );
      }

      const data = await response.json() as { txHash?: string };
      if (!data.txHash) {
        throw Object.assign(
          new Error('AUDIT_ANCHOR_FAILED: /api/audit/anchor did not return txHash'),
          { errorCode: 'AUDIT_ANCHOR_FAILED' },
        );
      }

      audit.markAnchored(records.map(r => r.auditHash), data.txHash);
      audit.markEventsAnchored(events.map(event => event.eventHash), data.txHash);
      return { anchored: pending.length, txHash: data.txHash, skipped: 0 };
    },
  });

  toolbox.register(verifyAuditIntegrity);
  toolbox.register(getAuditSummary);
  toolbox.register(anchorAuditBatch);
}
