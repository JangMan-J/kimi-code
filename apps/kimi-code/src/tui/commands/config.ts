import {
  AgentModelRef,
  ModelDefaultsRef,
} from '@moonshot-ai/agent-core';
import {
  CompactionRef,
  PermissionRef,
  PlanRef,
} from '@moonshot-ai/harness-core';

import { EditorSelectorComponent } from '../components/dialogs/editor-selector';
import { EffortSelectorComponent } from '../components/dialogs/effort-selector';
import { modelDisplayName, segmentsFor } from '../components/dialogs/model-selector';
import { TabbedModelSelectorComponent } from '../components/dialogs/tabbed-model-selector';
import { PermissionSelectorComponent } from '../components/dialogs/permission-selector';
import { SettingsSelectorComponent, type SettingsSelection } from '../components/dialogs/settings-selector';
import { SurveyPreferenceSelectorComponent } from '../components/dialogs/survey-preference-selector';
import { ThemeSelectorComponent } from '../components/dialogs/theme-selector';
import { UpdatePreferenceSelectorComponent } from '../components/dialogs/update-preference-selector';
import { DEFAULT_TUI_CONFIG, saveTuiConfig, type TuiConfig } from '../config';
import type { ThemeName } from '#/tui/theme';
import { currentTheme, isBuiltInTheme, lightColors, loadCustomThemeMerged } from '#/tui/theme';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/errors';
import { PERMISSION_MODE_DESCRIPTIONS, PERMISSION_MODE_DISPLAY_NAMES } from '../utils/permission-mode';
import { thinkingEffortToConfig } from '../utils/thinking-config';
import { showUsage } from './info';
import type { PermissionMode, ThinkingEffort } from '../types';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Plan / Config commands
// ---------------------------------------------------------------------------

const MODEL_SWITCH_CACHE_WARNING =
  'Note: Switching models invalidates the existing prompt cache. Use /new to avoid extra token costs.';
const EFFORT_SWITCH_CACHE_WARNING =
  'Note: Switching effort invalidates the existing prompt cache. Use /new to avoid extra token costs.';

/** True once the conversation has at least one user message: a switch from
 * then on resends the accumulated context, losing the cache. Shell-command
 * echoes are also 'user' transcript entries but carry an empty `bullet`, so
 * they're excluded. */
function hasConversationHistory(host: SlashCommandHost): boolean {
  return host.state.transcriptEntries.some(
    (entry) => entry.kind === 'user' && entry.bullet !== '',
  );
}

export function currentTuiConfig(host: Pick<SlashCommandHost, 'state'>): TuiConfig {
  return {
    theme: host.state.appState.theme,
    editorCommand: host.state.appState.editorCommand,
    disablePasteBurst: host.state.appState.disablePasteBurst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
    renderLatex: host.state.appState.renderLatex ?? DEFAULT_TUI_CONFIG.renderLatex ?? true,
    cacheExpiryHint: host.state.appState.cacheExpiryHint ?? DEFAULT_TUI_CONFIG.cacheExpiryHint,
    disableFeedbackSurvey:
      host.state.appState.disableFeedbackSurvey ?? DEFAULT_TUI_CONFIG.disableFeedbackSurvey,
    notifications: host.state.appState.notifications,
    upgrade: host.state.appState.upgrade,
    statusLine: host.state.appState.statusLine ?? DEFAULT_TUI_CONFIG.statusLine,
  };
}

