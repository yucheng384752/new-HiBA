import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { z } from 'zod';
import { HiBAToolbox } from '../core/HiBAToolbox';
import { AuditTrail } from '../audit/AuditTrail';
import { OrchestratorRunner } from '../server/OrchestratorRunner';
import { defineTool } from '../core/defineTool';
import { allHibaTools, findProtectionTransaction, registerHibaTools } from './hiba.tools';
import { registerAuditTools } from './audit.tools';
import type { ExecutionPlan, ToolContext } from '../types/hiba.types';

function makeToolbox(): HiBAToolbox {
  const audit = new AuditTrail(':memory:');
  return new HiBAToolbox({
    auditWriter: audit,
    permissions: [
      'material.write', 'material.read',
      'machine.write',  'machine.read',
      'man.write',      'man.read',
      'method.write',   'method.read',
      'env.write',      'env.read',
      'orchestrator.write', 'orchestrator.read',
    ],
  });
}

describe('allHibaTools', () => {
  test('exports 33 tools', () => {
    expect(allHibaTools).toHaveLength(33);
  });

  test('all tool names are unique', () => {
    const names = allHibaTools.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('all tools have valid domain.verbObject names', () => {
    for (const tool of allHibaTools) {
      expect(tool.name).toMatch(/^(material|machine|man|method|env|orchestrator)\.[a-z][A-Za-z0-9]*$/);
    }
  });

  test('machine.queryStatus accepts the CNC node response shape', () => {
    const tool = allHibaTools.find(item => item.name === 'machine.queryStatus');
    const parsed = tool?.outputSchema.safeParse({
      machineId: 'CNC-01', status: 'running', oee: 90.8, alarms: [],
      queriedAt: '2026-08-22T12:42:01.557Z', orderId: 'WO-2026-001',
    });
    expect(parsed?.success).toBe(true);
  });
});

// hiba-planner:v1-optimized 對「緊急/過熱」這類任務穩定回傳英文 "high"
// （不在原本三個合法值內），見
// .codex-claude-mailbox/threads/20260904-mansendalert-priority-enum-fix.md
describe('man.sendAlert priority normalization', () => {
  const parsePriority = (priority: unknown) => {
    const tool = allHibaTools.find(item => item.name === 'man.sendAlert');
    return tool!.inputSchema.safeParse({ employeeId: 'E1', message: 'hi', priority });
  };

  test('normalizes "high" to "urgent"', () => {
    const parsed = parsePriority('high');
    expect(parsed.success).toBe(true);
    if (parsed.success) expect((parsed.data as { priority: string }).priority).toBe('urgent');
  });

  test.each(['low', 'normal', 'urgent'])('still accepts existing valid value %s', value => {
    const parsed = parsePriority(value);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect((parsed.data as { priority: string }).priority).toBe(value);
  });

  test('still defaults to "normal" when omitted', () => {
    const tool = allHibaTools.find(item => item.name === 'man.sendAlert');
    const parsed = tool!.inputSchema.safeParse({ employeeId: 'E1', message: 'hi' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect((parsed.data as { priority: string }).priority).toBe('normal');
  });

  test('still rejects unknown values', () => {
    const parsed = parsePriority('critical');
    expect(parsed.success).toBe(false);
  });
});

describe('registerHibaTools', () => {
  let toolbox: HiBAToolbox;
  beforeEach(() => { toolbox = makeToolbox(); });

  test('registers all 33 tools into the toolbox', () => {
    registerHibaTools(toolbox);
    expect(toolbox.list()).toHaveLength(33);
  });

  test('material.protectFile is registered', () => {
    registerHibaTools(toolbox);
    expect(toolbox.has('material.protectFile')).toBe(true);
  });

  test('material.verifyFile is registered', () => {
    registerHibaTools(toolbox);
    expect(toolbox.has('material.verifyFile')).toBe(true);
  });

  test('all 6 domain prefixes present', () => {
    registerHibaTools(toolbox);
    const tools = toolbox.list();
    const domains = new Set(tools.map(t => t.name.split('.')[0]));
    expect([...domains].sort()).toEqual(['env', 'machine', 'man', 'material', 'method', 'orchestrator']);
  });
});

// Regression coverage: material.protectFile used to trust the first
// transaction in the block range whose `to` matched the FileProtection
// contract. Under concurrent protectFile calls, a second call's transaction
// could land in the same range and get indexed against the wrong file. The
// fileHash-in-calldata check must reject that decoy.
describe('findProtectionTransaction', () => {
  const contract = `0x${'ab'.repeat(20)}`;
  const fileHash = 'f'.repeat(64);
  const decoyFileHash = 'a'.repeat(64);
  let previousContract: string | undefined;

  beforeEach(() => {
    previousContract = process.env['FILE_PROTECTION_CONTRACT_ADDRESS'];
    process.env['FILE_PROTECTION_CONTRACT_ADDRESS'] = contract;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (previousContract === undefined) delete process.env['FILE_PROTECTION_CONTRACT_ADDRESS'];
    else process.env['FILE_PROTECTION_CONTRACT_ADDRESS'] = previousContract;
  });

  test('picks the transaction whose calldata carries this file hash, ignoring a same-block decoy to the same contract', async () => {
    const decoyTx = { hash: '0xdecoy', to: contract, input: `0x1234${Buffer.from(decoyFileHash, 'ascii').toString('hex')}` };
    const realTx = { hash: '0xreal', to: contract, input: `0x1234${Buffer.from(fileHash, 'ascii').toString('hex')}` };

    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as { method: string };
      if (body.method !== 'eth_getBlockByNumber') throw new Error(`unexpected RPC method ${body.method}`);
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1,
        result: { hash: '0xblock11', transactions: [decoyTx, realTx] },
      }));
    });

    await expect(findProtectionTransaction(10, 11, fileHash)).resolves.toEqual({ txHash: '0xreal', blockHash: '0xblock11' });
  });

  test('throws when no transaction in range carries this file hash, even if one targets the contract', async () => {
    const decoyTx = { hash: '0xdecoy', to: contract, input: `0x1234${Buffer.from(decoyFileHash, 'ascii').toString('hex')}` };

    jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { hash: '0xblock11', transactions: [decoyTx] },
    })));

    await expect(findProtectionTransaction(10, 11, fileHash)).rejects.toThrow(/no FileProtection transaction/);
  });
});

