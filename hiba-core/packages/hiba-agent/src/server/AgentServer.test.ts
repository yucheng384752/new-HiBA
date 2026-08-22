/**
 * AgentServer.test.ts — HTTP endpoint unit tests
 *
 * Covers:
 *   GET    /health
 *   GET    /api/resources
 *   GET    /api/tools
 *   POST   /api/execute
 *   POST   /api/plan
 *   GET    /api/agents
 *   GET    /api/agents/:id
 *   POST   /api/agents
 *   DELETE /api/agents/:id
 *   POST   /api/intent
 *   POST   /api/run
 */

import { test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AgentServer } from './AgentServer';
import { HiBAToolbox } from '../core/HiBAToolbox';
import { AuditTrail } from '../audit/AuditTrail';
import { TrustRegistry } from '../trust/TrustRegistry';
import { OrchestratorRunner } from './OrchestratorRunner';
import { WorkflowStore } from './WorkflowStore';
import { defineTool } from '../core/defineTool';
import type { LLMClient, AccountingClient } from '../planning/NLPlanningService';
import { NLPlanningService } from '../planning/NLPlanningService';

// ── Helpers ───────────────────────────────────────────────────────────────────

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      { hostname: 'localhost', port, method, path,
        headers: { 'Content-Type': 'application/json', ...headers } },
      res => {
        let buf = '';
        res.on('data', c => { buf += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, body: buf ? JSON.parse(buf) : {} }); }
          catch { resolve({ status: res.statusCode ?? 0, body: buf }); }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockLLM: LLMClient = {
  complete: async payload => ({
    rawJson: payload.systemPrompt ? {
      summary: 'CNC-01 機台目前運行中。',
      steps: [{ stepId: 'S1', summary: '查詢成功。' }],
    } : {
      steps: [{
        stepId: 'S1',
        toolName: 'material.protectFile',
        nodeId: 'node1',
        version: '1.0.0',
        input: { filePath: '/tmp/test.xml' },
        dependsOn: [],
      }],
      supervisorPolicy: 'fail-fast',
    },
  }),
};

const mockAccounting: AccountingClient = {
  listNodeResources: async () => ({
    'node-1': [{ name: 'cut.sh', type: 'script', version: '1.0.0' }],
  }),
  getNodeResources: async (nodeId) => (nodeId === 'node-1'
    ? [{ name: 'cut.sh', type: 'script', version: '1.0.0' }]
    : []),
  listNodes: async () => [{
    protocolVersion: '1.0',
    nodeId: 'node-1',
    agentUrl: 'http://node-1',
    status: 'online',
    canInstall: false,
    resources: [{ name: 'material.protectFile', type: 'tool', version: '1.0.0' }],
    registeredAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
  }],
};

function makeToolbox() {
  const audit = new AuditTrail(':memory:');
  const toolbox = new HiBAToolbox({
    auditWriter: audit,
    permissions: ['material.write', 'material.read'],
  });
  toolbox.register(defineTool({
    name: 'material.protectFile',
    version: '1.0.0',
    tags: ['material', 'write'],
    description: '將檔案上鏈保護',
    inputSchema: z.object({
      filePath: z.string(),
      keepFile: z.boolean().default(true),
    }),
    outputSchema: z.object({ success: z.boolean(), txHash: z.string() }),
    permissions: ['material.write'],
    timeout: 5_000,
    handler: async (input) => ({
      success: true,
      txHash: `0x${Buffer.from(input.filePath).toString('hex').slice(0, 40)}`,
    }),
  }));
  return { toolbox, audit };
}

// ── Test suite ─────────────────────────────────────────────────────────────────

let server: AgentServer;
let port: number;
let registry: TrustRegistry;

