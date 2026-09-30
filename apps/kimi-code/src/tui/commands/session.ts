import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core';
import { SessionInitRef } from '@moonshot-ai/harness-core';

import { detectInstallSource } from '#/cli/update/source';
import { detectShellEnvironment } from '#/utils/process/shell-env';
import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';

import { LLM_NOT_SET_MESSAGE, NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage, isAbortError } from '../utils/errors';
import { buildExportMarkdown } from '../utils/export-markdown';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Session commands
// ---------------------------------------------------------------------------

export async function handleTitleCommand(host: SlashCommandHost, args: string): Promise<void> {
  const title = args.trim();
  if (title.length === 0) {
    const current = host.state.appState.sessionTitle;
    host.showStatus(
      current !== null && current.length > 0
        ? `Session title: ${current}`
        : `Session title: (not set) — id: ${host.state.appState.sessionId}`,
    );
    return;
  }

  const session = host.session;
  if (session === undefined) {
    host.showError('No active session. Send a message to start one.');
    return;
  }

  const newTitle = title.slice(0, 200);
  try {
    await host.harness.renameSession(session.id, newTitle);
    host.setAppState({ sessionTitle: newTitle });
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set title: ${msg}`);
    return;
  }
  host.showStatus(`Session title set to: ${newTitle}`);
}

export async function handleForkCommand(host: SlashCommandHost, args: string): Promise<void> {
  void args;
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  try {
    const forked = await host.harness.forkSession(session.id);
    await host.switchToSession(forked, `Forked session (${forked.id}).`);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to fork session: ${msg}`);
  }
}

export async function handleExportMdCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  host.showStatus('Exporting session as Markdown…');
  try {
    const history = session.handle.stores.get(MAIN_AGENT_ID)?.getState().history ?? [];
    if (history.length === 0) {
      host.showError('No messages to export.');
      return;
    }

    const now = new Date();
    const shortId = session.id.slice(0, 8);
    const timestamp = now.toISOString().replaceAll(/[-:]/g, '').replace(/T/, '-').slice(0, 15);
    const defaultName = `kimi-export-${shortId}-${timestamp}.md`;

    const trimmedArgs = args.trim();
    const outputPath = trimmedArgs.length > 0
      ? resolve(trimmedArgs)
      : resolve(host.state.appState.workDir, defaultName);

    const md = buildExportMarkdown({
      sessionId: session.id,
      workDir: host.state.appState.workDir,
      history,
      tokenCount: host.state.appState.contextTokens,
      now,
    });

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, md, 'utf-8');

    const linked = toTerminalHyperlink(outputPath, pathToFileURL(outputPath).href);
    host.showNotice(`Exported ${String(history.length)} messages`, linked);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to export session: ${msg}`);
  }
}

export async function handleExportDebugZipCommand(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  host.showStatus('Exporting session…');
  try {
    const installSource = await detectInstallSource();
    const shellEnv = detectShellEnvironment();
    const result = await host.harness.exportSession(session.id, {
      installSource,
      shellEnv,
      includeGlobalLog: true,
    });
    const linked = toTerminalHyperlink(result.zipPath, pathToFileURL(result.zipPath).href);
    host.showNotice('Export complete', linked);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to export session: ${msg}`);
  }
}

export async function handleInitCommand(host: SlashCommandHost): Promise<void> {
  if (host.state.appState.model.trim().length === 0) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }
  const session = await host.ensureSession();
  if (session === undefined) return;

  const init = session.handle.resolve(SessionInitRef);
  if (init === undefined) {
    host.showError('Session init is not available in this session.');
    return;
  }

  const spinner = host.showProgressSpinner('Generating AGENTS.md…');
  const cancel = (): void => {
    init.cancelInit();
  };
  host.cancelInFlight = cancel;
  try {
    await init.generateAgentsMd();
    host.track('init_complete');
    spinner.stop({ ok: true, label: 'AGENTS.md generated.' });
  } catch (error) {
    if (isAbortError(error)) {
      spinner.stop({ ok: false, label: 'Init cancelled.' });
      return;
    }
    spinner.stop({ ok: false, label: `Init failed: ${formatErrorMessage(error)}` });
  } finally {
    if (host.cancelInFlight === cancel) host.cancelInFlight = undefined;
  }
}