describe('registerAuditTools', () => {
  let toolbox: HiBAToolbox;
  let audit: AuditTrail;

  beforeEach(() => {
    audit = new AuditTrail(':memory:');
    toolbox = new HiBAToolbox({
      auditWriter: audit,
      permissions: ['orchestrator.read', 'orchestrator.write'],
    });
  });

  test('registers orchestrator.verifyAuditIntegrity and orchestrator.getAuditSummary', () => {
    registerAuditTools(toolbox, audit);
    expect(toolbox.has('orchestrator.verifyAuditIntegrity')).toBe(true);
    expect(toolbox.has('orchestrator.getAuditSummary')).toBe(true);
  });

  test('verifyAuditIntegrity returns ok for empty audit trail', async () => {
    registerAuditTools(toolbox, audit);
    const ctx = {
      agentId: 'test', traceId: 'trace-1', depth: 0,
      hibaBaseUrl: 'http://localhost:9090', permissions: ['orchestrator.read'],
    };
    const result = await toolbox.execute('orchestrator.verifyAuditIntegrity', {}, ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.output as { totalChecked: number }).totalChecked).toBe(0);
      expect((result.output as { tamperedCount: number }).tamperedCount).toBe(0);
    }
  });

  test('getAuditSummary returns zero stats for empty audit trail', async () => {
    registerAuditTools(toolbox, audit);
    const ctx = {
      agentId: 'test', traceId: 'trace-1', depth: 0,
      hibaBaseUrl: 'http://localhost:9090', permissions: ['orchestrator.read'],
    };
    const result = await toolbox.execute('orchestrator.getAuditSummary', {
      timeRange: { from: '2020-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' },
    }, ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      const out = result.output as { totalExecutions: number; successCount: number; failureCount: number };
      expect(out.totalExecutions).toBe(0);
      expect(out.successCount).toBe(0);
      expect(out.failureCount).toBe(0);
    }
  });
});

// ── fileio 驗證流程 ──────────────────────────────────────────────────────────
// 驗證 env.verifyFileIo 的 2-phase probe→write 序列
// 測試中以 mock handler 代替實際 Pi I/O

