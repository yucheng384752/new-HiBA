import type {
  DecisionAction,
  HiBAToolbox,
  PlanStep,
  ToolContext,
} from '../types/hiba.types';
import type { NodeCapabilityChecker } from './HttpNodeCapabilityChecker';

export class ResourceDecisionService {
  constructor(
    private readonly toolbox: HiBAToolbox,
    private readonly checker: NodeCapabilityChecker,
  ) {}

  async decide(step: PlanStep, ctx: ToolContext): Promise<DecisionAction> {
    this.checker.clearCache();

    if (!this.toolbox.has(step.toolName)) {
      const canInstall = await this.checker.canInstall(step.nodeId, ctx);
      return canInstall ? 'install' : 'dispatch';
    }

    const isStale = await this.checker.isStale(
      step.nodeId,
      step.toolName,
      step.version,
      ctx,
    );
    return isStale ? 'update' : 'execute';
  }
}
