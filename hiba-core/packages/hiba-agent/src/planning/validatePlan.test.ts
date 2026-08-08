import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import { defineTool } from '../core/defineTool';
import { HIBA_PROTOCOL_VERSION } from '../types/hiba.types';
import type { ExecutionPlan, NodeDescriptor } from '../types/hiba.types';
import { validatePlan } from './validatePlan';

const tool = defineTool({
  name: 'material.queryStock',
  version: '1.0.0',
  tags: ['material', 'read'],
  description: 'Query stock',
  inputSchema: z.object({ partNumber: z.string() }),
  outputSchema: z.object({ quantity: z.number() }),
  permissions: ['material.read'],
  timeout: 1_000,
  handler: async () => ({ quantity: 1 }),
});

const nodes: NodeDescriptor[] = [{
  protocolVersion: HIBA_PROTOCOL_VERSION,
  nodeId: 'node-1',
  agentUrl: 'http://node-1',
  status: 'online',
  canInstall: false,
  resources: [{ name: tool.name, version: tool.version, type: 'tool' }],
  registeredAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
}];

function plan(input: Record<string, unknown>, version = '1.0.0'): ExecutionPlan {
  return {
    protocolVersion: HIBA_PROTOCOL_VERSION,
    steps: [{
      stepId: 'S1', toolName: tool.name, nodeId: 'node-1', version, input, dependsOn: [],
    }],
    supervisorPolicy: 'fail-fast',
  };
}

describe('validatePlan', () => {
  it('accepts a plan only when tool, version, node, and input are compatible', () => {
    expect(validatePlan(plan({ partNumber: 'P-001' }), { tools: [tool], nodes })).toEqual({
      valid: true,
      plan: plan({ partNumber: 'P-001' }),
    });
  });

  it('reports missing required inputs for interaction instead of executing', () => {
    const result = validatePlan(plan({}), { tools: [tool], nodes });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'INPUT_REQUIRED', field: 'partNumber' }),
      ]));
      expect(result.missingInputs).toEqual([{ stepId: 'S1', toolName: tool.name, fields: ['partNumber'] }]);
    }
  });

  it('rejects incompatible versions and unavailable nodes', () => {
    const result = validatePlan(plan({ partNumber: 'P-001' }, '2.0.0'), { tools: [tool], nodes: [] });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
        'VERSION_INCOMPATIBLE', 'AGENT_NOT_REGISTERED',
      ]));
    }
  });

  it('rejects dependency cycles', () => {
    const cyclic: ExecutionPlan = {
      steps: [
        { ...plan({ partNumber: 'A' }).steps[0]!, stepId: 'S1', dependsOn: ['S2'] },
        { ...plan({ partNumber: 'B' }).steps[0]!, stepId: 'S2', dependsOn: ['S1'] },
      ],
      supervisorPolicy: 'fail-fast',
    };

    const result = validatePlan(cyclic, { tools: [tool], nodes });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DEPENDENCY_FAILED' }),
    ]));
  });
});
