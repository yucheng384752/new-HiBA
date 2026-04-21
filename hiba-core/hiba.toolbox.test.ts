/**
 * hiba.toolbox.test.ts — HiBAToolbox Unit Tests
 *
 * 執行：node --test --require ts-node/register hiba.toolbox.test.ts
 *
 * 驗收條件（對應 Tool 清單定義.md）：
 *   ✓ execute(name, validInput, ctx) → success: true
 *   ✓ execute(name, invalidInput, ctx) → SCHEMA_VALIDATION_ERROR
 *   ✓ 缺少 permission → PERMISSION_EXCEEDS_PARENT
 *   ✓ 未知 Tool → TOOL_NOT_FOUND
 *   ✓ 深度超限 → MAX_DEPTH_EXCEEDED
 *   ✓ 成功執行後 AuditRecord 寫入（success: true）
 *   ✓ 失敗執行後 AuditRecord 仍寫入（success: false）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { defineTool, HiBAToolbox, MemoryAuditWriter } from './hiba.toolbox';
import type { ToolContext } from './hiba.types';

// ── Fixture: ToolContext ──────────────────────────────────────────────────────

const baseCtx: ToolContext = {
  hibaBaseUrl: 'http://localhost:8080',
  traceId: 'test-abc123-step-001',
  agentId: 'test-agent',
  depth: 1,
  permissions: ['material.write'],
};

// ── Register test tool (module-level, executed once) ─────────────────────────

defineTool({
  name: 'material.protectFile',
  version: '1.0.0',
  tags: ['material', 'write'],
  description: '將檔案 metadata 上鏈保護',
  inputSchema: z.object({
    filePath: z.string().describe('檔案絕對路徑'),
    keepFile: z.boolean().default(true).describe('是否保留本地檔案'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    txHash: z.string(),
  }),
  permissions: ['material.write'],
  timeout: 5_000,
  handler: async (input) => ({
    success: true,
    txHash: `0x${Buffer.from(input.filePath).toString('hex').slice(0, 64)}`,
  }),
});

defineTool({
  name: 'material.slowTool',
  version: '1.0.0',
  tags: ['material', 'read'],
  description: '用於 timeout 測試',
  inputSchema: z.object({}),
  outputSchema: z.object({ done: z.boolean() }),
  permissions: ['material.read'],
  timeout: 50, // 50 ms
  handler: async () => {
    await new Promise(r => setTimeout(r, 200)); // 超過 timeout
    return { done: true };
  },
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test('execute() with valid input returns success and writes audit record', async () => {
  const audit = new MemoryAuditWriter();
  const toolbox = new HiBAToolbox(audit);

  const result = await toolbox.execute<{ success: boolean; txHash: string }>(
    'material.protectFile',
    { filePath: '/tmp/test.txt' },
    baseCtx,
  );

  assert.equal(result.success, true);
  if (result.success) {
    assert.ok(result.output.txHash.startsWith('0x'), 'txHash should start with 0x');
    assert.ok(result.auditHash.length === 64, 'auditHash should be 64-char hex');
    assert.ok(result.durationMs >= 0);
  }

  assert.equal(audit.records.length, 1);
  assert.equal(audit.records[0]?.success, true);
  assert.equal(audit.records[0]?.toolName, 'material.protectFile');
  assert.equal(audit.records[0]?.traceId, baseCtx.traceId);
});

test('execute() with invalid input returns SCHEMA_VALIDATION_ERROR', async () => {
  const audit = new MemoryAuditWriter();
  const toolbox = new HiBAToolbox(audit);

  const result = await toolbox.execute(
    'material.protectFile',
    { filePath: 123 }, // filePath 應為 string
    baseCtx,
  );

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.errorCode, 'SCHEMA_VALIDATION_ERROR');
  }

  // A3 公理：失敗也要寫入稽核記錄
  assert.equal(audit.records.length, 1);
  assert.equal(audit.records[0]?.success, false);
  assert.equal(audit.records[0]?.errorCode, 'SCHEMA_VALIDATION_ERROR');
});

test('execute() with missing permission returns PERMISSION_EXCEEDS_PARENT', async () => {
  const toolbox = new HiBAToolbox();
  const noPermCtx: ToolContext = { ...baseCtx, permissions: [] };

  const result = await toolbox.execute('material.protectFile', { filePath: '/tmp/test.txt' }, noPermCtx);

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.errorCode, 'PERMISSION_EXCEEDS_PARENT');
    assert.ok(result.error.includes('material.write'), 'error message should name the missing permission');
  }
});

test('execute() with unknown tool returns TOOL_NOT_FOUND', async () => {
  const toolbox = new HiBAToolbox();

  const result = await toolbox.execute('unknown.fakeTool', {}, baseCtx);

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.errorCode, 'TOOL_NOT_FOUND');
  }
});

test('execute() exceeding depth returns MAX_DEPTH_EXCEEDED', async () => {
  const toolbox = new HiBAToolbox();
  const deepCtx: ToolContext = { ...baseCtx, depth: 6 };

  const result = await toolbox.execute('material.protectFile', { filePath: '/tmp/test.txt' }, deepCtx);

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.errorCode, 'MAX_DEPTH_EXCEEDED');
  }
});

test('execute() exceeding timeout returns TOOL_TIMEOUT', async () => {
  const toolbox = new HiBAToolbox();
  const readCtx: ToolContext = { ...baseCtx, permissions: ['material.read'] };

  const result = await toolbox.execute('material.slowTool', {}, readCtx);

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.errorCode, 'TOOL_TIMEOUT');
  }
});
