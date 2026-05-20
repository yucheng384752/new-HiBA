import { z } from 'zod';
import { defineTool } from './core/defineTool';
import { HiBAToolbox } from './core/HiBAToolbox';
import { AuditTrail } from './audit/AuditTrail';
import type { ToolContext } from './types/hiba.types';

async function main() {
  const auditTrail = new AuditTrail(':memory:');
  const toolbox = new HiBAToolbox({ auditWriter: auditTrail });

  toolbox.register(defineTool({
    name: 'material.protectFile',
    version: '1.0.0',
    tags: ['material', 'write'],
    description: '將檔案 metadata 上鏈保護',
    inputSchema: z.object({
      filePath: z.string().describe('檔案絕對路徑'),
      keepFile: z.boolean().default(true),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      txHash: z.string(),
    }),
    permissions: ['material.write'],
    timeout: 30_000,
    retryPolicy: { maxAttempts: 3, initialDelayMs: 500, backoffMultiplier: 2, retryOn: ['TOOL_TIMEOUT'] },
    handler: async (_input, _ctx) => {
      // hiba-core 未啟動，回傳 mock 結果
      return { success: true, txHash: 'mock-tx-hash-abc123' };
    },
  }));

  const ctx: ToolContext = {
    agentId: 'orchestrator-001',
    traceId: 'trace-abc-123',
    depth: 0,
    hibaBaseUrl: 'http://localhost:8092',
    permissions: ['material.write'],
  };

  const result = await toolbox.execute('material.protectFile', {
    filePath: '/opt/models/model_111_221.xml',
    keepFile: true,
  }, ctx);

  console.assert(result.success === true, `❌ result.success should be true, got ${result.success}`);
  if (!result.success) throw new Error(`Tool failed: ${result.errorCode} — ${result.error}`);

  console.assert(typeof result.auditHash === 'string', '❌ auditHash should be string');
  console.assert(result.auditHash.length === 64, `❌ auditHash should be 64-char SHA-256, got ${result.auditHash.length}`);

  const records = await auditTrail.query({ traceId: 'trace-abc-123' });
  console.assert(records.length === 1, `❌ AuditTrail should have 1 record, got ${records.length}`);
  console.assert(records[0]?.success === true, '❌ AuditRecord.success should be true');
  console.assert(records[0]?.toolName === 'material.protectFile', '❌ AuditRecord.toolName mismatch');

  console.log('✅ result.success:', result.success);
  console.log('✅ result.auditHash:', result.auditHash);
  console.log('✅ AuditTrail records:', records.length);
  console.log('✅ AuditRecord.toolName:', records[0]?.toolName);
  console.log('✅ AuditRecord.agentId:', records[0]?.agentId);
  console.log('\n✅ End-to-end 閉環驗證完成');
}

main().catch(err => {
  console.error('❌ E2E 驗證失敗:', err);
  process.exit(1);
});
