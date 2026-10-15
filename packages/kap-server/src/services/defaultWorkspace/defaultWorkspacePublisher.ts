import {
  DEFAULT_WORKSPACE_SECTION,
  IConfigService,
  IEventService,
  IWorkspaceService,
  WorkspaceUpdated,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

export interface DefaultWorkspacePublisher {
  close(): void;
}

export function startDefaultWorkspacePublisher(core: Scope): DefaultWorkspacePublisher {
  const config = core.accessor.get(IConfigService);
  const workspaces = core.accessor.get(IWorkspaceService);
  const events = core.accessor.get(IEventService);
  let closed = false;

  const announceAll = async (): Promise<void> => {
    const registered = await workspaces.list();
    if (closed) return;
    for (const workspace of registered) {
      events.publish(new WorkspaceUpdated({ payload: { workspace } }));
    }
  };

  const subscription = config.onDidSectionChange((event) => {
    if (closed || event.domain !== DEFAULT_WORKSPACE_SECTION) return;
    void announceAll().catch(() => undefined);
  });

  return {
    close: () => {
      closed = true;
      subscription.dispose();
    },
  };
}