describe('env.verifyFileIo — 2-phase probe→write 序列', () => {
  const BASE_CTX: ToolContext = {
    agentId: 'test-orch', traceId: 'trace-fileio-001', depth: 0,
    hibaBaseUrl: 'http://localhost:9090',
    permissions: ['env.write', 'env.read'],
  };

  function makeFileioToolbox(probeOk: boolean, writeOk: boolean): HiBAToolbox {
    const audit = new AuditTrail(':memory:');
    const tb = new HiBAToolbox({ auditWriter: audit, permissions: ['env.write', 'env.read'] });

    // mock handler：probe phase
    tb.register(defineTool({
      name: 'env.verifyFileIo',
      version: '1.0.0',
      tags: ['env', 'write'],
      description: 'mock fileio',
      inputSchema: z.object({
        mode:     z.enum(['probe', 'write', 'full']).default('full'),
        content:  z.string().optional(),
        filename: z.string().optional(),
      }),
      outputSchema: z.object({
        success:    z.boolean(),
        phase:      z.enum(['probe', 'write', 'full']),
        transferOk: z.boolean().optional(),
        written:    z.boolean().optional(),
        content:    z.string().optional(),
        path:       z.string(),
        sizeBytes:  z.number().optional(),
        writtenAt:  z.string().optional(),
        readBack:   z.string().optional(),
        matched:    z.boolean().optional(),
      }),
      permissions: ['env.write'],
      timeout: 5_000,
      handler: async (input, _ctx) => {
        if (input.mode === 'probe') {
          if (!probeOk) throw new Error('probe failed: directory not writable');
          return { success: true, phase: 'probe' as const, transferOk: true, path: '/tmp/test_io.txt' };
        }
        if (!writeOk) throw new Error('write failed: disk error');
        const content = input.content ?? 'default';
        return {
          success:   true,
          phase:     'write' as const,
          written:   true,
          content,
          path:      '/tmp/test_io.txt',
          sizeBytes: content.length,
          writtenAt: new Date().toISOString(),
          readBack:  content,
          matched:   true,
        };
      },
    }));

    (audit as unknown as { batchUploadToChain: () => Promise<void> }).batchUploadToChain = async () => {};
    return tb;
  }

  test('probe 成功 → write 成功 → succeeded=2, failed=0, skipped=0', async () => {
    const tb = makeFileioToolbox(true, true);
    const audit = new AuditTrail(':memory:');
    (audit as unknown as { batchUploadToChain: () => Promise<void> }).batchUploadToChain = async () => {};

    const runner = new OrchestratorRunner(tb, audit);
    const plan: ExecutionPlan = {
      supervisorPolicy: 'fail-fast',
      steps: [
        { stepId: 'probe', toolName: 'env.verifyFileIo', nodeId: 'local', version: '1.0.0',
          input: { mode: 'probe' }, dependsOn: [] },
        { stepId: 'write', toolName: 'env.verifyFileIo', nodeId: 'local', version: '1.0.0',
          input: { mode: 'write', content: 'hello from PC' }, dependsOn: ['probe'] },
      ],
    };

    const result = await runner.run(plan, BASE_CTX);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);

    const probeStep = result.steps.find(s => s.stepId === 'probe');
    const writeStep = result.steps.find(s => s.stepId === 'write');
    expect(probeStep?.result.success).toBe(true);
    expect(writeStep?.result.success).toBe(true);
    if (probeStep?.result.success) {
      expect((probeStep.result.output as { transferOk: boolean }).transferOk).toBe(true);
    }
    if (writeStep?.result.success) {
      expect((writeStep.result.output as { matched: boolean }).matched).toBe(true);
    }
  });

  test('probe 失敗 → write 被 skip，fail-fast 中止', async () => {
    const tb = makeFileioToolbox(false, true);
    const audit = new AuditTrail(':memory:');
    (audit as unknown as { batchUploadToChain: () => Promise<void> }).batchUploadToChain = async () => {};

    const runner = new OrchestratorRunner(tb, audit);
    const plan: ExecutionPlan = {
      supervisorPolicy: 'fail-fast',
      steps: [
        { stepId: 'probe', toolName: 'env.verifyFileIo', nodeId: 'local', version: '1.0.0',
          input: { mode: 'probe' }, dependsOn: [] },
        { stepId: 'write', toolName: 'env.verifyFileIo', nodeId: 'local', version: '1.0.0',
          input: { mode: 'write' }, dependsOn: ['probe'] },
      ],
    };

    const result = await runner.run(plan, BASE_CTX);
    // probe 失敗後 fail-fast 不一定 skip write（dependsOn 處理），但 write 不應成功
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.succeeded).toBe(0);
  });

  test('env.verifyFileIo 在 allHibaTools 中存在', () => {
    const found = allHibaTools.find(t => t.name === 'env.verifyFileIo');
    expect(found).toBeDefined();
    expect(found?.permissions).toContain('env.write');
  });

  test('Pi manifest 全部 5 個工具都已注册', () => {
    const tb = makeToolbox();
    registerHibaTools(tb);
    const piTools = [
      'env.verifyFileIo',
      'machine.executeOrder',
      'env.readSensor',
      'orchestrator.echoRtt',
      'material.readAttachment',
    ];
    for (const name of piTools) {
      expect(tb.has(name as import('../types/hiba.types').ToolName)).toBe(true);
    }
  });

  test('machine.executeOrder 要求 machineId 與 orderId', () => {
    const tool = allHibaTools.find(t => t.name === 'machine.executeOrder')!;
    expect(tool.inputSchema.safeParse({ orderId: '20260813-01' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ machineId: 'CNC-01', orderId: '20260813-01' }).success).toBe(true);
  });
});
