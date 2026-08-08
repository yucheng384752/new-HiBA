/**
 * OrchestratorRunner.test.ts
 *
 * Covers:
 *   - empty plan
 *   - plan with error field
 *   - cycle detection
 *   - sequential dependsOn (S1 → S2)
 *   - parallel layer (S1, S2 independent)
 *   - fail-fast: stops after first failure, remaining skipped
 *   - partial-success: continues past failures, failed-dep steps skipped
 *   - audit anchor called (success)
 *   - audit anchor failure is non-fatal
 *   - dispatched='local' when nodeId not in registry
 *   - dispatched='remote' when nodeId in registry → real HTTP call
 *   - remote dispatch: non-200 HTTP → ToolFailure
 *   - remote dispatch: network error → ToolFailure
 *   - parseNodeAddresses utility
 */

import { test, expect, beforeAll, afterAll, describe } from '@jest/globals';
import http from 'node:http';
import { z } from 'zod';
import { OrchestratorRunner, parseNodeAddresses } from './OrchestratorRunner';
import { AgentServer } from './AgentServer';
import { HiBAToolbox } from '../core/HiBAToolbox';
import { AuditTrail } from '../audit/AuditTrail';
import { defineTool } from '../core/defineTool';
import { NLPlanningService } from '../planning/NLPlanningService';
import type { ExecutionPlan, ToolContext } from '../types/hiba.types';
import type { LLMClient, AccountingClient } from '../planning/NLPlanningService';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_CTX: ToolContext = {
  agentId:     'test-orchestrator',
  traceId:     'trace-orch-001',
  depth:       0,
  hibaBaseUrl: 'http://localhost:9090',
  permissions: ['material.write', 'material.read'],
};

function makeRunner(anchorShouldFail = false, nodeAddresses?: Map<string, string>, accountingUrl?: string, auditOut?: AuditTrail[]) {
  const audit = new AuditTrail(':memory:');
  auditOut?.push(audit);
  // Always mock batchUploadToChain — tests run without a live accounting server
  (audit as unknown as { batchUploadToChain: () => Promise<void> }).batchUploadToChain =
    anchorShouldFail
      ? async () => { throw new Error('anchor failed'); }
      : async () => { /* noop */ };

  const toolbox = new HiBAToolbox({ auditWriter: audit, permissions: ['material.write', 'material.read'] });

  toolbox.register(defineTool({
    name: 'material.protectFile',
    version: '1.0.0',
    tags: ['material', 'write'],
    description: 'protect',
    inputSchema: z.object({ filePath: z.string() }),
    outputSchema: z.object({ txHash: z.string() }),
    permissions: ['material.write'],
    timeout: 5_000,
    handler: async input => ({ txHash: `0x${input.filePath.length}` }),
  }));

  toolbox.register(defineTool({
    name: 'material.verifyFile',
    version: '1.0.0',
    tags: ['material', 'read'],
    description: 'verify',
    inputSchema: z.object({ filePath: z.string() }),
    outputSchema: z.object({ valid: z.boolean() }),
    permissions: ['material.read'],
    timeout: 5_000,
    handler: async () => ({ valid: true }),
  }));

  toolbox.register(defineTool({
    name: 'material.failAlways',
    version: '1.0.0',
    tags: ['material', 'write'],
    description: 'always fails',
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    permissions: ['material.write'],
    timeout: 5_000,
    handler: async () => { throw new Error('intentional failure'); },
  }));

  return new OrchestratorRunner(toolbox, audit, { nodeAddresses, accountingUrl });
}

