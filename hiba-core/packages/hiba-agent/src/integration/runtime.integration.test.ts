/**
 * HiBA-AB Runtime 整合測試
 *
 * 測試跨模組邊界的協作行為，補充各模組 unit test 未覆蓋的場景：
 *   IT-1  HiBAToolbox + AuditTrail：成功執行後 AuditRecord 正確寫入
 *   IT-2  HiBAToolbox + AuditTrail：失敗執行後 AuditRecord 仍寫入（T2 定理）
 *   IT-3  ScopedToolbox + AuditTrail：A2 權限限縮跨模組一致
 *   IT-4  ResourceDecisionService + HiBAToolbox：A3 本地 has() 整合
 *   IT-5  TrustRegistry + HiBAToolbox：AgentRecord 權限映射到執行 ctx
 *   IT-6  Retry chain + AuditTrail：重試成功只寫一筆 AuditRecord
 *   IT-7  全管道：defineTool → ScopedToolbox → execute → AuditTrail.query
 */

import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { z } from 'zod';
import { defineTool } from '../core/defineTool';
import { HiBAToolbox } from '../core/HiBAToolbox';
import { ScopedToolbox } from '../core/ScopedToolbox';
import { ResourceDecisionService } from '../core/ResourceDecisionService';
import { TrustRegistry } from '../trust/TrustRegistry';
import { AuditTrail } from '../audit/AuditTrail';
import type {
  NodeCapabilityChecker,
} from '../core/HttpNodeCapabilityChecker';
import type { ToolContext, HiBAErrorCode, PlanStep } from '../types/hiba.types';

// ── 共用 fixture ──────────────────────────────────────────────────────────────

function makeAuditTrail() {
  return new AuditTrail(':memory:');
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    hibaBaseUrl: 'http://localhost:8092',
    traceId:     'trace-it-001',
    agentId:     'agent-it-001',
    depth:       0,
    permissions: ['material.read', 'material.write'],
    ...overrides,
  };
}

const readTool = defineTool({
  name:         'material.readFile',
  version:      '1.0.0',
  tags:         ['material', 'read'],
  description:  'Read a file',
  inputSchema:  z.object({ filePath: z.string() }),
  outputSchema: z.object({ content: z.string() }),
  permissions:  ['material.read'],
  timeout:      5_000,
  handler:      async (input) => ({ content: `data:${input.filePath}` }),
});

const writeTool = defineTool({
  name:         'material.writeFile',
  version:      '1.0.0',
  tags:         ['material', 'write'],
  description:  'Write a file',
  inputSchema:  z.object({ filePath: z.string(), data: z.string() }),
  outputSchema: z.object({ ok: z.boolean() }),
  permissions:  ['material.write'],
  timeout:      5_000,
  handler:      async () => ({ ok: true }),
});

// ── IT-1：HiBAToolbox + AuditTrail 成功執行 ──────────────────────────────────

describe('IT-1: HiBAToolbox + AuditTrail — success path', () => {
  it('writes a success AuditRecord with correct fields after execute', async () => {
    const audit = makeAuditTrail();
    const toolbox = new HiBAToolbox({ auditWriter: audit });
    toolbox.register(readTool);

    const ctx = makeCtx({ traceId: 'trace-it1' });
    const result = await toolbox.execute('material.readFile', { filePath: '/a.txt' }, ctx);

    expect(result.success).toBe(true);

    const records = await audit.query({ traceId: 'trace-it1' });
    expect(records).toHaveLength(1);

    const rec = records[0]!;
    expect(rec.toolName).toBe('material.readFile');
    expect(rec.toolDomain).toBe('material');
    expect(rec.agentId).toBe('agent-it-001');
    expect(rec.success).toBe(true);
    expect(rec.auditHash).toHaveLength(64);
    expect(rec.errorCode).toBeUndefined();

    if (result.success) {
      expect(rec.auditHash).toBe(result.auditHash);
    }
  });
});

