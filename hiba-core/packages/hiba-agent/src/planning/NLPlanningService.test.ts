import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  NLPlanningService,
  type LLMClient,
  type AccountingClient,
  type NodeResourceMap,
} from './NLPlanningService';
import type { ToolContext } from '../types/hiba.types';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const ctx: ToolContext = {
  agentId:     'orchestrator-001',
  traceId:     'trace-plan-001',
  depth:       0,
  hibaBaseUrl: 'http://localhost:8092',
  permissions: ['material.write'],
};

const mockResources: NodeResourceMap = {
  node1: [{ name: 'model_121_321', type: 'model', version: '1.0.0' }],
  node8: [{ name: 'model_111_211', type: 'model', version: '2.0.0' }],
};

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

  it('includes toolbox tool names in LLM payload when toolbox is provided', async () => {
    const llm = makeLLM(validPlanJson);
    const svc = new NLPlanningService(llm, makeAccounting(), {
      toolbox: { list: () => [{ name: 'material.protectFile' }, { name: 'material.readFile' }] },
    });

    await svc.plan('task', ctx);

    expect(llm.complete).toHaveBeenCalledWith(
      expect.objectContaining({ availableTools: ['material.protectFile', 'material.readFile'] }),
    );
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
