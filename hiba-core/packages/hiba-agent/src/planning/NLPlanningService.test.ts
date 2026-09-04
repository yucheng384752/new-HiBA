import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  NLPlanningService,
  resolveNodeRouting,
  type LLMClient,
  type AccountingClient,
  type NodeResourceMap,
} from './NLPlanningService';
import { z } from 'zod';
import { defineTool } from '../core/defineTool';
import { HIBA_PROTOCOL_VERSION } from '../types/hiba.types';
import type { NodeDescriptor, PlanStep, ToolContext } from '../types/hiba.types';

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
  const nodes = Object.entries(resources).map(([nodeId, nodeResources]) => ({
    ...mockNodes[0]!, nodeId, agentUrl: `http://${nodeId}`, resources: nodeResources,
  }));
  return makeAccountingWithNodes(resources, nodes);
}

// Like makeAccounting(), but lets a test set node status/canInstall explicitly
// instead of always defaulting to online — needed to exercise
// resolveNodeRouting's offline/no-capable-node/canInstall branches.
function makeAccountingWithNodes(resources: NodeResourceMap, nodes: NodeDescriptor[]): jest.Mocked<AccountingClient> {
  return {
    listNodeResources: jest.fn<AccountingClient['listNodeResources']>().mockResolvedValue(resources),
    getNodeResources:  jest.fn<AccountingClient['getNodeResources']>().mockResolvedValue([]),
    listNodes: jest.fn<AccountingClient['listNodes']>().mockResolvedValue(nodes),
    listFacilitiesForNodes: jest.fn<AccountingClient['listFacilitiesForNodes']>().mockResolvedValue([]),
    getFacility: jest.fn<AccountingClient['getFacility']>().mockRejectedValue(new Error('not used in this test')),
    suggestFacilityEdge: jest.fn<AccountingClient['suggestFacilityEdge']>().mockRejectedValue(new Error('not used in this test')),
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

  it('retries once with a correction when the LLM hallucinates a tool name not in the catalog', async () => {
    const hallucinatedPlan = {
      steps: [{
        stepId: 'S1', toolName: 'material.doesNotExist', nodeId: 'node1',
        version: '1.0.0', input: { filePath: '/opt/models/model.xml' }, dependsOn: [],
      }],
      supervisorPolicy: 'fail-fast',
    };
    const llm = {
      complete: jest.fn<LLMClient['complete']>()
        .mockResolvedValueOnce({ rawJson: hallucinatedPlan })
        .mockResolvedValueOnce({ rawJson: validPlanJson }),
    };
    const svc = new NLPlanningService(llm, makeAccounting(), {
      toolbox: { list: () => [protectFileTool] },
    });

    const plan = await svc.plan('protect a file', ctx);

    expect(llm.complete).toHaveBeenCalledTimes(2);
    const secondCallTask = llm.complete.mock.calls[1]![0].task;
    expect(secondCallTask).toContain('material.doesNotExist');
    expect(plan.error).toBeUndefined();
    expect(plan.steps).toEqual([expect.objectContaining({ toolName: 'material.protectFile' })]);
  });

  it('surfaces a validation error when the retry still hallucinates a tool name', async () => {
    const hallucinatedPlan = {
      steps: [{
        stepId: 'S1', toolName: 'material.doesNotExist', nodeId: 'node1',
        version: '1.0.0', input: { filePath: '/opt/models/model.xml' }, dependsOn: [],
      }],
      supervisorPolicy: 'fail-fast',
    };
    const llm = makeLLM(hallucinatedPlan); // every call returns the same hallucinated plan
    const svc = new NLPlanningService(llm, makeAccounting(), {
      toolbox: { list: () => [protectFileTool] },
    });

    const plan = await svc.plan('protect a file', ctx);

    expect(llm.complete).toHaveBeenCalledTimes(2); // one retry, then gives up
    expect(plan.steps).toHaveLength(0);
    expect(plan.error).toMatch(/Plan validation failed/);
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
      listFacilitiesForNodes: jest.fn<AccountingClient['listFacilitiesForNodes']>().mockResolvedValue([]),
      getFacility: jest.fn<AccountingClient['getFacility']>().mockRejectedValue(new Error('not used in this test')),
      suggestFacilityEdge: jest.fn<AccountingClient['suggestFacilityEdge']>().mockRejectedValue(new Error('not used in this test')),
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

  it('hides meta-tools marked plannerVisible=false from LLM planning context', async () => {
    const visible = mockResources.node1![0]!;
    const hidden = {
      name: 'orchestrator.createTaskChain', type: 'tool', version: '1.0.0',
      metadata: { plannerVisible: false },
    };
    const llm = makeLLM(validPlanJson);
    const svc = new NLPlanningService(llm, makeAccounting({ node1: [visible, hidden] }));

    await svc.plan('test task', ctx);

    expect(llm.complete).toHaveBeenCalledWith(expect.objectContaining({
      resources: { node1: [visible] },
      nodes: [expect.objectContaining({ resources: [visible] })],
    }));
  });

  describe('resolveNodeRouting (nodeId correction inside plan())', () => {
    // hiba-planner has been observed (see
    // .codex-claude-mailbox/threads/20260903-plan-local-tool-routing.md) to
    // copy a worked-example literal like "node1" verbatim even when no real
    // node is named that, instead of routing to a genuine local-only tool.
    // These tests exercise the deterministic correction that stands in for
    // the prompt-side fix that turned out to overflow the deployed model's
    // context window.
    const hallucinatedNodePlan = {
      steps: [{
        stepId: 'S1', toolName: 'material.protectFile', nodeId: 'node1',
        version: '1.0.0', input: { filePath: '/tmp/report.xml' }, dependsOn: [],
      }],
      supervisorPolicy: 'fail-fast',
    };

    it('routes to "local" when no real/online node matches and the tool is registered locally', async () => {
      // "node1" here is NOT a real node in this fixture (contrast with the
      // top-of-file mockNodes, where node1 IS real) — every real node is
      // offline and none advertise material.protectFile.
      const nodes: NodeDescriptor[] = [
        { ...mockNodes[0]!, nodeId: 'node-1', status: 'offline', resources: [] },
      ];
      const svc = new NLPlanningService(makeLLM(hallucinatedNodePlan), makeAccountingWithNodes({}, nodes), {
        toolbox: { list: () => [protectFileTool] },
      });

      const plan = await svc.plan('保護這個檔案', ctx);

      expect(plan.error).toBeUndefined();
      expect(plan.steps[0]!.nodeId).toBe('local');
    });

    it('routes to a real online capable node instead of "local" when one exists', async () => {
      const nodes: NodeDescriptor[] = [
        {
          ...mockNodes[0]!, nodeId: 'node-2', status: 'online', canInstall: false,
          resources: [{ name: 'material.protectFile', type: 'tool', version: '1.0.0' }],
        },
      ];
      const svc = new NLPlanningService(makeLLM(hallucinatedNodePlan), makeAccountingWithNodes({}, nodes), {
        toolbox: { list: () => [protectFileTool] },
      });

      const plan = await svc.plan('保護這個檔案', ctx);

      expect(plan.steps[0]!.nodeId).toBe('node-2');
    });

    it('routes to a real online canInstall node when no node advertises the tool directly', async () => {
      const nodes: NodeDescriptor[] = [
        { ...mockNodes[0]!, nodeId: 'node-3', status: 'online', canInstall: true, resources: [] },
      ];
      const svc = new NLPlanningService(makeLLM(hallucinatedNodePlan), makeAccountingWithNodes({}, nodes), {
        toolbox: { list: () => [protectFileTool] },
      });

      const plan = await svc.plan('保護這個檔案', ctx);

      expect(plan.steps[0]!.nodeId).toBe('node-3');
    });

    // The next two cases test resolveNodeRouting() directly rather than
    // through plan(): when validatePlan() ends up rejecting the plan anyway
    // (AGENT_NOT_REGISTERED, with no INPUT_REQUIRED/INPUT_INVALID issue to
    // let the caller fix it), plan() clears steps to [] before returning
    // (existing behavior, unrelated to this correction) — so the corrected
    // (or deliberately un-corrected) nodeId isn't observable from plan()'s
    // return value in these two cases.
    it('leaves nodeId untouched when no real fallback exists (no online node, tool not local)', () => {
      const steps: PlanStep[] = [{
        stepId: 'S1', toolName: 'material.protectFile', nodeId: 'node1',
        version: '1.0.0', input: { filePath: '/tmp/report.xml' }, dependsOn: [],
      }];
      const nodes: NodeDescriptor[] = [
        { ...mockNodes[0]!, nodeId: 'node-1', status: 'offline', resources: [] },
      ];

      const corrected = resolveNodeRouting(steps, [], nodes); // no registered tools at all

      expect(corrected[0]!.nodeId).toBe('node1'); // unchanged from the LLM's raw output
    });

    it('never overrides a nodeId that matches a real (even offline/incapable) node', () => {
      // node-1 is real but offline and doesn't advertise the tool — this must
      // be left alone so validatePlan() surfaces AGENT_NOT_REGISTERED,
      // never get silently rerouted, per the existing "never replace an
      // explicitly requested node with local" rule.
      const steps: PlanStep[] = [{
        stepId: 'S1', toolName: 'material.protectFile', nodeId: 'node-1',
        version: '1.0.0', input: { filePath: '/tmp/report.xml' }, dependsOn: [],
      }];
      const nodes: NodeDescriptor[] = [
        { ...mockNodes[0]!, nodeId: 'node-1', status: 'offline', resources: [] },
      ];

      const corrected = resolveNodeRouting(steps, [protectFileTool], nodes);

      expect(corrected[0]!.nodeId).toBe('node-1'); // not silently rerouted to "local"
    });
  });

  it('summarizes execution results with a fact-only prompt', async () => {
    const plannerLLM = makeLLM(validPlanJson);
    const summaryLLM = makeLLM({
      steps: [{ stepId: 'S1', summary: '查詢成功。' }],
    });
    const accounting = makeAccounting({
      node1: [{
        name: 'machine.queryStatus', version: '1.1.0', type: 'tool', metadata: {
          description: '查詢機台狀態',
          outputSchema: { orderId: { type: 'string', description: '目前工單' } },
          summaryHints: ['有 orderId 時必須說明目前工單'],
        },
      }],
    });
    const summary = await new NLPlanningService(plannerLLM, accounting, { summaryLLM }).summarize(
      '確認 CNC-01 狀態',
      { steps: [{ stepId: 'S1', nodeId: 'node1', toolName: 'machine.queryStatus', result: { success: true } }] },
    );
    expect(summary.summary).toBe('查詢成功。');
    expect(summary.steps[0]?.stepId).toBe('S1');
    expect(summaryLLM.complete).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining('不得推測'),
      task: expect.stringContaining('CNC-01'),
    }));
    expect(summaryLLM.complete).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.stringContaining('有 orderId 時必須說明目前工單'),
    }));
    expect(accounting.listNodeResources).toHaveBeenCalledTimes(1);
    expect(plannerLLM.complete).not.toHaveBeenCalled();
  });

  it('rejects a malformed run result instead of forwarding it to the LLM', async () => {
    const plannerLLM = makeLLM(validPlanJson);
    const summaryLLM = makeLLM({ steps: [{ stepId: 'S1', summary: 'n/a' }] });
    const svc = new NLPlanningService(plannerLLM, makeAccounting(), { summaryLLM });

    // "run" is unknown at the API boundary (POST /api/summarize forwards the
    // raw HTTP body) -- a step missing toolName must not reach the LLM prompt.
    await expect(svc.summarize('task', { steps: [{ stepId: 'S1', nodeId: 'node1' }] }))
      .rejects.toThrow(/Invalid execution run result/);
    expect(summaryLLM.complete).not.toHaveBeenCalled();
  });

  it('truncates an oversized step result instead of dumping it whole into the LLM input', async () => {
    const plannerLLM = makeLLM(validPlanJson);
    const summaryLLM = makeLLM({ steps: [{ stepId: 'S1', summary: '完成' }] });
    const svc = new NLPlanningService(plannerLLM, makeAccounting(), { summaryLLM });
    const hugeOutput = 'x'.repeat(5_000);

    await svc.summarize('task', {
      steps: [{
        stepId: 'S1', nodeId: 'node1', toolName: 'machine.queryStatus',
        result: { success: true, output: hugeOutput },
      }],
    });

    const sentTask = summaryLLM.complete.mock.calls[0]![0].task;
    expect(sentTask).toContain('_truncated');
    expect(sentTask).not.toContain(hugeOutput);
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