// ── IT-2：HiBAToolbox + AuditTrail T2 定理（失敗也要有記錄）─────────────────

describe('IT-2: HiBAToolbox + AuditTrail — T2 theorem (failure still audited)', () => {
  it('writes a failure AuditRecord when tool is not registered', async () => {
    const audit = makeAuditTrail();
    const toolbox = new HiBAToolbox({ auditWriter: audit });

    const ctx = makeCtx({ traceId: 'trace-it2-notfound' });
    const result = await toolbox.execute('material.readFile', { filePath: '/x.txt' }, ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorCode).toBe('TOOL_NOT_FOUND');

    const records = await audit.query({ traceId: 'trace-it2-notfound' });
    expect(records).toHaveLength(1);
    expect(records[0]!.success).toBe(false);
    expect(records[0]!.errorCode).toBe('TOOL_NOT_FOUND');
  });

  it('writes a failure AuditRecord when handler throws', async () => {
    const audit = makeAuditTrail();
    const crashTool = defineTool({
      name:         'material.crash',
      version:      '1.0.0',
      tags:         ['material', 'write'],
      description:  'Always crashes',
      inputSchema:  z.object({}),
      outputSchema: z.object({}),
      permissions:  ['material.write'],
      timeout:      5_000,
      handler:      async () => { throw new Error('simulated crash'); },
    });
    const toolbox = new HiBAToolbox({ auditWriter: audit });
    toolbox.register(crashTool);

    const ctx = makeCtx({ traceId: 'trace-it2-crash' });
    const result = await toolbox.execute('material.crash', {}, ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorCode).toBe('HANDLER_EXECUTION_FAILED');

    const records = await audit.query({ traceId: 'trace-it2-crash' });
    expect(records).toHaveLength(1);
    expect(records[0]!.success).toBe(false);
    expect(records[0]!.errorCode).toBe('HANDLER_EXECUTION_FAILED');
    expect(records[0]!.errorMsg).toBe('simulated crash');
  });
});

// ── IT-3：ScopedToolbox + AuditTrail A2 跨模組一致 ───────────────────────────

describe('IT-3: ScopedToolbox + AuditTrail — A2 permission narrowing', () => {
  it('read-only child can execute readTool but not writeTool, both AuditRecorded', async () => {
    const audit = makeAuditTrail();
    const parent = new HiBAToolbox({
      auditWriter: audit,
      permissions: ['material.read', 'material.write'],
    });
    parent.register(readTool);
    parent.register(writeTool);

    const child = ScopedToolbox.fromParent(parent, ['material.read']);
    const ctx = makeCtx({ traceId: 'trace-it3', permissions: ['material.read', 'material.write'] });

    const readResult  = await child.execute('material.readFile',  { filePath: '/r.txt' }, ctx);
    const writeResult = await child.execute('material.writeFile', { filePath: '/w.txt', data: 'x' }, ctx);

    expect(readResult.success).toBe(true);
    expect(writeResult.success).toBe(false);
    if (!writeResult.success) expect(writeResult.errorCode).toBe('PERMISSION_EXCEEDS_PARENT');

    const records = await audit.query({ traceId: 'trace-it3' });
    expect(records).toHaveLength(2);

    const readRec  = records.find(r => r.toolName === 'material.readFile')!;
    const writeRec = records.find(r => r.toolName === 'material.writeFile')!;
    expect(readRec.success).toBe(true);
    expect(writeRec.success).toBe(false);
    expect(writeRec.errorCode).toBe('PERMISSION_EXCEEDS_PARENT');
  });
});

// ── IT-4：ResourceDecisionService + HiBAToolbox A3 本地 has() ────────────────

