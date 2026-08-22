import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  NLPlanningService,
  type LLMClient,
  type AccountingClient,
  type NodeResourceMap,
} from './NLPlanningService';
import { z } from 'zod';
import { defineTool } from '../core/defineTool';
import { HIBA_PROTOCOL_VERSION } from '../types/hiba.types';
import type { NodeDescriptor, ToolContext } from '../types/hiba.types';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const ctx: ToolContext = {
  agentId:     'orchestrator-001',
  traceId:     'trace-plan-001',
  depth:       0,
  hibaBaseUrl: 'http://localhost:8092',
  permissions: ['material.write'],
};

const mockResources: NodeResourceMap = {
  node1: [{ name: 'material.protectFile', type: 'tool', version: '1.0.0' }],
  node8: [{ name: 'model_111_211', type: 'model', version: '2.0.0' }],
};

const mockNodes: NodeDescriptor[] = Object.entries(mockResources).map(([nodeId, resources]) => ({
  protocolVersion: HIBA_PROTOCOL_VERSION,
  nodeId,
  agentUrl: `http://${nodeId}`,
  status: 'online',
  canInstall: false,
  resources,
  registeredAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
}));

const protectFileTool = defineTool({
  name: 'material.protectFile',
  version: '1.0.0',
  tags: ['material', 'write'],
  description: 'Protect file',
  inputSchema: z.object({ filePath: z.string() }),
  outputSchema: z.object({ ok: z.boolean() }),
  permissions: ['material.write'],
  timeout: 1_000,
  handler: async () => ({ ok: true }),
});

