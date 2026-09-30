import type { Component, Focusable } from '@moonshot-ai/pi-tui';
import type { AgentHandle } from '@moonshot-ai/agent-core';
import { SkillRef } from '@moonshot-ai/harness-core';
import { expandCommandArguments } from '@moonshot-ai/harness-core/features/plugin/inspect/commands';
import type { DeviceAuthorization } from '@moonshot-ai/kimi-code-oauth';
import type { KimiHarness, KimiSession } from '@moonshot-ai/kimi-code-sdk';

import type { ColorToken, ThemeName } from '#/tui/theme';

import type { AuthFlowController } from '../controllers/auth-flow';
import type { BtwPanelController } from '../controllers/btw-panel';
import type { StreamingUIController } from '../controllers/streaming-ui';
import type { TasksBrowserController } from '../controllers/tasks-browser';
import { tryHandleDanceCommand } from '../easter-eggs/dance';
import type { ResolvedTheme } from '../theme/colors';
import type { TUIState } from '../tui-state';
import type {
  AppState,
  LoginProgressSpinnerHandle,
  TranscriptEntry,
} from '../types';
import { formatErrorMessage } from '../utils/errors';
import { handleLoginCommand, handleLogoutCommand } from './auth';
import { handleBtwCommand } from './btw';
import { handleCopyCommand } from './copy';
import {
  handleCompactCommand,
  handleEditorCommand,
  handleEffortCommand,
  handleModelCommand,
  handlePlanCommand,
  handleThemeCommand,
  showModelPicker,
  showPermissionPicker,
  showSettingsSelector,
} from './config';
import { handleGoalCommand } from './goal';
import { handleFeedbackCommand, showMcpServers, showStatusReport, showUsage } from './info';
import { parseSlashInput } from './parse';
import { handlePluginsCommand } from './plugins';
import { handleProviderCommand } from './provider';
import {
  findBuiltInSlashCommand,
  resolveSlashCommandAvailability,
  type BuiltinSlashCommandName,
} from './registry';
import { handleReloadCommand, handleReloadTuiCommand } from './reload';
import {
  canRestoreSubmittedInput,
  resolveSlashCommandInput,
  slashBusyMessage,
  slashCommandBusyReason,
  type SlashCommandIntent,
} from './resolve';
import {
  handleExportDebugZipCommand,
  handleExportMdCommand,
  handleForkCommand,
  handleInitCommand,
  handleTitleCommand,
} from './session';
import { handleSwarmCommand } from './swarm';
import { handleUndoCommand } from './undo';

// ---------------------------------------------------------------------------
// Re-exports — keep existing consumers working
// ---------------------------------------------------------------------------

export { handleLoginCommand, handleLogoutCommand } from './auth';
export { handleBtwCommand } from './btw';
export { handleCopyCommand } from './copy';
export {
  handleCompactCommand,
  handleEditorCommand,
  handleEffortCommand,
  handleModelCommand,
  handlePlanCommand,
  handleThemeCommand,
  showModelPicker,
  showPermissionPicker,
  showSettingsSelector,
} from './config';
export { handleGoalCommand } from './goal';
export { handleFeedbackCommand, showMcpServers, showStatusReport, showUsage } from './info';
export { handlePluginsCommand } from './plugins';
export { handleProviderCommand } from './provider';
export { handleReloadCommand, handleReloadTuiCommand } from './reload';
export {
  handleExportDebugZipCommand,
  handleExportMdCommand,
  handleForkCommand,
  handleInitCommand,
  handleTitleCommand,
} from './session';
export { handleSwarmCommand } from './swarm';
export { handleUndoCommand } from './undo';

// ---------------------------------------------------------------------------
// Host interface
// ---------------------------------------------------------------------------

export interface SlashCommandHost {
  state: TUIState;
  session: KimiSession | undefined;
  readonly harness: KimiHarness;
  cancelInFlight: (() => void) | undefined;

  setAppState(patch: Partial<AppState>): void;
  resetLivePane(): void;
  showError(msg: string): void;
  showStatus(msg: string, color?: ColorToken): void;
  showNotice(title: string, detail?: string): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  track(event: string, props?: Record<string, unknown>): void;
  mountEditorReplacement(panel: Component & Focusable): void;
  restoreEditor(): void;
  restoreInputText(text: string): void;
  refreshSlashCommandAutocomplete(): void;
  refreshDynamicCommands(): Promise<void>;
  refreshAvailableModels(): void;
  /**
   * Seed appState with the config defaults (model, thinking effort, plan
   * mode) while no session exists.
   */
  hydrateLazyConfigDefaults(): void;

  // Session
  requireSession(): KimiSession;
  /** The live main agent handle (rebound on undo / compaction remount). */
  mainAgent(): AgentHandle | undefined;
  /**
   * Lazy-create the session on first use. Returns the existing session, or
   * undefined (with the error already surfaced) when creation fails.
   */
  ensureSession(): Promise<KimiSession | undefined>;
  /** Await the in-flight lazy session creation, if any; no-op otherwise. */
  waitForLazyCreation(): Promise<void>;
  switchToSession(session: KimiSession, message: string): Promise<void>;
  reloadCurrentSessionView(session: KimiSession, message: string): Promise<void>;
  beginSessionRequest(): void;
  failSessionRequest(message: string): void;

