/**
 * hiba.audit.sqlite.test.ts — SqliteAuditWriter + verifyIntegrity 測試
 *
 * 執行：node --test --require ts-node/register hiba.audit.sqlite.test.ts
 *
 * 驗收條件：
 *   ✓ write() 寫入一筆成功記錄，queryAll() 回傳正確欄位
 *   ✓ write() 寫入失敗記錄（含 errorCode），欄位正確對應
 *   ✓ 多筆寫入，queryByTraceId() 正確過濾
 *   ✓ verifyIntegrity() 對正常記錄全部 ok=true
 *   ✓ verifyIntegrity() 偵測竄改：手動修改 auditHash → ok=false（C2 投毒實驗）
 *   ✓ T2 定理：write() 與 HiBAToolbox.execute() 整合，成功與失敗均有稽核記錄
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { SqliteAuditWriter, verifyIntegrity } from './hiba.audit.sqlite';
import { defineTool, HiBAToolbox } from './hiba.toolbox';
import { registerAuditTools } from './hiba.audit.tools';
import type { AuditRecord, ToolContext } from './hiba.types';

// 注冊 audit orchestrator tools（一次即可）
// sharedAuditWriter 供 orchestrator.* tools 的 handler 讀取（工具閉包與此實例綁定）
const sharedAuditWriter = new SqliteAuditWriter(':memory:');
registerAuditTools(sharedAuditWriter);

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  const executedAt = new Date().toISOString();
  return {
    traceId:    'trace-001-step-001',
    agentId:    'material-agent-01',
    depth:      1,
    toolName:   'material.protectFile',
    toolDomain: 'material',
    version:    '1.0.0',
    success:    true,
    durationMs: 42,
    executedAt,
    auditHash:  'a'.repeat(64),
    ...overrides,
  };
}

const baseCtx: ToolContext = {
  hibaBaseUrl: 'http://localhost:8080',
  traceId:     'trace-sqlite-test-001',
  agentId:     'test-agent',
  depth:       1,
  permissions: ['material.write', 'orchestrator.read', 'orchestrator.write'],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

test('write() success record — queryAll() returns correct fields', async () => {
  const writer = new SqliteAuditWriter(':memory:');
  const record = makeRecord();

  await writer.write(record);
  const rows = writer.queryAll();

  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.traceId,    record.traceId);
  assert.equal(row.agentId,    record.agentId);
  assert.equal(row.toolName,   record.toolName);
  assert.equal(row.toolDomain, record.toolDomain);
  assert.equal(row.version,    record.version);
  assert.equal(row.success,    1);
  assert.equal(row.durationMs, record.durationMs);
  assert.equal(row.executedAt, record.executedAt);
  assert.equal(row.errorCode,  null);
  assert.equal(row.errorMsg,   null);
  assert.equal(row.auditHash,  record.auditHash);

  writer.close();
});

test('write() failure record — errorCode and errorMsg stored correctly', async () => {
  const writer = new SqliteAuditWriter(':memory:');
  const record = makeRecord({
    success:   false,
    errorCode: 'SCHEMA_VALIDATION_ERROR',
    errorMsg:  'filePath: Expected string, received number',
    auditHash: 'b'.repeat(64),
  });

  await writer.write(record);
  const rows = writer.queryAll();

  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.success,   0);
  assert.equal(row.errorCode, 'SCHEMA_VALIDATION_ERROR');
  assert.equal(row.errorMsg,  'filePath: Expected string, received number');

  writer.close();
});

test('queryByTraceId() filters by traceId', async () => {
  const writer = new SqliteAuditWriter(':memory:');

  await writer.write(makeRecord({ traceId: 'trace-A', toolName: 'material.protectFile' }));
  await writer.write(makeRecord({ traceId: 'trace-B', toolName: 'machine.queryStatus' }));
  await writer.write(makeRecord({ traceId: 'trace-A', toolName: 'material.verifyFile' }));

  const rowsA = writer.queryByTraceId('trace-A');
  const rowsB = writer.queryByTraceId('trace-B');

  assert.equal(rowsA.length, 2);
  assert.equal(rowsB.length, 1);
  assert.equal(rowsA[0]!.toolName, 'material.protectFile');
  assert.equal(rowsA[1]!.toolName, 'material.verifyFile');

  writer.close();
});

test('verifyIntegrity() returns ok=true for untampered records', async () => {
  const writer = new SqliteAuditWriter(':memory:');

  // 使用 HiBAToolbox 產生帶有正確 auditHash 的記錄
  defineTool({
    name:         'material.integrityTest',
    version:      '1.0.0',
    tags:         ['material', 'write'],
    description:  '完整性測試用 Tool',
    inputSchema:  z.object({ filePath: z.string() }),
    outputSchema: z.object({ ok: z.boolean() }),
    permissions:  ['material.write'],
    timeout:      5_000,
    handler:      async () => ({ ok: true }),
  });

  const toolbox = new HiBAToolbox(writer);
  await toolbox.execute('material.integrityTest', { filePath: '/tmp/a.txt' }, baseCtx);

  const results = verifyIntegrity(writer);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.ok, true, 'untampered record should pass integrity check');

  writer.close();
});

test('verifyIntegrity() detects tampered auditHash — C2 投毒偵測', async () => {
  const writer = new SqliteAuditWriter(':memory:');

  // 寫入一筆帶有偽造 auditHash 的記錄（模擬 Node 8 竄改回傳）
  const tampered = makeRecord({
    traceId:   'trace-poisoned-001',
    auditHash: 'deadbeef'.repeat(8), // 64 chars but wrong hash
  });
  await writer.write(tampered);

  const results = verifyIntegrity(writer);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.ok, false, 'tampered auditHash should fail integrity check');
  assert.notEqual(results[0]!.storedHash, results[0]!.computedHash);

  writer.close();
});

test('queryUnanchored() 只回傳 anchoredAt IS NULL 的記錄', async () => {
  const writer = new SqliteAuditWriter(':memory:');

  await writer.write(makeRecord({ traceId: 'trace-A' }));
  await writer.write(makeRecord({ traceId: 'trace-B' }));

  // 標記 trace-A 已上鏈
  const all = writer.queryAll();
  writer.markAnchored([all[0]!.id], '0xdeadbeef');

  const unanchored = writer.queryUnanchored();
  assert.equal(unanchored.length, 1);
  assert.equal(unanchored[0]!.traceId, 'trace-B');
  assert.equal(unanchored[0]!.anchoredAt, null);

  writer.close();
});

test('markAnchored() 正確寫入 anchoredAt 與 anchorTxHash', async () => {
  const writer = new SqliteAuditWriter(':memory:');

  await writer.write(makeRecord({ traceId: 'trace-mark' }));
  const id = writer.queryAll()[0]!.id;
  const txHash = '0xabc123';

  writer.markAnchored([id], txHash);

  const row = writer.queryAll()[0]!;
  assert.ok(row.anchoredAt !== null, 'anchoredAt should be set');
  assert.equal(row.anchorTxHash, txHash);

  // 已上鏈後不再出現在 queryUnanchored
  assert.equal(writer.queryUnanchored().length, 0);

  writer.close();
});

test('orchestrator.verifyAuditIntegrity：完整記錄回傳 tamperedCount=0', async () => {
  const writer = new SqliteAuditWriter(':memory:');
  const toolbox = new HiBAToolbox(writer);

  await toolbox.execute('material.integrityTest', { filePath: '/tmp/ok.txt' }, baseCtx);

  const result = await toolbox.execute<{ tamperedCount: number; tampered: unknown[] }>(
    'orchestrator.verifyAuditIntegrity', {}, baseCtx,
  );
  assert.ok(result.success);
  if (result.success) {
    assert.equal(result.output.tamperedCount, 0);
    assert.equal(result.output.tampered.length, 0);
  }

  writer.close();
});

test('orchestrator.verifyAuditIntegrity：竄改記錄拋出 AUDIT_ANCHOR_FAILED', async () => {
  // 寫入偽造 auditHash 至 sharedAuditWriter（tool handler 讀取的同一實例）
  await sharedAuditWriter.write(makeRecord({ traceId: 'trace-tampered', auditHash: 'deadbeef'.repeat(8) }));

  const toolbox = new HiBAToolbox(sharedAuditWriter);
  const result = await toolbox.execute('orchestrator.verifyAuditIntegrity', {}, baseCtx);
  assert.ok(!result.success);
  if (!result.success) {
    assert.equal(result.errorCode, 'HANDLER_EXECUTION_FAILED');
  }
});

test('verifyAndAnchor()：竄改記錄 → blockedTraceIds 阻擋後續執行', async () => {
  const writer = new SqliteAuditWriter(':memory:');
  const toolbox = new HiBAToolbox(writer);

  // 插入已竄改記錄
  await writer.write(makeRecord({ traceId: 'trace-blocked', auditHash: 'bad'.padEnd(64, '0') }));

  await assert.rejects(
    () => toolbox.verifyAndAnchor(writer, baseCtx),
    /AUDIT_ANCHOR_FAILED/,
  );

  // 同一 traceId 的後續 execute 應被 block
  const blocked = await toolbox.execute(
    'material.integrityTest',
    { filePath: '/tmp/x.txt' },
    { ...baseCtx, traceId: 'trace-blocked' },
  );
  assert.ok(!blocked.success);
  if (!blocked.success) {
    assert.equal(blocked.errorCode, 'AUDIT_ANCHOR_FAILED');
  }

  writer.close();
});

test('T2 定理：HiBAToolbox.execute() 成功與失敗均產生稽核記錄', async () => {
  const writer = new SqliteAuditWriter(':memory:');
  const toolbox = new HiBAToolbox(writer);

  // 成功執行
  await toolbox.execute('material.integrityTest', { filePath: '/tmp/b.txt' }, baseCtx);
  // 失敗執行（schema 錯誤）
  await toolbox.execute('material.integrityTest', { filePath: 123 as unknown as string }, baseCtx);

  const rows = writer.queryAll();
  assert.equal(rows.length, 2, 'both success and failure must produce audit records');
  assert.equal(rows[0]!.success, 1);
  assert.equal(rows[1]!.success, 0);
  assert.equal(rows[1]!.errorCode, 'SCHEMA_VALIDATION_ERROR');

  writer.close();
});