export async function handlePlanCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  const plan = session.main.resolve(PlanRef);
  if (plan === undefined) {
    host.showError('Plan mode is not available in this session.');
    return;
  }

  const subcmd = args.trim().toLowerCase();
  if (subcmd === 'clear') {
    await plan.clear();
    host.showNotice('Plan cleared');
    return;
  }

  let enabled: boolean;
  if (subcmd.length === 0) enabled = !host.state.appState.planMode;
  else if (subcmd === 'on') enabled = true;
  else if (subcmd === 'off') enabled = false;
  else {
    host.showError(`Unknown plan subcommand: ${subcmd}`);
    return;
  }

  // The session may already be in the requested mode (e.g. it was created
  // with config.defaultPlanMode applied), and re-entering plan mode throws.
  if (host.state.appState.planMode === enabled) {
    host.showNotice(`Plan mode is already ${enabled ? 'on' : 'off'}`);
    return;
  }

  try {
    if (enabled) {
      await plan.enter();
      host.setAppState({ planMode: true });
      const status = await plan.status().catch(() => null);
      host.showNotice(
        'Plan mode: ON',
        status?.path !== undefined && status?.path !== null
          ? `Plan will be created here: ${status.path}`
          : undefined,
      );
      return;
    }
    await plan.exit();
    host.setAppState({ planMode: false });
    host.showNotice('Plan mode: OFF');
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set plan mode: ${msg}`);
  }
}

export async function handleCompactCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  const customInstruction = args.trim() || undefined;
  const compaction = session.main.resolve(CompactionRef);
  if (compaction === undefined) {
    host.showError('Failed to compact: compaction feature is not installed');
    return;
  }
  try {
    await compaction.compact(customInstruction);
  } catch (error) {
    host.showError(`Failed to compact: ${formatErrorMessage(error)}`);
  }
}

export async function handleEditorCommand(host: SlashCommandHost, args: string): Promise<void> {
  const command = args.trim();
  if (command.length === 0) {
    showEditorPicker(host);
    return;
  }
  await applyEditorChoice(host, command);
}

export async function handleThemeCommand(host: SlashCommandHost, args: string): Promise<void> {
  const theme = args.trim();
  if (theme.length === 0) {
    showThemePicker(host);
    return;
  }
  if (!isBuiltInTheme(theme)) {
    const custom = await loadCustomThemeMerged(theme);
    if (custom === null) {
      host.showError(`Unknown theme: ${theme}`);
      return;
    }
  }
  await applyThemeChoice(host, theme);
}

export async function handleModelCommand(host: SlashCommandHost, args: string): Promise<void> {
  const alias = args.trim();
  host.refreshAvailableModels();
  if (alias.length === 0) {
    showModelPicker(host);
    return;
  }
  if (host.state.appState.availableModels[alias] === undefined) {
    host.showError(`Unknown model alias: ${alias}`);
    return;
  }
  showModelPicker(host, alias);
}

export async function handleEffortCommand(host: SlashCommandHost, args: string): Promise<void> {
  const alias = host.state.appState.model;
  const model = host.state.appState.availableModels[alias];
  if (model === undefined) {
    host.showError('No model selected. Run /model to select one first.');
    return;
  }
  const segments = segmentsFor(model);
  const arg = args.trim().toLowerCase();
  if (arg.length === 0) {
    showEffortPicker(host, segments);
    return;
  }
  if (!segments.includes(arg)) {
    const protocol = model.protocol ?? host.state.appState.availableProviders[model.provider]?.type;
    if (protocol !== 'anthropic') {
      host.showError(
        `Unsupported thinking effort "${arg}" for ${alias}. Available: ${segments.join(', ')}`,
      );
      return;
    }
    const knownEfforts = model.supportEfforts?.join(', ') ?? 'none declared';
    host.showStatus(
      `Thinking effort "${arg}" is not listed for ${alias} (known: ${knownEfforts}). Sending "${arg}" unchanged; the configured provider will validate it.`,
      'warning',
    );
  }
  await performModelSwitch(host, alias, arg, true);
}

function showEffortPicker(
  host: SlashCommandHost,
  segments: readonly string[],
): void {
  const liveEffort = host.state.appState.thinkingEffort;
  const currentValue = segments.includes(liveEffort) ? liveEffort : (segments[0] ?? 'off');
  const alias = host.state.appState.model;
  host.mountEditorReplacement(
    new EffortSelectorComponent({
      efforts: segments,
      currentValue,
      warning: hasConversationHistory(host) ? EFFORT_SWITCH_CACHE_WARNING : undefined,
      onSelect: (effort) => {
        host.restoreEditor();
        void performModelSwitch(host, alias, effort, true);
      },
      onSessionOnlySelect: (effort) => {
        host.restoreEditor();
        void performModelSwitch(host, alias, effort, false);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Pickers & config apply
// ---------------------------------------------------------------------------

function showEditorPicker(host: SlashCommandHost): void {
  const currentValue = host.state.appState.editorCommand ?? '';
  host.mountEditorReplacement(
    new EditorSelectorComponent({
      currentValue,
      onSelect: (value) => {
        host.restoreEditor();
        void applyEditorChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function applyEditorChoice(host: SlashCommandHost, value: string): Promise<void> {
  const previous = host.state.appState.editorCommand ?? '';
  if (value === previous && value.length > 0) {
    host.showStatus(`Editor unchanged: ${value.length > 0 ? value : 'auto-detect'}`);
    return;
  }

  const editorCommand = value.length > 0 ? value : null;
  try {
    await saveTuiConfig({
      ...currentTuiConfig(host),
      editorCommand,
    });
  } catch (error) {
    host.showStatus(
      `Failed to save editor: ${formatErrorMessage(error)}`,
      'error',
    );
    return;
  }

  host.setAppState({ editorCommand });
  host.showStatus(
    value.length > 0
      ? `Editor set to "${value}".`
      : 'Editor set to auto-detect ($VISUAL / $EDITOR).',
  );
}

export function showModelPicker(host: SlashCommandHost, selectedValue: string = host.state.appState.model): void {
  const models = host.state.appState.availableModels;
  const entries = Object.entries(models);
  if (entries.length === 0) {
    host.showNotice(
      'No models configured',
      'Run /login to sign in to Kimi, or add a provider to your config.',
    );
    return;
  }
  host.mountEditorReplacement(
    new TabbedModelSelectorComponent({
      models,
      currentValue: host.state.appState.model,
      selectedValue,
      currentThinkingEffort: host.state.appState.thinkingEffort,
      warning: hasConversationHistory(host) ? MODEL_SWITCH_CACHE_WARNING : undefined,
      onSelect: ({ alias, thinking }) => {
        host.restoreEditor();
        void performModelSwitch(host, alias, thinking, true);
      },
      onSessionOnlySelect: ({ alias, thinking }) => {
        host.restoreEditor();
        void performModelSwitch(host, alias, thinking, false);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function performModelSwitch(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
  persist: boolean,
): Promise<void> {
  let session = host.session;
  if (session === undefined) {
    // A first prompt may still be inside lazy creation: wait it out so the
    // switch lands on the new session instead of being overwritten by its
    // assembly.
    await host.waitForLazyCreation();
    session = host.session;
  }
  if (host.state.appState.streamingPhase !== 'idle') {
    host.showError('Cannot switch models while streaming — press Esc or Ctrl-C first.');
    return;
  }

  const prevModel = host.state.appState.model;
  const prevEffort = host.state.appState.thinkingEffort;
  const modelChanged = alias !== prevModel;
  const effortChanged = effort !== prevEffort;

  try {
    if (session !== undefined) {
      const agentModel = session.main.resolve(AgentModelRef);
      if (agentModel === undefined) throw new Error('provider-catalog agent model is not available');
      if (modelChanged) {
        await agentModel.setModel(alias);
      }
      if (effortChanged) {
        await agentModel.setThinking(effort);
      }
    }
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to switch model: ${msg}`);
    return;
  }

  if (session === undefined) {
    // Session-less: the pick applies to the first lazy-created session — the
    // persisted default below is what that session binds on creation.
    host.setAppState({ model: alias, thinkingEffort: effort });
  }
  const displayName = modelDisplayName(
    alias,
    host.state.appState.availableModels[alias],
  );

  let persisted = false;
  if (persist) {
    try {
      persisted = await persistModelSelection(host, alias, effort, effortChanged);
    } catch (error) {
      const msg = formatErrorMessage(error);
      host.showError(`Switched to ${displayName}, but failed to save default: ${msg}`);
      return;
    }
  }

  let status: string;
  if (modelChanged) {
    status = persist
      ? `Switched to ${displayName} with thinking ${effort}.`
      : `Switched to ${displayName} with thinking ${effort} for this session only.`;
  } else if (effortChanged) {
    status = persist
      ? `Thinking set to ${effort}.`
      : `Thinking set to ${effort} for this session only.`;
  } else if (persist && persisted) {
    status = `Saved ${displayName} with thinking ${effort} as default.`;
  } else {
    status = `Already using ${displayName} with thinking ${effort}.`;
  }
  host.showStatus(status, 'success');
}