  // UI
  showLoginProgressSpinner(label: string): LoginProgressSpinnerHandle;
  showLoginAuthorizationPrompt(auth: DeviceAuthorization): LoginProgressSpinnerHandle;
  showProgressSpinner(label: string): LoginProgressSpinnerHandle;

  // Theme
  applyTheme(theme: ThemeName, resolved?: ResolvedTheme): Promise<void>;
  refreshTerminalThemeTracking(): void;

  // Dispatch
  stop(exitCode?: number): Promise<void>;
  setExitOpenUrl(url: string): void;
  /**
   * Register a task that takes over the process after the TUI has shut down
   * (instead of exiting): the runner awaits it and only exits when it returns.
   */
  setExitForegroundTask(task: (exitCode: number) => Promise<void>): void;
  showHelpPanel(): void;
  createNewSession(): Promise<void>;
  showSessionPicker(): Promise<void>;
  sendNormalUserInput(text: string): void;
  askBtw(question: string): Promise<void>;
  readonly skillCommandMap: Map<string, string>;
  readonly pluginCommandMap: Map<string, string>;

  // Controller refs
  readonly streamingUI: StreamingUIController;
  readonly authFlow: AuthFlowController;
  readonly tasksBrowserController: TasksBrowserController;
  readonly btwPanelController: BtwPanelController;
}

// ---------------------------------------------------------------------------
// Dispatch — entry point from handleUserInput
// ---------------------------------------------------------------------------

export function dispatchInput(host: SlashCommandHost, text: string): void {
  if (parseSlashInput(text) !== null) {
    void executeSlashCommand(host, text);
    return;
  }
  host.sendNormalUserInput(text);
}

async function executeSlashCommand(host: SlashCommandHost, input: string): Promise<void> {
  const parsedCommand = parseSlashInput(input);
  const intent = resolveSlashCommandInput({
    input,
    skillCommandMap: host.skillCommandMap,
    pluginCommandMap: host.pluginCommandMap,
    isStreaming: host.state.appState.streamingPhase !== 'idle',
    isCompacting: host.state.appState.isCompacting,
  });

  switch (intent.kind) {
    case 'not-command':
      return;
    case 'blocked':
      host.track('input_command_invalid', { reason: 'blocked', command: intent.commandName });
      host.showError(slashBusyMessage(intent.commandName, intent.reason));
      // The editor buffer was already cleared on submit; give the rejected
      // command line back so hand-typed input is not lost.
      host.restoreInputText(input);
      return;
    case 'invalid':
      host.track('input_command_invalid', {
        reason: intent.reason,
        command: intent.commandName,
      });
      host.showError(`Invalid slash command: /${intent.commandName}`);
      return;
    case 'skill':
      host.track('input_command', { command: intent.commandName, kind: 'skill' });
      await handleSkillCommand(host, intent);
      return;
    case 'plugin-command':
      host.track('input_command', { command: intent.commandName, kind: 'plugin' });
      handlePluginCommand(host, intent);
      return;
    case 'message':
      // Unknown slash command: let /dance claim it before it falls through to
      // the model as a normal message. This runs *after* builtin and skill
      // resolution, so a real command or a same-named skill always wins.
      if (parsedCommand !== null && tryHandleDanceCommand(host, parsedCommand)) {
        return;
      }
      host.sendNormalUserInput(intent.input);
      return;
    case 'builtin':
      host.track('input_command', { command: intent.name });
      if (intent.name === 'new' && parsedCommand?.name === 'clear') {
        host.track('clear');
      }
      try {
        await handleBuiltInSlashCommand(host, intent.name, intent.args, input);
      } catch (error) {
        host.showError(formatErrorMessage(error));
      }
      return;
  }
}

/**
 * Lazy-create the session for a slash command that needs one. A missing
 * session means the TUI started session-less, so commands create it on first
 * use. Returns undefined (error already shown) when creation fails.
 */
async function ensureSessionForCommand(host: SlashCommandHost): Promise<KimiSession | undefined> {
  return host.ensureSession();
}

async function handleSkillCommand(
  host: SlashCommandHost,
  intent: Extract<SlashCommandIntent, { kind: 'skill' }>,
): Promise<void> {
  const session = await ensureSessionForCommand(host);
  if (session === undefined) return;
  const main = host.mainAgent();
  if (main === undefined) return;
  const skill = main.resolve(SkillRef);
  if (skill === undefined) {
    host.showError('skill feature is not installed');
    return;
  }
  try {
    await skill.activate({ name: intent.skillName, args: intent.args });
  } catch (error) {
    host.showError(formatErrorMessage(error));
  }
}