describe('IT-4: ResourceDecisionService + HiBAToolbox — A3 local has()', () => {
  function makeChecker(canInstall: boolean, isStale: boolean): NodeCapabilityChecker {
    return {
      canInstall: jest.fn(async () => canInstall),
      isStale:    jest.fn(async () => isStale),
      clearCache: jest.fn(),
    };
  }

  const step: PlanStep = {
    stepId:    'S1',
    toolName:  'material.readFile',
    nodeId:    'node-1',
    version:   '1.0.0',
    input:     { filePath: '/x.txt' },
    dependsOn: [],
  };

  const ctx = makeCtx();

  it("returns 'execute' when tool is registered locally and not stale", async () => {
    const audit   = makeAuditTrail();
    const toolbox = new HiBAToolbox({ auditWriter: audit });
    toolbox.register(readTool);

    const checker = makeChecker(true, false);
    const svc     = new ResourceDecisionService(toolbox, checker);

    const action = await svc.decide(step, ctx);
    expect(action).toBe('execute');
    expect(checker.isStale).toHaveBeenCalledWith('node-1', 'material.readFile', '1.0.0', ctx);
    expect(checker.canInstall).not.toHaveBeenCalled();
  });

  it("returns 'update' when tool is registered locally but stale", async () => {
    const audit   = makeAuditTrail();
    const toolbox = new HiBAToolbox({ auditWriter: audit });
    toolbox.register(readTool);

    const checker = makeChecker(false, true);
    const svc     = new ResourceDecisionService(toolbox, checker);

    expect(await svc.decide(step, ctx)).toBe('update');
  });

  it("returns 'install' when tool NOT registered locally and canInstall=true", async () => {
    const audit   = makeAuditTrail();
    const toolbox = new HiBAToolbox({ auditWriter: audit });

    const checker = makeChecker(true, false);
    const svc     = new ResourceDecisionService(toolbox, checker);

    expect(await svc.decide(step, ctx)).toBe('install');
    expect(checker.canInstall).toHaveBeenCalledWith('node-1', ctx);
    expect(checker.isStale).not.toHaveBeenCalled();
  });

  it("returns 'dispatch' when tool NOT registered locally and canInstall=false", async () => {
    const audit   = makeAuditTrail();
    const toolbox = new HiBAToolbox({ auditWriter: audit });

    const checker = makeChecker(false, false);
    const svc     = new ResourceDecisionService(toolbox, checker);

    expect(await svc.decide(step, ctx)).toBe('dispatch');
  });
});

// ── IT-5：TrustRegistry + HiBAToolbox 權限映射 ───────────────────────────────

describe('IT-5: TrustRegistry + HiBAToolbox — agent permissions mapped to ctx', () => {
  it('active agent can execute tool matching its permissions', async () => {
    const registry = new TrustRegistry(':memory:');
    const audit    = makeAuditTrail();
    const toolbox  = new HiBAToolbox({ auditWriter: audit });
    toolbox.register(readTool);

    await registry.register({
      agentId:       'agent-reader',
      role:          'domain',
      permissions:   ['material.read'],
      parentAgentId: null,
      publicKeyPem:  '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----',
      registeredAt:  Date.now(),
      status:        'active',
    });

    const agent = await registry.lookup('agent-reader');
    expect(agent).not.toBeNull();

    const ctx: ToolContext = {
      hibaBaseUrl: 'http://localhost:8092',
      traceId:     'trace-it5-ok',
      agentId:     agent!.agentId,
      depth:       0,
      permissions: agent!.permissions,
    };

    const result = await toolbox.execute('material.readFile', { filePath: '/safe.txt' }, ctx);
    expect(result.success).toBe(true);
  });

  it('revoked agent permissions cause PERMISSION_EXCEEDS_PARENT on execute', async () => {
    const registry = new TrustRegistry(':memory:');
    const audit    = makeAuditTrail();
    const toolbox  = new HiBAToolbox({ auditWriter: audit });
    toolbox.register(writeTool);

    await registry.register({
      agentId:       'agent-writer',
      role:          'domain',
      permissions:   ['material.write'],
      parentAgentId: null,
      publicKeyPem:  '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----',
      registeredAt:  Date.now(),
      status:        'active',
    });

    await registry.revoke('agent-writer');
    const revoked = await registry.lookup('agent-writer');
    expect(revoked!.status).toBe('revoked');

    // 撤銷後以空權限執行（模擬 auth middleware 攔截後降級）
    const ctx: ToolContext = {
      hibaBaseUrl: 'http://localhost:8092',
      traceId:     'trace-it5-revoked',
      agentId:     'agent-writer',
      depth:       0,
      permissions: [],   // revoked → 無權限
    };

    const result = await toolbox.execute('material.writeFile', { filePath: '/x.txt', data: 'y' }, ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorCode).toBe('PERMISSION_EXCEEDS_PARENT');
  });
});

