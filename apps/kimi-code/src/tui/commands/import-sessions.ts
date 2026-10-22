import {
  ImportSessionsScreenComponent,
  importSessions,
  scanImportableSessions,
  sourceHomes,
} from '#/session-import/index';

import type { SlashCommandHost } from './dispatch';

/** `/import-sessions`: replace the editor with the import page until it closes. */
export function handleImportSessionsCommand(host: SlashCommandHost): void {
  const now = Date.now();
  const kimiHome = host.harness.homeDir;
  const contextWindow = host.state.appState.maxContextTokens;
  const homes = sourceHomes();
  const screen = new ImportSessionsScreenComponent({
    now,
    scan: () => scanImportableSessions({ kimiHome, ...homes, now }),
    run: (candidates, hooks) => importSessions(candidates, { kimiHome, contextWindow, now, ...hooks }),
    requestRender: () => {
      host.state.ui.requestRender();
    },
    onClose: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(screen);
}