const validPlanJson = {
  steps: [
    {
      stepId:    'S1',
      toolName:  'material.protectFile',
      nodeId:    'node1',
      version:   '1.0.0',
      input:     { filePath: '/opt/models/model_121_321.xml' },
      dependsOn: [],
    },
  ],
  supervisorPolicy: 'fail-fast',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLLM(rawJson: unknown): jest.Mocked<LLMClient> {
  return { complete: jest.fn<LLMClient['complete']>().mockResolvedValue({ rawJson }) };
}

function makeAccounting(resources: NodeResourceMap = mockResources): jest.Mocked<AccountingClient> {
  return {
    listNodeResources: jest.fn<AccountingClient['listNodeResources']>().mockResolvedValue(resources),
    getNodeResources:  jest.fn<AccountingClient['getNodeResources']>().mockResolvedValue([]),
    listNodes: jest.fn<AccountingClient['listNodes']>().mockResolvedValue(mockNodes),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('NLPlanningService', () => {
  it('returns a valid ExecutionPlan when LLM produces correct JSON', async () => {
    const llm        = makeLLM(validPlanJson);
    const accounting = makeAccounting();
    const svc        = new NLPlanningService(llm, accounting);

    const plan = await svc.plan('取得 node1 上的模型並保護', ctx);

    expect(plan.error).toBeUndefined();
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.stepId).toBe('S1');
    expect(plan.steps[0]!.toolName).toBe('material.protectFile');
    expect(plan.steps[0]!.nodeId).toBe('node1');
  });

  it('passes task + resources to LLM', async () => {
    const llm = makeLLM(validPlanJson);
    const svc = new NLPlanningService(llm, makeAccounting());

    await svc.plan('test task', ctx);

    expect(llm.complete).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'test task', resources: mockResources }),
    );
  });

  it('includes complete ToolSpec in LLM payload when toolbox is provided', async () => {
    const llm = makeLLM(validPlanJson);
    const svc = new NLPlanningService(llm, makeAccounting(), {
      toolbox: { list: () => [protectFileTool] },
    });

    await svc.plan('task', ctx);

    expect(llm.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: mockNodes,
        tools: [expect.objectContaining({
          protocolVersion: HIBA_PROTOCOL_VERSION,
          name: 'material.protectFile',
          inputSchema: expect.objectContaining({ type: 'object' }),
        })],
      }),
    );
  });

  it('returns structured missingInputs when deterministic validation rejects a plan', async () => {
    const invalidInputPlan = {
      ...validPlanJson,
      steps: [{ ...validPlanJson.steps[0], input: {} }],
    };
    const svc = new NLPlanningService(makeLLM(invalidInputPlan), makeAccounting(), {
      toolbox: { list: () => [protectFileTool] },
    });

    const plan = await svc.plan('protect a file', ctx);

    expect(plan.steps).toHaveLength(1);
    expect(plan.error).toBeUndefined();
    expect(plan.validationIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INPUT_REQUIRED', field: 'filePath' }),
    ]));
    expect(plan.missingInputs).toEqual([
      { stepId: 'S1', toolName: 'material.protectFile', fields: ['filePath'] },
    ]);
  });

  it('returns error plan when LLM output is not a valid ExecutionPlan shape', async () => {
    const svc = new NLPlanningService(makeLLM({ invalid: 'not a plan' }), makeAccounting());

    const plan = await svc.plan('do something', ctx);

    expect(plan.steps).toHaveLength(0);
    expect(plan.error).toMatch(/Plan parse failed/);
  });

  it('returns error plan when LLM returns a non-JSON string', async () => {
    const svc = new NLPlanningService(makeLLM('sorry, cannot help'), makeAccounting());

    const plan = await svc.plan('task', ctx);

    expect(plan.steps).toHaveLength(0);
    expect(plan.error).toBeDefined();
  });

  it('rejects a plan with an unknown dependency before execution', async () => {
    const svc = new NLPlanningService(makeLLM({
      steps: [{
        stepId: 'S1', toolName: 'material.readFile', nodeId: 'node1',
        version: '1.0.0', input: {}, dependsOn: ['missing'],
      }],
      supervisorPolicy: 'fail-fast',
    }), makeAccounting());

    const plan = await svc.plan('task', ctx);

    expect(plan.steps).toHaveLength(0);
    expect(plan.error).toContain('Unknown dependency');
  });

  it('uses configured supervisorPolicy as fallback in error plan', async () => {
    const svc = new NLPlanningService(
      makeLLM('bad'),
      makeAccounting(),
      { supervisorPolicy: 'partial-success' },
    );

    const plan = await svc.plan('task', ctx);

    expect(plan.supervisorPolicy).toBe('partial-success');
  });

  it('propagates accounting server errors without swallowing', async () => {
    const accounting: AccountingClient = {
      listNodeResources: jest.fn<AccountingClient['listNodeResources']>()
        .mockRejectedValue(new Error('accounting timeout')),
      getNodeResources: jest.fn<AccountingClient['getNodeResources']>().mockResolvedValue([]),
      listNodes: jest.fn<AccountingClient['listNodes']>().mockResolvedValue(mockNodes),
    };

    await expect(
      new NLPlanningService(makeLLM({}), accounting).plan('task', ctx),
    ).rejects.toThrow('accounting timeout');
  });

  it('getResources() delegates to accounting client', async () => {
    const accounting = makeAccounting();
    const svc        = new NLPlanningService(makeLLM({}), accounting);

    const result = await svc.getResources();

    expect(result).toEqual(mockResources);
    expect(accounting.listNodeResources).toHaveBeenCalledTimes(1);
  });

  it('normalizes sequential intent and removes unknown tool input fields', async () => {
    const rawPlan = {
      ...validPlanJson,
      steps: [
        validPlanJson.steps[0],
        {
          ...validPlanJson.steps[0], stepId: 'S2',
          input: { filePath: '/tmp/second.xml', supervisorPolicy: 'fail-fast' },
        },
      ],
    };
    const svc = new NLPlanningService(makeLLM(rawPlan), makeAccounting(), {
      toolbox: { list: () => [protectFileTool] },
    });

    const plan = await svc.plan('先處理第一項，然後接續處理第二項', ctx);

    expect(plan.steps[1]!.dependsOn).toEqual(['S1']);
    expect(plan.steps[1]!.input).toEqual({ filePath: '/tmp/second.xml' });
  });

  it('fills default version "1.0.0" when LLM omits it', async () => {
    const planWithoutVersion = {
      steps: [
        {
          stepId: 'S1',
          toolName: 'material.readFile',
          nodeId: 'node1',
          input: {},
          dependsOn: [],
          // version omitted intentionally
        },
      ],
      supervisorPolicy: 'fail-fast',
    };
    const svc = new NLPlanningService(makeLLM(planWithoutVersion), makeAccounting());

    const plan = await svc.plan('task', ctx);

    expect(plan.error).toBeUndefined();
    expect(plan.steps[0]!.version).toBe('1.0.0');
  });
});
