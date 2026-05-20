/**
 * hiba.audit.tools.ts — Audit orchestrator Tools（需要 SqliteAuditWriter 實例）
 *
 * 與 hiba.tools.ts 不同，這三個 Tool 的 handler 直接存取 SqliteAuditWriter，
 * 因此以 registerAuditTools(writer) 工廠函式延遲注冊，
 * 由應用程式入口在 writer 建立後呼叫一次。
 *
 * 注冊的三個 Tool：
 *   orchestrator.verifyAuditIntegrity — 重算 auditHash，偵測投毒（C2 實驗）
 *   orchestrator.anchorAuditBatch     — 將未上鏈記錄送至 Accounting Server 上鏈
 *   orchestrator.getAuditSummary      — 稽核統計（取代 hiba.tools.ts 中的 stub）
 */

import { z } from 'zod';
import { defineTool } from './hiba.toolbox';
import { SqliteAuditWriter, verifyIntegrity, IntegrityResult } from './hiba.audit.sqlite';
import type { ToolContext } from './hiba.types';

// ── Shared helper ─────────────────────────────────────────────────────────────

async function auditFetch(
  ctx: ToolContext,
  path: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(`${ctx.hibaBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Trace-Id': ctx.traceId,
      'X-Agent-Id': ctx.agentId,
      'X-Depth': String(ctx.depth),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  return res.json();
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerAuditTools(writer: SqliteAuditWriter): void {

  // ── orchestrator.verifyAuditIntegrity ───────────────────────────────────────
  defineTool({
    name: 'orchestrator.verifyAuditIntegrity',
    version: '1.0.0',
    tags: ['orchestrator', 'read'],
    description: '重算 auditHash 比對 DB 儲存值，偵測稽核記錄遭竄改（C2 投毒偵測）',
    inputSchema: z.object({
      traceId: z.string().optional().describe('指定過濾的 traceId，省略時驗證全部記錄'),
    }),
    outputSchema: z.object({
      totalChecked: z.number().describe('驗證筆數'),
      tamperedCount: z.number().describe('偵測到竄改的筆數'),
      tampered: z.array(z.object({
        rowId:        z.number(),
        traceId:      z.string(),
        toolName:     z.string(),
        storedHash:   z.string(),
        computedHash: z.string(),
      })).describe('竄改記錄清單（正常時為空陣列）'),
    }),
    permissions: ['orchestrator.read'],
    timeout: 30_000,
    handler: async (input, _ctx) => {
      const all: IntegrityResult[] = verifyIntegrity(writer);
      const results = input.traceId
        ? all.filter(r => r.traceId === input.traceId)
        : all;
      const tampered = results.filter(r => !r.ok);

      if (tampered.length > 0) {
        // AUDIT_ANCHOR_FAILED：由 HiBAToolbox 攔截並傳播
        throw Object.assign(
          new Error(`AUDIT_ANCHOR_FAILED: ${tampered.length} tampered record(s) detected`),
          { errorCode: 'AUDIT_ANCHOR_FAILED', tampered },
        );
      }

      return {
        totalChecked:  results.length,
        tamperedCount: 0,
        tampered:      [],
      };
    },
  });

  // ── orchestrator.anchorAuditBatch ──────────────────────────────────────────
  defineTool({
    name: 'orchestrator.anchorAuditBatch',
    version: '1.0.0',
    tags: ['orchestrator', 'write'],
    description: '將尚未上鏈的稽核記錄批次送至 Accounting Server（POST /api/audit/anchor），完成後寫入 anchoredAt / anchorTxHash',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(200).default(50)
        .describe('每批最多處理筆數（預設 50）'),
    }),
    outputSchema: z.object({
      anchored: z.number().describe('本次成功上鏈筆數'),
      txHash:   z.string().nullable().describe('區塊鏈 txHash，無記錄可上鏈時為 null'),
      skipped:  z.number().describe('因無未上鏈記錄而跳過的筆數'),
    }),
    permissions: ['orchestrator.write'],
    timeout: 60_000,
    handler: async (input, ctx) => {
      const records = writer.queryUnanchored(input.limit);
      if (records.length === 0) {
        return { anchored: 0, txHash: null, skipped: 0 };
      }

      const { txHash } = await auditFetch(ctx, '/api/audit/anchor', { records }) as { txHash: string };
      writer.markAnchored(records.map(r => r.id), txHash);

      return { anchored: records.length, txHash, skipped: 0 };
    },
  });

  // ── orchestrator.getAuditSummary（替換 hiba.tools.ts 中的 stub）─────────────
  defineTool({
    name: 'orchestrator.getAuditSummary',
    version: '1.0.0',
    tags: ['orchestrator', 'read'],
    description: '取得指定時間區間的 AuditTrail 摘要統計（含上鏈筆數）',
    inputSchema: z.object({
      timeRange: z.object({
        from: z.string().describe('開始時間 ISO 8601'),
        to:   z.string().describe('結束時間 ISO 8601'),
      }),
    }),
    outputSchema: z.object({
      timeRange: z.object({ from: z.string(), to: z.string() }),
      totalExecutions: z.number(),
      successCount:    z.number(),
      failureCount:    z.number(),
      anchored:        z.number().describe('已上鏈稽核記錄數'),
      topTools: z.array(z.object({
        toolName: z.string(),
        count:    z.number(),
      })).describe('最常用 Tool 排行（Top 10）'),
    }),
    permissions: ['orchestrator.read'],
    timeout: 15_000,
    handler: async (input, _ctx) => {
      const { from, to } = input.timeRange;
      const all = writer.queryAll().filter(
        r => r.executedAt >= from && r.executedAt <= to,
      );

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
        successCount:    all.filter(r => r.success === 1).length,
        failureCount:    all.filter(r => r.success === 0).length,
        anchored:        all.filter(r => r.anchoredAt !== null).length,
        topTools,
      };
    },
  });
}
