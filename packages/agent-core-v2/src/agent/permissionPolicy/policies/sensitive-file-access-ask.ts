import { IConfigService } from '#/app/config/config';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { isSensitiveFileGuardEnabled } from '#/agent/permissionRules/configSection';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { isSensitiveFile } from '#/tool/path-access';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { fileAccesses } from './path-utils';

export class SensitiveFileAccessAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'sensitive-file-access-ask';

  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @IConfigService private readonly config: IConfigService,
  ) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    if (!isSensitiveFileGuardEnabled(this.config)) return undefined;
    const access = fileAccesses(context).find((fileAccess) => isSensitiveFile(fileAccess.path));
    if (access === undefined) return undefined;
    const lease = this.runtime.acquire();
    try {
      const fs = lease.runtime.fs;
      if (fs === undefined) return { kind: 'ask' };
      const stat = await fs.stat(access.path).catch(() => undefined);
      return stat !== undefined && stat.isDirectory ? undefined : { kind: 'ask' };
    } finally {
      lease.dispose();
    }
  }
}