beforeAll(async () => {
  port = 18090; // avoid conflict with real server
  const planning = new NLPlanningService(mockLLM, mockAccounting);
  const { toolbox, audit } = makeToolbox();
  registry = new TrustRegistry(':memory:');
  const orchestrator = new OrchestratorRunner(toolbox, audit);
  const workflowStore = new WorkflowStore(':memory:');
  server = new AgentServer(planning, {
    port,
    toolbox,
    registry,
    orchestrator,
    workflowStore,
    auditTrail: audit,
    defaultCtx: {
      hibaBaseUrl: 'http://localhost:8092',
      permissions: ['material.write', 'material.read'],
    },
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

// ── /health ────────────────────────────────────────────────────────────────────

test('GET /health returns 200', async () => {
  const res = await request(port, 'GET', '/health');
  expect(res.status).toBe(200);
  expect((res.body as { status: string }).status).toBe('ok');
});

// ── /api/resources ─────────────────────────────────────────────────────────────

test('GET /api/resources proxies accounting client', async () => {
  const res = await request(port, 'GET', '/api/resources');
  expect(res.status).toBe(200);
  const body = res.body as Record<string, unknown[]>;
  expect(body['node-1']).toBeDefined();
  expect(Array.isArray(body['node-1'])).toBe(true);
});

test('POST /api/update writes update payload and rejects path traversal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hiba-update-'));
  const oldDir = process.env['HIBA_UPDATE_DIR'];
  process.env['HIBA_UPDATE_DIR'] = dir;
  try {
    const ok = await request(port, 'POST', '/api/update', {
      fileName: 'patch.txt',
      content: 'hello node',
    });
    expect(ok.status).toBe(200);
    expect(await readFile(join(dir, 'patch.txt'), 'utf8')).toBe('hello node');

    const bad = await request(port, 'POST', '/api/update', {
      fileName: '../patch.txt',
      content: 'nope',
    });
    expect(bad.status).toBe(400);
  } finally {
    if (oldDir === undefined) delete process.env['HIBA_UPDATE_DIR'];
    else process.env['HIBA_UPDATE_DIR'] = oldDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test('POST /api/blockchain/protect stores file metadata and returns txHash', async () => {
  const res = await request(port, 'POST', '/api/blockchain/protect', {
    filePath: '/opt/models/model-a.xml',
    metadata: { uploader: 'agent-test' },
  }, {
    'X-Trace-Id': 'trace-blockchain-001',
  });
  expect(res.status).toBe(200);
  const body = res.body as {
    success: boolean; txHash: string; fileHash: string; blockHash: string; mode: string;
  };
  expect(body.success).toBe(true);
  expect(body.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(body.fileHash).toMatch(/^[0-9a-f]{64}$/);
  expect(body.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(body.mode).toBe('mock');
});

test('POST /api/blockchain/verify validates a protected file', async () => {
  const protect = await request(port, 'POST', '/api/blockchain/protect', {
    filePath: '/opt/models/model-b.xml',
  });
  const protectedBody = protect.body as { fileHash: string; txHash: string };

  const verify = await request(port, 'POST', '/api/blockchain/verify', {
    filePath: '/opt/models/model-b.xml',
    expectedHash: protectedBody.fileHash,
  });
  expect(verify.status).toBe(200);
  const body = verify.body as { valid: boolean; txHash: string };
  expect(body.valid).toBe(true);
  expect(body.txHash).toBe(protectedBody.txHash);
});

test('POST /api/audit/anchor returns txHash-compatible anchor response', async () => {
  const res = await request(port, 'POST', '/api/audit/anchor', {
    records: [{ auditHash: 'abc', traceId: 'trace-anchor-001' }],
  }, {
    'X-Trace-Id': 'trace-anchor-001',
  });
  expect(res.status).toBe(200);
  const body = res.body as { anchored: number; txHash: string; blockHash: string; mode: string };
  expect(body.anchored).toBe(1);
  expect(body.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(body.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(body.mode).toBe('mock');
});

// ── /api/tools ─────────────────────────────────────────────────────────────────

test('GET /api/tools returns registered tool metadata', async () => {
  const res = await request(port, 'GET', '/api/tools');
  expect(res.status).toBe(200);
  const tools = res.body as Array<{
    protocolVersion: string; name: string; version: string; tags: string[];
    permissions: string[]; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>;
  }>;
  expect(Array.isArray(tools)).toBe(true);
  expect(tools.length).toBe(1);
  expect(tools[0]?.name).toBe('material.protectFile');
  expect(tools[0]?.protocolVersion).toBe('1.0');
  expect(tools[0]?.inputSchema).toEqual(expect.objectContaining({ type: 'object', required: ['filePath'] }));
  expect(tools[0]?.outputSchema).toEqual(expect.objectContaining({ type: 'object' }));
  expect(tools[0]?.tags).toContain('material');
  expect(tools[0]?.permissions).toContain('material.write');
});

test('GET /api/tools without toolbox returns 503', async () => {
  const noToolboxServer = new AgentServer(
    new NLPlanningService(mockLLM, mockAccounting),
    { port: 18091 },
  );
  await noToolboxServer.start();
  try {
    const res = await request(18091, 'GET', '/api/tools');
    expect(res.status).toBe(503);
  } finally {
    await noToolboxServer.stop();
  }
});

// ── /api/execute ───────────────────────────────────────────────────────────────

test('POST /api/execute with valid input returns success', async () => {
  const res = await request(port, 'POST', '/api/execute', {
    toolName: 'material.protectFile',
    input: { filePath: '/opt/models/test.xml' },
  }, {
    'X-Agent-Id': 'test-agent',
    'X-Trace-Id': 'trace-execute-001',
  });
  expect(res.status).toBe(200);
  const body = res.body as { success: boolean; output: { txHash: string } };
  expect(body.success).toBe(true);
  expect(body.output.txHash).toMatch(/^0x/);
});

test('POST /api/execute with invalid schema returns 422', async () => {
  const res = await request(port, 'POST', '/api/execute', {
    toolName: 'material.protectFile',
    input: { filePath: 123 }, // wrong type
  });
  expect(res.status).toBe(422);
  const body = res.body as { success: boolean; errorCode: string };
  expect(body.success).toBe(false);
  expect(body.errorCode).toBe('SCHEMA_VALIDATION_ERROR');
});

test('POST /api/execute unknown tool returns 422', async () => {
  const res = await request(port, 'POST', '/api/execute', {
    toolName: 'material.nonExistent',
    input: {},
  });
  expect(res.status).toBe(422);
  const body = res.body as { success: boolean; errorCode: string };
  expect(body.success).toBe(false);
  expect(body.errorCode).toBe('TOOL_NOT_FOUND');
});

test('POST /api/execute missing toolName returns 400', async () => {
  const res = await request(port, 'POST', '/api/execute', { input: {} });
  expect(res.status).toBe(400);
});

// ── /api/plan ──────────────────────────────────────────────────────────────────

test('POST /api/plan with valid task returns ExecutionPlan', async () => {
  const res = await request(port, 'POST', '/api/plan', {
    task: '把模型上鏈保護',
  });
  expect(res.status).toBe(200);
  const plan = res.body as { steps: unknown[]; supervisorPolicy: string };
  expect(plan.supervisorPolicy).toBe('fail-fast');
  expect(Array.isArray(plan.steps)).toBe(true);
  expect(plan.steps.length).toBe(1);
});

test('POST /api/plan without task returns 400', async () => {
  const res = await request(port, 'POST', '/api/plan', {});
  expect(res.status).toBe(400);
  expect(res.body).toEqual(expect.objectContaining({
    success: false,
    protocolVersion: '1.0',
    errorCode: 'REQUEST_INVALID',
    retryable: false,
  }));
});

test('POST /api/summarize returns validated natural-language result', async () => {
  const res = await request(port, 'POST', '/api/summarize', {
    task: '確認 m2 的 CNC-01 機台狀態',
    run: { steps: [{ stepId: 'S1', result: { success: true } }] },
  });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    summary: 'CNC-01 機台目前運行中。',
    steps: [{ stepId: 'S1', summary: '查詢成功。' }],
  });
});

test('POST /api/summarize requires task and run', async () => {
  expect((await request(port, 'POST', '/api/summarize', { task: 'x' })).status).toBe(400);
});

test('persistent workflow closes plan, run, poll, and result loop', async () => {
  const planned = await request(port, 'POST', '/api/plan', { task: 'protect a file' });
  const workflowId = (planned.body as { workflowId: string }).workflowId;
  expect(workflowId).toMatch(/^wf-/);

  const beforeApproval = await request(port, 'POST', `/api/workflows/${workflowId}/run`, {});
  expect(beforeApproval.status).toBe(409);

  const approval = await request(port, 'POST', `/api/workflows/${workflowId}/approve`, {
    plan: {
      steps: [{
        stepId: 'S1', toolName: 'material.protectFile', nodeId: 'local', version: '1.0.0',
        input: { filePath: '/opt/persistent.xml' }, dependsOn: [],
      }],
      supervisorPolicy: 'fail-fast',
    },
  }, {
    'X-User-Id': 'user-approver-1',
  });
  expect(approval.status).toBe(200);
  expect(approval.body).toEqual(expect.objectContaining({
    workflowId,
    status: 'approved',
    approvedBy: 'user-approver-1',
    eventHash: expect.stringMatching(/^[0-9a-f]{64}$/),
  }));

  const events = await request(port, 'GET', `/api/audit/events?subjectId=${workflowId}`);
  expect(events.status).toBe(200);
  expect((events.body as Array<{ eventType: string; integrityValid: boolean }>).every(event => event.integrityValid)).toBe(true);
  expect((events.body as Array<{ eventType: string }>).map(event => event.eventType)).toEqual([
    'WORKFLOW_CREATED',
    'WORKFLOW_APPROVED',
  ]);

  const run = await request(port, 'POST', `/api/workflows/${workflowId}/run`, {});
  expect(run.status).toBe(202);

  let workflow: { status: string; result?: { succeeded: number } | null } | undefined;
  for (let i = 0; i < 50; i++) {
    const response = await request(port, 'GET', `/api/workflows/${workflowId}`);
    workflow = response.body as typeof workflow;
    if (workflow && ['succeeded', 'failed', 'partial_success'].includes(workflow.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(workflow?.status).toBe('succeeded');
  expect(workflow?.result?.succeeded).toBe(1);
});

// ── /api/agents ────────────────────────────────────────────────────────────────

test('GET /api/agents returns empty list initially', async () => {
  const res = await request(port, 'GET', '/api/agents');
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
  expect((res.body as unknown[]).length).toBe(0);
});

test('POST /api/agents registers agent and GET retrieves it', async () => {
  const payload = {
    agentId:      'agent-test-001',
    role:         'domain',
    permissions:  ['material.read'],
    publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMIIB...\n-----END PUBLIC KEY-----',
  };
  const createRes = await request(port, 'POST', '/api/agents', payload);
  expect(createRes.status).toBe(201);
  expect((createRes.body as { status: string }).status).toBe('registered');

  const getRes = await request(port, 'GET', `/api/agents/${payload.agentId}`);
  expect(getRes.status).toBe(200);
  const agent = getRes.body as { agentId: string; role: string; status: string };
  expect(agent.agentId).toBe(payload.agentId);
  expect(agent.role).toBe('domain');
  expect(agent.status).toBe('active');
});

test('POST /api/agents missing required fields returns 400', async () => {
  const res = await request(port, 'POST', '/api/agents', { agentId: 'x' });
  expect(res.status).toBe(400);
});

test('GET /api/agents/:id not found returns 404', async () => {
  const res = await request(port, 'GET', '/api/agents/nonexistent-agent');
  expect(res.status).toBe(404);
});

test('DELETE /api/agents/:id revokes and GET returns status=revoked', async () => {
  await request(port, 'POST', '/api/agents', {
    agentId:      'agent-to-revoke',
    role:         'training',
    permissions:  [],
    publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMIIB...\n-----END PUBLIC KEY-----',
  });

  const delRes = await request(port, 'DELETE', '/api/agents/agent-to-revoke');
  expect(delRes.status).toBe(200);
  expect((delRes.body as { status: string }).status).toBe('revoked');

  // revoked agent should still be retrievable with status=revoked
  const getRes = await request(port, 'GET', '/api/agents/agent-to-revoke');
  expect(getRes.status).toBe(200);
  expect((getRes.body as { status: string }).status).toBe('revoked');
});

test('DELETE /api/agents/:id not found returns 404', async () => {
  const res = await request(port, 'DELETE', '/api/agents/no-such-agent');
  expect(res.status).toBe(404);
});

test('GET /api/agents without registry returns 503', async () => {
  const noRegistryServer = new AgentServer(
    new NLPlanningService(mockLLM, mockAccounting),
    { port: 18092 },
  );
  await noRegistryServer.start();
  try {
    const res = await request(18092, 'GET', '/api/agents');
    expect(res.status).toBe(503);
  } finally {
    await noRegistryServer.stop();
  }
});

// ── /api/intent ────────────────────────────────────────────────────────────────

test('POST /api/intent with known keyword returns intent', async () => {
  const res = await request(port, 'POST', '/api/intent', { text: '切割 鋁合金板' });
  expect(res.status).toBe(200);
  const body = res.body as {
    intentClass: string; keywords: string[];
    mentionedNodes: string[]; confidence: number; canHandle: boolean;
  };
  expect(body.intentClass).toBe('cut');
  expect(body.confidence).toBeGreaterThan(0);
});

test('POST /api/intent matching resource names populates mentionedNodes', async () => {
  // mockAccounting has node-1 with cut.sh
  const res = await request(port, 'POST', '/api/intent', { text: '請用 cut.sh 處理' });
  expect(res.status).toBe(200);
  const body = res.body as { mentionedNodes: string[]; canHandle: boolean };
  expect(body.mentionedNodes).toContain('node-1');
  expect(body.canHandle).toBe(true);
});

test('POST /api/intent unknown text returns unknown intent', async () => {
  const res = await request(port, 'POST', '/api/intent', { text: '完全無關的文字' });
  expect(res.status).toBe(200);
  const body = res.body as { intentClass: string; canHandle: boolean };
  expect(body.intentClass).toBe('unknown');
  expect(body.canHandle).toBe(false);
});

test('POST /api/intent missing text returns 400', async () => {
  const res = await request(port, 'POST', '/api/intent', {});
  expect(res.status).toBe(400);
});

// ── /api/run ───────────────────────────────────────────────────────────────────

function planStep(
  stepId: string,
  toolName: string,
  input: Record<string, unknown> = {},
  dependsOn: string[] = [],
) {
  return { stepId, toolName, nodeId: 'local', version: '1.0.0', input, dependsOn };
}

test('POST /api/run all steps succeed → 200, succeeded=1', async () => {
  const res = await request(port, 'POST', '/api/run', {
    plan: {
      steps: [planStep('S1', 'material.protectFile', { filePath: '/opt/test.xml' })],
      supervisorPolicy: 'fail-fast',
    },
  });
  expect(res.status).toBe(200);
  const body = res.body as { succeeded: number; failed: number; anchored: boolean };
  expect(body.succeeded).toBe(1);
  expect(body.failed).toBe(0);
});

test('POST /api/run fail-fast: step fails → 422', async () => {
  const res = await request(port, 'POST', '/api/run', {
    plan: {
      steps: [planStep('S1', 'material.nonExistentTool', {})],
      supervisorPolicy: 'fail-fast',
    },
  });
  expect(res.status).toBe(422);
  const body = res.body as { failed: number; succeeded: number };
  expect(body.failed).toBe(1);
  expect(body.succeeded).toBe(0);
});

test('POST /api/run partial-success: failed step → 200, failed>0 in body', async () => {
  const res = await request(port, 'POST', '/api/run', {
    plan: {
      steps: [
        planStep('S1', 'material.nonExistentTool', {}),
        planStep('S2', 'material.protectFile', { filePath: '/ok.xml' }),
      ],
      supervisorPolicy: 'partial-success',
    },
  });
  expect(res.status).toBe(200);
  const body = res.body as { failed: number; succeeded: number };
  expect(body.failed).toBe(1);
  expect(body.succeeded).toBe(1);
});

test('POST /api/run sequential S1→S2: both succeed', async () => {
  const res = await request(port, 'POST', '/api/run', {
    plan: {
      steps: [
        planStep('S1', 'material.protectFile', { filePath: '/a.xml' }),
        planStep('S2', 'material.protectFile', { filePath: '/b.xml' }, ['S1']),
      ],
      supervisorPolicy: 'fail-fast',
    },
  });
  expect(res.status).toBe(200);
  const body = res.body as { succeeded: number; steps: Array<{ stepId: string }> };
  expect(body.succeeded).toBe(2);
  expect(body.steps[0]?.stepId).toBe('S1');
  expect(body.steps[1]?.stepId).toBe('S2');
});

test('POST /api/run missing plan returns 400', async () => {
  const res = await request(port, 'POST', '/api/run', {});
  expect(res.status).toBe(400);
});

test('POST /api/run without orchestrator returns 503', async () => {
  const noOrchServer = new AgentServer(
    new NLPlanningService(mockLLM, mockAccounting),
    { port: 18093 },
  );
  await noOrchServer.start();
  try {
    const res = await request(18093, 'POST', '/api/run', {
      plan: { steps: [], supervisorPolicy: 'fail-fast' },
    });
    expect(res.status).toBe(503);
  } finally {
    await noOrchServer.stop();
  }
});