async function persistModelSelection(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
  effortChanged: boolean,
): Promise<boolean> {
  const defaults = host.harness.app.resolve(ModelDefaultsRef);
  if (defaults === undefined) throw new Error('model-defaults feature is not installed');
  await defaults.setDefaultModel(alias);
  if (effortChanged) {
    const model = host.state.appState.availableModels[alias];
    const full = thinkingEffortToConfig(effort, model);
    if (full.effort !== undefined) {
      await defaults.setDefaultThinking(full.effort);
    }
  }
  return true;
}

function showThemePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new ThemeSelectorComponent({
      currentValue: host.state.appState.theme,
      onSelect: (value) => {
        host.restoreEditor();
        void applyThemeChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function applyThemeChoice(host: SlashCommandHost, theme: ThemeName): Promise<void> {
  if (theme === host.state.appState.theme) {
    if (theme === 'auto') host.refreshTerminalThemeTracking();
    host.showStatus(`Theme unchanged: "${theme}".`);
    return;
  }

  // Validate custom themes up front so a missing / malformed file reports an
  // error instead of silently persisting a name that resolves to the dark
  // fallback.
  if (!isBuiltInTheme(theme)) {
    const palette = await loadCustomThemeMerged(theme);
    if (palette === null) {
      host.showStatus(`Theme "${theme}" could not be loaded.`, 'error');
      return;
    }
  }

  try {
    await saveTuiConfig({
      ...currentTuiConfig(host),
      theme,
    });
  } catch (error) {
    host.showStatus(
      `Failed to save theme: ${formatErrorMessage(error)}`,
      'error',
    );
    return;
  }

  const resolved = theme === 'auto'
    ? (currentTheme.palette === lightColors ? 'light' : 'dark')
    : undefined;
  await host.applyTheme(theme, resolved);
  host.refreshTerminalThemeTracking();
  host.track('theme_switch', { theme });
  const detail = theme === 'auto' ? ` (tracking terminal; current: ${resolved})` : '';
  host.showStatus(`Theme set to "${theme}"${detail}.`);
}

export function showPermissionPicker(host: SlashCommandHost, initialMode?: PermissionMode): void {
  host.mountEditorReplacement(
    new PermissionSelectorComponent({
      currentValue: host.state.appState.permissionMode,
      initialValue: initialMode,
      onSelect: (value) => {
        host.restoreEditor();
        void applyPermissionChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

export function showUpdatePreferencePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new UpdatePreferenceSelectorComponent({
      currentValue: host.state.appState.upgrade.autoInstall,
      onSelect: (value) => {
        host.restoreEditor();
        void applyUpdatePreferenceChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

type UpdatePreferenceHost = {
  readonly state: {
    readonly appState: Pick<
      SlashCommandHost['state']['appState'],
      'theme' | 'editorCommand' | 'notifications' | 'upgrade'
    >;
  };
  setAppState(patch: Pick<SlashCommandHost['state']['appState'], 'upgrade'>): void;
  showStatus(msg: string, color?: string): void;
  track: SlashCommandHost['track'];
};

export async function applyUpdatePreferenceChoice(
  host: UpdatePreferenceHost,
  autoInstall: boolean,
): Promise<void> {
  if (autoInstall === host.state.appState.upgrade.autoInstall) {
    host.showStatus(`Automatic updates already ${autoInstall ? 'enabled' : 'disabled'}.`);
    return;
  }

  const upgrade = { autoInstall };
  try {
    await saveTuiConfig({
      ...currentTuiConfig(host as unknown as SlashCommandHost),
      upgrade,
    });
  } catch (error) {
    host.showStatus(
      `Failed to save automatic update setting: ${formatErrorMessage(error)}`,
      'error',
    );
    return;
  }

  host.setAppState({ upgrade });
  host.track('upgrade_preference_changed', { auto_install: autoInstall });
  host.showStatus(`Automatic updates ${autoInstall ? 'enabled' : 'disabled'}.`);
}

async function applyPermissionChoice(host: SlashCommandHost, mode: PermissionMode): Promise<void> {
  if (mode === host.state.appState.permissionMode) {
    host.showStatus(`Permission mode unchanged: ${PERMISSION_MODE_DISPLAY_NAMES[mode]}.`);
    return;
  }

  try {
    if (host.session !== undefined) {
      const permission = host.session.main.resolve(PermissionRef);
      if (permission === undefined) throw new Error('permission feature is not installed');
      await permission.setModeAndBroadcast(mode);
    }
    // Session-less: the chosen mode is recorded in appState and passed to
    // the lazy-created session.
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set permission mode: ${msg}`);
    return;
  }

  host.setAppState({ permissionMode: mode });
  host.showNotice(`Permission mode: ${PERMISSION_MODE_DISPLAY_NAMES[mode]}`);
  if (mode !== 'manual') {
    host.showStatus(PERMISSION_MODE_DESCRIPTIONS[mode], 'warning');
  }
}

export function showSurveyPreferencePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new SurveyPreferenceSelectorComponent({
      currentValue: host.state.appState.disableFeedbackSurvey !== true,
      onSelect: (value) => {
        host.restoreEditor();
        void applySurveyPreferenceChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

type SurveyPreferenceHost = {
  readonly state: {
    readonly appState: Pick<
      SlashCommandHost['state']['appState'],
      'theme' | 'editorCommand' | 'notifications' | 'upgrade' | 'disableFeedbackSurvey'
    >;
  };
  setAppState(
    patch: Pick<SlashCommandHost['state']['appState'], 'disableFeedbackSurvey'>,
  ): void;
  showStatus(msg: string, color?: string): void;
};

export async function applySurveyPreferenceChoice(
  host: SurveyPreferenceHost,
  enabled: boolean,
): Promise<void> {
  const disableFeedbackSurvey = !enabled;
  if (disableFeedbackSurvey === (host.state.appState.disableFeedbackSurvey === true)) {
    host.showStatus(`Feedback survey already ${enabled ? 'enabled' : 'disabled'}.`);
    return;
  }

  try {
    await saveTuiConfig({
      ...currentTuiConfig(host as unknown as SlashCommandHost),
      disableFeedbackSurvey,
    });
  } catch (error) {
    host.showStatus(
      `Failed to save session rating setting: ${formatErrorMessage(error)}`,
      'error',
    );
    return;
  }

  host.setAppState({ disableFeedbackSurvey });
  host.showStatus(`Feedback survey ${enabled ? 'enabled' : 'disabled'}.`);
}

export function showSettingsSelector(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new SettingsSelectorComponent({
      onSelect: (value) => {
        handleSettingsSelection(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function handleSettingsSelection(host: SlashCommandHost, value: SettingsSelection): void {
  host.restoreEditor();
  switch (value) {
    case 'model': showModelPicker(host); return;
    case 'permission': showPermissionPicker(host); return;
    case 'theme': showThemePicker(host); return;
    case 'editor': showEditorPicker(host); return;
    case 'survey': showSurveyPreferencePicker(host); return;
    case 'upgrade': showUpdatePreferencePicker(host); return;
    case 'usage': void showUsage(host); return;
  }
}
