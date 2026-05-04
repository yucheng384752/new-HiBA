import { describe, expect, it, jest } from '@jest/globals';
import { ResourceDecisionService } from '../ResourceDecisionService';
import type { NodeCapabilityChecker } from '../HttpNodeCapabilityChecker';
import type {
  HiBAToolbox,
  PlanStep,
  ToolContext,
} from '../../types/hiba.types';

function makeChecker(): jest.Mocked<NodeCapabilityChecker> {
  return {
    canInstall: jest.fn(),
    isStale: jest.fn(),
    clearCache: jest.fn(),
  };
}

function makeToolbox(hasTool: boolean): jest.Mocked<HiBAToolbox> {
  return {
    has: jest.fn(() => hasTool),
  };
}

const step: PlanStep = {
  stepId: 'S1',
  toolName: 'material.readFile',
  nodeId: 'node-abc',
  version: '1.2.3',
  input: { filePath: '/opt/data.xml' },
  dependsOn: [],
};

const ctx: ToolContext = {
  hibaBaseUrl: 'http://localhost:8080',
  traceId: 'trace-1',
  agentId: 'agent-1',
  depth: 0,
  permissions: [],
};

describe('ResourceDecisionService A3', () => {
  it("returns 'install' when toolbox.has=false and canInstall=true", async () => {
    const toolbox = makeToolbox(false);
    const checker = makeChecker();
    checker.canInstall.mockResolvedValue(true);
    const service = new ResourceDecisionService(toolbox, checker);

    const result = await service.decide(step, ctx);

    expect(result).toBe('install');
    expect(checker.clearCache).toHaveBeenCalledTimes(1);
    expect(checker.canInstall).toHaveBeenCalledWith('node-abc', ctx);
    expect(checker.isStale).not.toHaveBeenCalled();
  });

  it("returns 'dispatch' when toolbox.has=false and canInstall=false", async () => {
    const toolbox = makeToolbox(false);
    const checker = makeChecker();
    checker.canInstall.mockResolvedValue(false);
    const service = new ResourceDecisionService(toolbox, checker);

    const result = await service.decide(step, ctx);

    expect(result).toBe('dispatch');
    expect(checker.clearCache).toHaveBeenCalledTimes(1);
    expect(checker.canInstall).toHaveBeenCalledWith('node-abc', ctx);
    expect(checker.isStale).not.toHaveBeenCalled();
  });

  it("returns 'update' when toolbox.has=true and isStale=true", async () => {
    const toolbox = makeToolbox(true);
    const checker = makeChecker();
    checker.isStale.mockResolvedValue(true);
    const service = new ResourceDecisionService(toolbox, checker);

    const result = await service.decide(step, ctx);

    expect(result).toBe('update');
    expect(checker.clearCache).toHaveBeenCalledTimes(1);
    expect(checker.isStale).toHaveBeenCalledWith('node-abc', 'material.readFile', '1.2.3', ctx);
    expect(checker.canInstall).not.toHaveBeenCalled();
  });

  it("returns 'execute' when toolbox.has=true and isStale=false", async () => {
    const toolbox = makeToolbox(true);
    const checker = makeChecker();
    checker.isStale.mockResolvedValue(false);
    const service = new ResourceDecisionService(toolbox, checker);

    const result = await service.decide(step, ctx);

    expect(result).toBe('execute');
    expect(checker.clearCache).toHaveBeenCalledTimes(1);
    expect(checker.isStale).toHaveBeenCalledWith('node-abc', 'material.readFile', '1.2.3', ctx);
    expect(checker.canInstall).not.toHaveBeenCalled();
  });
});