function handlePluginCommand(
  host: SlashCommandHost,
  intent: Extract<SlashCommandIntent, { kind: 'plugin-command' }>,
): void {
  const fullName = `${intent.pluginId}:${intent.commandName}`;
  const body = host.pluginCommandMap.get(fullName);
  if (body === undefined) {
    host.showError(`Unknown plugin command: /${fullName}`);
    return;
  }
  host.sendNormalUserInput(expandCommandArguments(body, intent.args));
}

/** Builtin commands that need an active session; lazy-created on demand. */
const SESSION_REQUIRING_COMMANDS: ReadonlySet<BuiltinSlashCommandName> = new Set([
  'compact',
  'plan',
  'undo',
]);

async function handleBuiltInSlashCommand(
  host: SlashCommandHost,
  name: BuiltinSlashCommandName,
  args: string,
  input: string,
): Promise<void> {
  if (host.session === undefined && SESSION_REQUIRING_COMMANDS.has(name)) {
    const session = await ensureSessionForCommand(host);
    if (session === undefined) {
      // Creation failed after submit cleared the buffer; give the input
      // back unless the user moved on — a newer draft or an opened panel.
      if (canRestoreSubmittedInput(host)) host.restoreInputText(input);
      return;
    }
    // A first prompt may have started a turn while the session was being
    // created; re-check the availability gate that was resolved before the
    // await (idle-only commands are blocked while a turn is active).
    const command = findBuiltInSlashCommand(name);
    const busyReason = slashCommandBusyReason({
      isStreaming: host.state.appState.streamingPhase !== 'idle',
      isCompacting: host.state.appState.isCompacting,
    });
    if (
      busyReason !== undefined &&
      command !== undefined &&
      resolveSlashCommandAvailability(command, args) === 'idle-only'
    ) {
      host.showError(slashBusyMessage(name, busyReason));
      // Same as the dispatch blocked branch: give the cleared input back,
      // guarded the same way — session creation awaited above.
      if (canRestoreSubmittedInput(host)) host.restoreInputText(input);
      return;
    }
  }
  switch (name) {
    case 'exit':
      void host.stop();
      return;
    case 'help':
      host.showHelpPanel();
      return;
    case 'version':
      host.showStatus(`Kimi Code v${host.state.appState.version}`);
      return;
    case 'new': {
      // A first-use lazy creation may still be in flight: wait it out so /new
      // never races a second createSession against the pending prompt.
      await host.waitForLazyCreation();
      // The waited-out prompt may have started a turn meanwhile; /new is
      // idle-only, so re-run the busy gate resolved before the await.
      const busyReason = slashCommandBusyReason({
        isStreaming: host.state.appState.streamingPhase !== 'idle',
        isCompacting: host.state.appState.isCompacting,
      });
      if (busyReason !== undefined) {
        host.showError(slashBusyMessage(name, busyReason));
        return;
      }
      await host.createNewSession();
      host.state.ui.requestRender();
      return;
    }
    case 'sessions':
      void host.showSessionPicker();
      return;
    case 'tasks':
      host.tasksBrowserController.show();
      return;
    case 'mcp':
      showMcpServers(host);
      return;
    case 'goal':
      await handleGoalCommand(host, args);
      return;
    case 'btw':
      await handleBtwCommand(host, args);
      return;
    case 'swarm':
      await handleSwarmCommand(host, args);
      return;
    case 'fork':
      await handleForkCommand(host, args);
      return;
    case 'export-md':
      await handleExportMdCommand(host, args);
      return;
    case 'export-debug-zip':
      await handleExportDebugZipCommand(host);
      return;
    case 'init':
      await handleInitCommand(host);
      return;
    case 'reload':
      await handleReloadCommand(host);
      return;
    case 'provider':
      await handleProviderCommand(host, args);
      return;
    case 'plugins':
      await handlePluginsCommand(host, args);
      return;
    case 'reload-tui':
      await handleReloadTuiCommand(host);
      return;
    case 'editor':
      await handleEditorCommand(host, args);
      return;
    case 'theme':
      await handleThemeCommand(host, args);
      return;
    case 'model':
      await handleModelCommand(host, args);
      return;
    case 'effort':
      await handleEffortCommand(host, args);
      return;
    case 'permission':
      showPermissionPicker(host);
      return;
    case 'settings':
      showSettingsSelector(host);
      return;
    case 'usage':
      void showUsage(host);
      return;
    case 'status':
      void showStatusReport(host);
      return;
    case 'feedback':
      await handleFeedbackCommand(host);
      return;
    case 'title':
      await handleTitleCommand(host, args);
      return;
    case 'yolo':
      showPermissionPicker(host, 'yolo');
      return;
    case 'auto':
      showPermissionPicker(host, 'auto');
      return;
    case 'plan':
      await handlePlanCommand(host, args);
      return;
    case 'compact':
      await handleCompactCommand(host, args);
      return;
    case 'copy':
      await handleCopyCommand(host);
      return;
    case 'login':
      await handleLoginCommand(host);
      return;
    case 'logout':
      await handleLogoutCommand(host);
      return;
    case 'undo':
      await handleUndoCommand(host, args);
      return;
    default:
      host.showError(`Unknown slash command: /${String(name)}`);
      return;
  }
}