function step(
  stepId: string,
  toolName: string,
  input: Record<string, unknown> = {},
  dependsOn: string[] = [],
) {
  return { stepId, toolName, nodeId: 'local', version: '1.0.0', input, dependsOn } as
    import('../types/hiba.types').PlanStep;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('empty steps → succeeded=0, skipped=0', async () => {
  const runner = makeRunner();
  const plan: ExecutionPlan = { steps: [], supervisorPolicy: 'fail-fast' };
  const result = await runner.run(plan, BASE_CTX);
  expect(result.succeeded).toBe(0);
  expect(result.failed).toBe(0);
  expect(result.skipped).toBe(0);
});

test('plan with error field → returns error, no steps executed', async () => {
  const runner = makeRunner();
  const plan: ExecutionPlan = { steps: [], supervisorPolicy: 'fail-fast', error: 'LLM parse failed' };
  const result = await runner.run(plan, BASE_CTX);
  expect(result.error).toBe('LLM parse failed');
  expect(result.steps.length).toBe(0);
});

test('cycle detection → returns error with cyclic stepIds', async () => {
  const runner = makeRunner();
  const plan: ExecutionPlan = {
    steps: [
      step('S1', 'material.protectFile', { filePath: '/a' }, ['S2']),
      step('S2', 'material.verifyFile',  { filePath: '/a' }, ['S1']),
    ],
    supervisorPolicy: 'fail-fast',
  };
  const result = await runner.run(plan, BASE_CTX);
  expect(result.error).toMatch(/Cycle detected/);
  expect(result.steps.length).toBe(0);
});

test('sequential dependsOn S1→S2: both succeed, correct order', async () => {
  const runner = makeRunner();
  const plan: ExecutionPlan = {
    steps: [
      step('S1', 'material.protectFile', { filePath: '/a' }),
      step('S2', 'material.verifyFile',  { filePath: '/a' }, ['S1']),
    ],
    supervisorPolicy: 'fail-fast',
  };
  const result = await runner.run(plan, BASE_CTX);
  expect(result.succeeded).toBe(2);
  expect(result.failed).toBe(0);
  expect(result.steps[0]?.stepId).toBe('S1');
  expect(result.steps[1]?.stepId).toBe('S2');
});

test('downstream input resolves an explicit upstream output reference', async () => {
  const runner = makeRunner();
  const plan: ExecutionPlan = {
    steps: [
      step('S1', 'material.protectFile', { filePath: '/abc' }),
      step('S2', 'material.verifyFile', { filePath: '$steps.S1.output.txHash' }, ['S1']),
    ],
    supervisorPolicy: 'fail-fast',
  };
  const result = await runner.run(plan, BASE_CTX);
  expect(result.succeeded).toBe(2);
});

test('missing upstream output reference fails before dispatch', async () => {
  const runner = makeRunner();
  const plan: ExecutionPlan = {
    steps: [step('S1', 'material.verifyFile', { filePath: '$steps.missing.output.path' })],
    supervisorPolicy: 'fail-fast',
  };
  const result = await runner.run(plan, BASE_CTX);
  expect(result.failed).toBe(1);
  expect((result.steps[0]?.result as { errorCode: string }).errorCode).toBe('SCHEMA_VALIDATION_ERROR');
});

test('parallel layer: S1 and S2 independent, both executed', async () => {
  const runner = makeRunner();
  const plan: ExecutionPlan = {
    steps: [
      step('S1', 'material.protectFile', { filePath: '/a' }),
      step('S2', 'material.verifyFile',  { filePath: '/b' }),
    ],
    supervisorPolicy: 'fail-fast',
  };
  const result = await runner.run(plan, BASE_CTX);
  expect(result.succeeded).toBe(2);
  expect(result.steps.length).toBe(2);
});

test('fail-fast: S1 fails → later layers (S2, S3) skipped', async () => {
  const runner = makeRunner();
  // S2 and S3 depend on S1 → they are in layer 1 and layer 2 respectively
  // When S1 fails with fail-fast, aborted=true → layers 1 and 2 are skipped
  const plan: ExecutionPlan = {
    steps: [
      step('S1', 'material.failAlways', {}),
      step('S2', 'material.protectFile', { filePath: '/a' }, ['S1']),
      step('S3', 'material.verifyFile',  { filePath: '/a' }, ['S2']),
    ],
    supervisorPolicy: 'fail-fast',
  };
  const result = await runner.run(plan, BASE_CTX);
  expect(result.failed).toBe(1);
  expect(result.skipped).toBe(2);
  expect(result.succeeded).toBe(0);
  expect(result.policy).toBe('fail-fast');
});

test('partial-success: S1 fails, S2 independent → S2 still runs', async () => {
  const runner = makeRunner();
  const plan: ExecutionPlan = {
    steps: [
      step('S1', 'material.failAlways', {}),
      step('S2', 'material.protectFile', { filePath: '/a' }),
    ],
    supervisorPolicy: 'partial-success',
  };
  const result = await runner.run(plan, BASE_CTX);
  expect(result.failed).toBe(1);
  expect(result.succeeded).toBe(1);
  expect(result.skipped).toBe(0);
});

test('partial-success: failed dep → dependent step skipped', async () => {
  const runner = makeRunner();
  const plan: ExecutionPlan = {
    steps: [
      step('S1', 'material.failAlways', {}),
      step('S2', 'material.protectFile', { filePath: '/a' }, ['S1']),  // depends on failed S1
    ],
    supervisorPolicy: 'partial-success',
  };
  const result = await runner.run(plan, BASE_CTX);
  expect(result.failed).toBe(1);
  expect(result.skipped).toBe(1);
  expect(result.succeeded).toBe(0);
});

test('traceId propagated to runId and result', async () => {
  const runner = makeRunner();
  const ctx = { ...BASE_CTX, traceId: 'trace-custom-xyz' };
  const plan: ExecutionPlan = {
    steps: [step('S1', 'material.protectFile', { filePath: '/a' })],
    supervisorPolicy: 'fail-fast',
  };
  const result = await runner.run(plan, ctx);
  expect(result.traceId).toBe('trace-custom-xyz');
  expect(result.runId).toMatch(/^run-/);
});

test('audit anchor success → anchored=true', async () => {
  const runner = makeRunner(false);
  const plan: ExecutionPlan = {
    steps: [step('S1', 'material.protectFile', { filePath: '/a' })],
    supervisorPolicy: 'fail-fast',
  };
  const result = await runner.run(plan, BASE_CTX);
  expect(result.anchored).toBe(true);
});

test('audit anchor failure → anchored=false but run succeeds', async () => {
  const runner = makeRunner(true);
  const plan: ExecutionPlan = {
    steps: [step('S1', 'material.protectFile', { filePath: '/a' })],
    supervisorPolicy: 'fail-fast',
  };
  const result = await runner.run(plan, BASE_CTX);
  expect(result.anchored).toBe(false);
  expect(result.succeeded).toBe(1);
});

test('dispatched=local when nodeId is explicitly local', async () => {
  const runner = makeRunner(); // empty nodeAddresses
  const plan: ExecutionPlan = {
    steps: [step('S1', 'material.protectFile', { filePath: '/a' })],
    supervisorPolicy: 'fail-fast',
  };
  const result = await runner.run(plan, BASE_CTX);
  expect(result.steps[0]?.dispatched).toBe('local');
});

// ── Remote dispatch integration tests ────────────────────────────────────────

const mockLLM: LLMClient = {
  complete: async () => ({ rawJson: { steps: [], supervisorPolicy: 'fail-fast' } }),
};
const mockAccounting: AccountingClient = {
  listNodeResources: async () => ({}),
  getNodeResources: async () => [],
  listNodes: async () => [],
};

let remoteServer: AgentServer;
let remotePort: number;

beforeAll(async () => {
  remotePort = 18200;
  const audit   = new AuditTrail(':memory:');
  const toolbox = new HiBAToolbox({ auditWriter: audit, permissions: ['material.write', 'material.read'] });
  toolbox.register(defineTool({
    name: 'material.protectFile',
    version: '1.0.0',
    tags: ['material', 'write'],
    description: 'protect (remote node)',
    inputSchema: z.object({ filePath: z.string() }),
    outputSchema: z.object({ txHash: z.string() }),
    permissions: ['material.write'],
    timeout: 5_000,
    handler: async input => ({ txHash: `remote:${input.filePath.length}` }),
  }));
  const planning = new NLPlanningService(mockLLM, mockAccounting);
  remoteServer = new AgentServer(planning, {
    port: remotePort,
    toolbox,
    defaultCtx: { hibaBaseUrl: 'http://localhost:9090', permissions: ['material.write', 'material.read'] },
  });
  await remoteServer.start();
});

afterAll(async () => {
  await remoteServer.stop();
});

describe('remote dispatch', () => {
  test('dispatched=remote when nodeId registered; result from remote server', async () => {
    const nodeAddresses = new Map([['node-remote', `http://localhost:${remotePort}`]]);
    const audits: AuditTrail[] = [];
    const runner = makeRunner(false, nodeAddresses, undefined, audits);
    const plan: ExecutionPlan = {
      steps: [{ stepId: 'S1', toolName: 'material.protectFile', nodeId: 'node-remote',
                version: '1.0.0', input: { filePath: '/remote.xml' }, dependsOn: [] }],
      supervisorPolicy: 'fail-fast',
    };
    const result = await runner.run(plan, BASE_CTX);
    expect(result.steps[0]?.dispatched).toBe('remote');
    expect(result.succeeded).toBe(1);
    const output = (result.steps[0]?.result as { success: true; output: { txHash: string } }).output;
    expect(output.txHash).toMatch(/^remote:/);
    const events = await audits[0]!.queryEvents({ eventType: 'DATA_TRANSFERRED' });
    expect(events).toEqual([expect.objectContaining({
      traceId: BASE_CTX.traceId,
      subjectId: result.runId,
      success: true,
      metadata: expect.objectContaining({ nodeId: 'node-remote', stepId: 'S1' }),
    })]);
  });

  test('remote node returns non-200 → ToolFailure with HANDLER_EXECUTION_FAILED', async () => {
    // Port with no server → connection refused
    const nodeAddresses = new Map([['node-dead', 'http://localhost:19999']]);
    const runner = makeRunner(false, nodeAddresses);
    const plan: ExecutionPlan = {
      steps: [{ stepId: 'S1', toolName: 'material.protectFile', nodeId: 'node-dead',
                version: '1.0.0', input: { filePath: '/x' }, dependsOn: [] }],
      supervisorPolicy: 'partial-success',
    };
    const result = await runner.run(plan, BASE_CTX);
    expect(result.steps[0]?.dispatched).toBe('remote');
    expect(result.failed).toBe(1);
    const failure = result.steps[0]?.result as { success: false; errorCode: string };
    expect(failure.errorCode).toBe('HANDLER_EXECUTION_FAILED');
  });

  test('rejects a successful remote response whose output violates ToolSpec', async () => {
    const invalidPort = 18201;
    const invalidNode = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, output: { txHash: 123 } }));
    });
    await new Promise<void>(resolve => invalidNode.listen(invalidPort, resolve));
    try {
      const runner = makeRunner(false, new Map([['node-invalid', `http://localhost:${invalidPort}`]]));
      const result = await runner.run({
        steps: [{ stepId: 'S1', toolName: 'material.protectFile', nodeId: 'node-invalid',
          version: '1.0.0', input: { filePath: '/x' }, dependsOn: [] }],
        supervisorPolicy: 'fail-fast',
      }, BASE_CTX);

      expect(result.failed).toBe(1);
      expect(result.steps[0]?.result).toEqual(expect.objectContaining({
        success: false,
        protocolVersion: '1.0',
        errorCode: 'OUTPUT_INVALID',
        retryable: false,
      }));
    } finally {
      await new Promise<void>((resolve, reject) => invalidNode.close(error => error ? reject(error) : resolve()));
    }
  });

  test('mixed local + remote in same plan', async () => {
    const nodeAddresses = new Map([['node-remote', `http://localhost:${remotePort}`]]);
    const runner = makeRunner(false, nodeAddresses);
    const plan: ExecutionPlan = {
      steps: [
        { stepId: 'S1', toolName: 'material.protectFile', nodeId: 'local',
          version: '1.0.0', input: { filePath: '/local.xml' }, dependsOn: [] },
        { stepId: 'S2', toolName: 'material.protectFile', nodeId: 'node-remote',
          version: '1.0.0', input: { filePath: '/remote.xml' }, dependsOn: ['S1'] },
      ],
      supervisorPolicy: 'fail-fast',
    };
    const result = await runner.run(plan, BASE_CTX);
    expect(result.succeeded).toBe(2);
    expect(result.steps.find(s => s.stepId === 'S1')?.dispatched).toBe('local');
    expect(result.steps.find(s => s.stepId === 'S2')?.dispatched).toBe('remote');
  });
});

