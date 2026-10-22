import {
  ImportSessionsScreenComponent,
  importSessions,
  scanImportableSessions,
  sourceHomes,
} from '#/session-import/index';

import type { SlashCommandHost } from './dispatch';

/**
 * `/import-sessions`: replace the editor with the import page until it closes.
 *
 * Imported sessions are written straight to disk, which the running session
 * index only notices on its next periodic reconcile. Looking each one up by
 * id makes the index record it now, so `/sessions` lists it right away.
 */
export function handleImportSessionsCommand(host: SlashCommandHost): void {
  const now = Date.now();
  const kimiHome = host.harness.homeDir;
  const contextWindow = host.state.appState.maxContextTokens;
  const homes = sourceHomes();
  const screen = new ImportSessionsScreenComponent({
    now,
    scan: () => scanImportableSessions({ kimiHome, ...homes, now }),
    run: async (candidates, hooks) => {
      const report = await importSessions(candidates, { kimiHome, contextWindow, now, ...hooks });
      await Promise.all(
        report.imported.map((sessionId) => host.harness.listSessions({ sessionId }).catch(() => [])),
      );
      return report;
    },
    requestRender: () => {
      host.state.ui.requestRender();
    },
    onClose: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(screen);
}
