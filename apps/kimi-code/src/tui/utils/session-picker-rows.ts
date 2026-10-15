import { workspaceRootKey } from '@moonshot-ai/agent-core-v2/_base/utils/workdir-slug';
import type { SessionSummary } from '@moonshot-ai/kimi-code-sdk';

import type { SessionRow } from '#/tui/components/dialogs/session-picker';

export function sessionRowsForPicker(
  sessions: readonly SessionSummary[],
  currentSessionId: string,
  currentSessionHasContent: boolean,
  defaultWorkspacePath?: string,
): SessionRow[] {
  const defaultKey =
    defaultWorkspacePath === undefined ? undefined : workspaceRootKey(defaultWorkspacePath);
  return sessions
    .filter((session) => currentSessionHasContent || session.id !== currentSessionId)
    .map((session) => ({
      id: session.id,
      title: session.title ?? null,
      last_prompt: session.lastPrompt ?? null,
      work_dir: session.workDir,
      in_default_workspace: defaultKey !== undefined && workspaceRootKey(session.workDir) === defaultKey,
      updated_at: session.updatedAt ?? session.createdAt ?? 0,
      metadata: session.metadata,
    }));
}