// ── IT-6：Retry chain + AuditTrail 重試成功只寫一筆 ─────────────────────────

describe('IT-6: HiBAToolbox retry chain + AuditTrail — single record on eventual success', () => {
  it('writes exactly one success AuditRecord after retry', async () => {
    const audit   = makeAuditTrail();
    let attempt   = 0;
    const flakyTool = defineTool({
      name:         'material.flaky',
      version:      '1.0.0',
      tags:         ['material', 'read'],
      description:  'Fails once, then succeeds',
      inputSchema:  z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      permissions:  ['material.read'],
      timeout:      5_000,
      retryPolicy:  { maxAttempts: 2, initialDelayMs: 0, backoffMultiplier: 1, retryOn: ['TOOL_TIMEOUT'] },
      handler: async () => {
        attempt += 1;
        if (attempt === 1) {
          const err = Object.assign(new Error('timeout'), { errorCode: 'TOOL_TIMEOUT' as HiBAErrorCode });
          throw err;
        }
        return { ok: true };
      },
    });

    const toolbox = new HiBAToolbox({ auditWriter: audit });
    toolbox.register(flakyTool);

    const ctx = makeCtx({ traceId: 'trace-it6' });
    const result = await toolbox.execute('material.flaky', {}, ctx);

    expect(result.success).toBe(true);
    expect(attempt).toBe(2);   // 確認重試了一次

    const records = await audit.query({ traceId: 'trace-it6' });
    expect(records).toHaveLength(1);     // 只有一筆，不是每次 attempt 都寫
    expect(records[0]!.success).toBe(true);
  });
});

// ── IT-7：全管道整合 ──────────────────────────────────────────────────────────

describe('IT-7: full pipeline — defineTool → ScopedToolbox → AuditTrail.query', () => {
  it('executes end-to-end and AuditTrail has queryable record with correct auditHash', async () => {
    const audit  = makeAuditTrail();
    const parent = new HiBAToolbox({
      auditWriter: audit,
      permissions: ['material.read', 'material.write'],
    });
    parent.register(readTool);
    parent.register(writeTool);

    const child = ScopedToolbox.fromParent(parent, ['material.read', 'material.write']);

    const ctx = makeCtx({ traceId: 'trace-it7', agentId: 'orch-007' });

    const r1 = await child.execute('material.readFile',  { filePath: '/data.csv' }, ctx);
    const r2 = await child.execute('material.writeFile', { filePath: '/out.csv', data: 'result' }, ctx);

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);

    const all = await audit.query({ traceId: 'trace-it7' });
    expect(all).toHaveLength(2);
    expect(all.every(r => r.agentId === 'orch-007')).toBe(true);
    expect(all.map(r => r.toolName)).toEqual(
      expect.arrayContaining(['material.readFile', 'material.writeFile'])
    );

    // auditHash 格式驗證（64-char hex）
    for (const rec of all) {
      expect(rec.auditHash).toMatch(/^[0-9a-f]{64}$/);
    }

    // AuditTrail 跨 agentId 查詢不返回其他 agent 的記錄
    const otherAgent = await audit.query({ agentId: 'nobody' });
    expect(otherAgent).toHaveLength(0);
  });
});
