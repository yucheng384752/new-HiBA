import type {
  HiBAErrorCode,
  ToolContext,
  ToolName,
  ToolResult,
} from '../../../../hiba.types';
import { HiBAToolbox } from './HiBAToolbox';

export class HiBAError extends Error {
  readonly errorCode: HiBAErrorCode;

  constructor(errorCode: HiBAErrorCode, message: string) {
    super(message);
    this.name = 'HiBAError';
    this.errorCode = errorCode;
  }
}

export class ScopedToolbox extends HiBAToolbox {
  private readonly childPermissions: readonly string[];

  static fromParent(parent: HiBAToolbox, childPermissions: readonly string[]): ScopedToolbox {
    const exceedsParent = childPermissions.filter(permission => !parent.permissions.includes(permission));
    if (exceedsParent.length > 0) {
      throw new HiBAError(
        'PERMISSION_EXCEEDS_PARENT',
        `Child permissions exceed parent permissions: ${exceedsParent.join(', ')}`,
      );
    }

    return new ScopedToolbox(parent, childPermissions);
  }

  private constructor(parent: HiBAToolbox, childPermissions: readonly string[]) {
    super({
      auditWriter: parent.getAuditWriter(),
      maxDepth: parent.getMaxDepth(),
      permissions: childPermissions,
    });
    this.tools = parent.getToolRegistry();
    this.childPermissions = [...childPermissions];
  }

  override async execute<TOutput = unknown>(
    toolName: ToolName,
    rawInput: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult<TOutput>> {
    return super.execute<TOutput>(toolName, rawInput, {
      ...ctx,
      permissions: [...this.childPermissions],
    });
  }
}