// ── Dynamic node discovery ────────────────────────────────────────────────────

describe('dynamic node discovery', () => {
  let accountingServer: import('http').Server;
  let accountingPort: number;
  let registeredNodes: Array<{
    nodeId: string; agentUrl: string | null; status?: string;
    resources?: Array<{ name: string; version: string; type: string }>;
  }>;

  beforeAll(async () => {
    accountingPort = 18300;
    registeredNodes = [];
    accountingServer = (await import('node:http')).createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(registeredNodes));
    });
    await new Promise<void>(r => accountingServer.listen(accountingPort, r));
  });

  afterAll(async () => {
    await new Promise<void>((r, e) => accountingServer.close(err => (err ? e(err) : r())));
  });

  test('discovers remote node via accounting server', async () => {
    registeredNodes = [{
      nodeId: 'node-dynamic', agentUrl: `http://localhost:${remotePort}`, status: 'online',
      resources: [{ name: 'material.protectFile', version: '1.0.0', type: 'tool' }],
    }];
    const runner = makeRunner(false, new Map(), `http://localhost:${accountingPort}`);
    const plan: ExecutionPlan = {
      steps: [{ stepId: 'S1', toolName: 'material.protectFile', nodeId: 'node-dynamic',
                version: '1.0.0', input: { filePath: '/dyn.xml' }, dependsOn: [] }],
      supervisorPolicy: 'fail-fast',
    };
    const result = await runner.run(plan, BASE_CTX);
    expect(result.succeeded).toBe(1);
    expect(result.steps[0]?.dispatched).toBe('remote');
  });

  test('static address takes precedence over dynamic', async () => {
    // accounting server says node-1 → remotePort
    registeredNodes = [{ nodeId: 'node-1', agentUrl: `http://localhost:${remotePort}` }];
    // but static map says node-1 → dead port
    const staticAddresses = new Map([['node-1', 'http://localhost:19999']]);
    const runner = makeRunner(false, staticAddresses, `http://localhost:${accountingPort}`);
    const plan: ExecutionPlan = {
      steps: [{ stepId: 'S1', toolName: 'material.protectFile', nodeId: 'node-1',
                version: '1.0.0', input: { filePath: '/x' }, dependsOn: [] }],
      supervisorPolicy: 'partial-success',
    };
    const result = await runner.run(plan, BASE_CTX);
    // static (dead port) was used, so it fails — NOT the dynamic (live) port
    expect(result.failed).toBe(1);
    expect(result.steps[0]?.dispatched).toBe('remote');
  });

  test('accounting server unreachable → remote step fails closed', async () => {
    const runner = makeRunner(false, new Map(), 'http://localhost:19998');
    const plan: ExecutionPlan = {
      steps: [{ stepId: 'S1', toolName: 'material.protectFile', nodeId: 'node-fallback',
                version: '1.0.0', input: { filePath: '/fallback.xml' }, dependsOn: [] }],
      supervisorPolicy: 'fail-fast',
    };
    const result = await runner.run(plan, BASE_CTX);
    expect(result.steps[0]?.dispatched).toBe('remote');
    expect(result.failed).toBe(1);
  });

  test('accounting returns null agentUrl for node → remote step fails closed', async () => {
    registeredNodes = [{ nodeId: 'node-null-url', agentUrl: null }];
    const runner = makeRunner(false, new Map(), `http://localhost:${accountingPort}`);
    const plan: ExecutionPlan = {
      steps: [{ stepId: 'S1', toolName: 'material.protectFile', nodeId: 'node-null-url',
                version: '1.0.0', input: { filePath: '/null.xml' }, dependsOn: [] }],
      supervisorPolicy: 'fail-fast',
    };
    const result = await runner.run(plan, BASE_CTX);
    expect(result.steps[0]?.dispatched).toBe('remote');
    expect(result.failed).toBe(1);
  });
});

// ── parseNodeAddresses ────────────────────────────────────────────────────────

test('parseNodeAddresses: valid pairs', () => {
  const m = parseNodeAddresses('node-1=http://10.0.0.1:8090,node-2=http://10.0.0.2:8090');
  expect(m.get('node-1')).toBe('http://10.0.0.1:8090');
  expect(m.get('node-2')).toBe('http://10.0.0.2:8090');
  expect(m.size).toBe(2);
});

test('parseNodeAddresses: empty string → empty map', () => {
  expect(parseNodeAddresses('').size).toBe(0);
});

test('parseNodeAddresses: malformed pairs are skipped', () => {
  const m = parseNodeAddresses('bad,node-1=http://ok:8090,=nokey');
  expect(m.size).toBe(1);
  expect(m.get('node-1')).toBe('http://ok:8090');
});
