import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AgentModelRef,
  MAIN_AGENT_ID,
  ProviderCatalogRef,
  type AgentHandle,
} from '@moonshot-ai/agent-core';
import { watch } from '@moonshot-ai/agent-core/kernel/index';
import {
  BashRef,
  BtwRef,
  CompactionRef,
  PermissionRef,
  PlanRef,
  ShellCommandRef,
  SkillCatalogRef,
} from '@moonshot-ai/harness-core';
import {
  PluginRef,
  type PluginCommandDef,
} from '@moonshot-ai/harness-core/features/plugin/index';
import type { DeviceAuthorization } from '@moonshot-ai/kimi-code-oauth';
import {
  KimiSession,
  log,
  type KimiHarness,
} from '@moonshot-ai/kimi-code-sdk';
import { isTelemetryDisabledByEnv } from '@moonshot-ai/kimi-telemetry';
import type { MigrationPlan } from '@moonshot-ai/migration-legacy';
import {
  deleteAllKittyImages,
  type Component,
  type Focusable,
  getCapabilities,
  Spacer,
  TuiAltScreen,
  TuiMainScreen,
} from '@moonshot-ai/pi-tui';

import type { CLIOptions } from '#/cli/options';
import { goalObjectiveLengthWarning } from '#/cli/goal-command-parse';
import { createSessionWithStartupProfile } from '#/cli/startup-profile';
import { MigrationScreenComponent, type MigrationScreenResult } from '#/migration/index';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';
import { appendInputHistory, loadInputHistory } from '#/utils/history/input-history';
import { openUrl } from '#/utils/open-url';
import { getInputHistoryFile } from '#/utils/paths';
import { detectFdPath, ensureFdPath } from '#/utils/process/fd-detect';
import { quoteShellArg } from '#/utils/shell-quote';
import { listSessionsByRecency, type SessionListEntry } from '#/utils/sessions';
import { restoreTerminalModes } from '#/utils/terminal-restore';

import { BannerProvider } from './banner/banner-provider';
import { readBannerDisplayState, writeBannerDisplayState } from './banner/state';
import {
  BUILTIN_SLASH_COMMANDS,
  buildPluginSlashCommands,
  buildSkillSlashCommands,
  isExperimentalFlagEnabled,
  sortSlashCommands,
  type KimiSlashCommand,
} from './commands';
import * as slashCommands from './commands/dispatch';
import { BannerComponent } from './components/chrome/banner';
import { DeviceCodeBoxComponent } from './components/chrome/device-code-box';
import { GutterContainer } from './components/chrome/gutter-container';
import { MoonLoader, type SpinnerStyle } from './components/chrome/moon-loader';
import { WelcomeComponent } from './components/chrome/welcome';
import { pickRandomWorkingTip } from './components/chrome/working-tips';
import {
  ApprovalPanelComponent,
  type ApprovalPanelResponse,
} from './components/dialogs/approval-panel';
import {
  ApprovalPreviewViewer,
  type ApprovalPreviewBlock,
} from './components/dialogs/approval-preview';
import { CompactionComponent } from './components/dialogs/compaction';
import { HelpPanelComponent } from './components/dialogs/help-panel';
import { QuestionDialogComponent } from './components/dialogs/question-dialog';
import { SessionPickerComponent, type SessionRow } from './components/dialogs/session-picker';
import { TrustPromptComponent, type TrustPromptChoice } from './components/dialogs/trust-prompt';
import {
  FileMentionProvider,
  type SlashAutocompleteCommand,
} from './components/editor/file-mention-provider';
import { AssistantMessageComponent } from './components/messages/assistant-message';
import { CronMessageComponent } from './components/messages/cron-message';
import { ShellRunComponent } from './components/messages/shell-run';
import { SkillActivationComponent } from './components/messages/skill-activation';
import {
  NoticeMessageComponent,
  StatusMessageComponent,
} from './components/messages/status-message';
import { StepSummaryComponent } from './components/messages/step-summary';
import { ThinkingComponent } from './components/messages/thinking';
import { ToolCallComponent } from './components/messages/tool-call';
import {
  ReplayTurnBoundaryComponent,
  UserMessageComponent,
} from './components/messages/user-message';
import { ActivityPaneComponent, type ActivityPaneMode } from './components/panes/activity-pane';
import { QueuePaneComponent } from './components/panes/queue-pane';
import type { TuiConfig } from './config';
import {
  LLM_NOT_SET_MESSAGE,  NO_ACTIVE_SESSION_MESSAGE,
  PRODUCT_NAME,
  SESSIONLESS_STARTUP_NOTICE,
} from './constant/kimi-tui';
import { MEDIA_INGESTION_SUBMIT_WAIT_MS } from './constant/media';
import { CHROME_GUTTER } from './constant/rendering';
import { MAX_TERMINAL_TITLE_LENGTH } from './constant/terminal';
import { AuthFlowController } from './controllers/auth-flow';
import { BtwPanelController } from './controllers/btw-panel';
import { ClipboardImageHintController } from './controllers/clipboard-image-hint';
import { EditorKeyboardController } from './controllers/editor-keyboard';
import { McpStatusController } from './controllers/mcp-status';
import { SessionEventHandler } from './controllers/session-event-handler';
import { SessionReplayRenderer } from './controllers/session-replay';
import { StreamingUIController } from './controllers/streaming-ui';
import { SurveyController } from './controllers/survey-controller';
import { TasksBrowserController } from './controllers/tasks-browser';
import { installRainbowDance } from './easter-eggs/dance';
import { InteractionController } from './reverse-rpc/interaction-controller';
import type { ApprovalPanelData, QuestionPanelData } from './reverse-rpc/types';
import { currentTheme, getColorPalette, getBuiltInPalette, isBuiltInTheme } from './theme';
import type { ColorToken, ResolvedTheme, ThemeName } from './theme';
import { createTUIState, type TUIState } from './tui-state';
import {
  INITIAL_LIVE_PANE,
  type AppState,
  type KimiTUIOptions,
  type LivePaneState,
  type LoginProgressSpinnerHandle,
  type PermissionMode,
  type QueuePaneItem,
  type StepRetryState,
  type TranscriptEntry,
  type TUIStartupOptions,
  type TUIStartupState,
} from './types';
import {
  hasDispose,
  hasHiddenContent,
  isExpandable,
  isExpandedComponent,
} from './utils/component-capabilities';
import { isDeadTerminalError } from './utils/dead-terminal';
import { formatErrorMessage } from './utils/errors';
import { ImageAttachmentStore, type ImageAttachment } from './utils/image-attachment-store';
import {
  extractMediaAttachments,
  pendingMediaIngestions,
} from './utils/image-placeholder';
import type { ExtractionResult } from './utils/image-placeholder';
import { installInputLatencyProbe } from './utils/input-latency';
import { startupTrace } from '#/utils/startup-trace';
import { hasPatchChanges } from './utils/object-patch';
import { beginScreenTakeover, endScreenTakeover, type ScreenTakeover } from './utils/screen-takeover';
import { formatStepRetryDetail, formatStepRetryLabel } from './utils/step-retry';
import { formatBashOutputForDisplay } from './utils/shell-output';
import { thinkingEffortFromConfig } from './utils/thinking-config';
import { collectAvailableModels } from './utils/models';
import { combineStartupNotice, isOAuthLoginRequiredError } from './utils/startup';
import { installTerminalFocusTracking } from './utils/terminal-focus';
import { notifyTerminalOnce } from './utils/terminal-notification';
import { installTerminalThemeTracking } from './utils/terminal-theme';
import { detectTmuxKeyboardWarning } from './utils/tmux-keyboard';
import {
  getTranscriptComponentEntry,
  markTranscriptComponent,
} from './utils/transcript-component-metadata';
import { nextTranscriptId } from './utils/transcript-id';
import {
  expandCutoffIndex,
  TRANSCRIPT_EXPAND_TURNS,
  TRANSCRIPT_HYSTERESIS,
  TRANSCRIPT_KEEP_RECENT_ASSISTANT,
  TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED,
  TRANSCRIPT_KEEP_RECENT_STEPS,
  TRANSCRIPT_MAX_TURNS,
  TRANSCRIPT_WINDOW_ENABLED,
  groupTurns,
  turnsToTrim,
} from './utils/transcript-window';

export type { TUIState } from './tui-state';
export { createTUIState } from './tui-state';
export type {
  KimiTUIOptions,
  LoginProgressSpinnerHandle,
  TUIStartupOptions,
  TUIStartupState,
} from './types';

export interface KimiTUIStartupInput {
  readonly cliOptions: CLIOptions;
  readonly tuiConfig: TuiConfig;
  readonly version: string;
  readonly workDir: string;
  readonly startupNotice?: string;
  readonly migrationPlan?: MigrationPlan | null;
  /** When true, run only the migration screen, then exit (the `kimi migrate` command). */
  readonly migrateOnly?: boolean;
  readonly telemetryDisabled?: boolean;
  /** Recreates the harness with the original options (workspace-trust grant). */
  readonly harnessFactory?: () => Promise<KimiHarness>;
}

type EffectiveActivityPaneMode = ActivityPaneMode | 'idle' | 'session';
type LoadingTipKind = 'moon' | 'composing';

function loadingTipKind(mode: EffectiveActivityPaneMode): LoadingTipKind | undefined {
  if (mode === 'waiting' || mode === 'tool') return 'moon';
  if (mode === 'composing') return 'composing';
  return undefined;
}

function waitingSpinnerLabel(retry: StepRetryState | null): string {
  return retry === null ? '' : formatStepRetryLabel(retry);
}

function createInitialAppState(input: KimiTUIStartupInput): AppState {
  const startupPermission: PermissionMode = input.cliOptions.auto
    ? 'auto'
    : input.cliOptions.yolo
      ? 'yolo'
      : 'manual';
  return {
    model: '',
    workDir: input.workDir,
    sessionId: '',
    permissionMode: startupPermission,
    planMode: input.cliOptions.plan,
    inputMode: 'prompt',
    swarmMode: false,
    towerMode: false,
    thinkingEffort: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    cumulativeTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    stepRetry: null,
    theme: input.tuiConfig.theme,
    version: input.version,
    editorCommand: input.tuiConfig.editorCommand,
    disablePasteBurst: input.tuiConfig.disablePasteBurst,
    renderLatex: input.tuiConfig.renderLatex,
    cacheExpiryHint: input.tuiConfig.cacheExpiryHint,
    disableFeedbackSurvey: input.tuiConfig.disableFeedbackSurvey,
    notifications: input.tuiConfig.notifications,
    upgrade: input.tuiConfig.upgrade,
    statusLine: input.tuiConfig.statusLine,
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    goal: null,
    mcpServersSummary: null,
    banner: undefined,
  };
}

/** How long the one-shot "moved to background" footer hint stays visible. */
const DETACH_HINT_DISPLAY_MS = 4_000;

interface QueuedBashCommand {
  readonly id: string;
  readonly text: string;
}

export class KimiTUI {
  harness: KimiHarness;
  private harnessClosed = false;
  private readonly harnessFactory: (() => Promise<KimiHarness>) | undefined;
  readonly options: KimiTUIOptions;
  session: KimiSession | undefined;
  state: TUIState;
  /** In-flight lazy session creation, shared by concurrent first-use triggers. */
  private ensureSessionPromise: Promise<KimiSession | undefined> | null = null;
  readonly interactionController: InteractionController;
  readonly skillCommandMap = new Map<string, string>();
  readonly pluginCommandMap = new Map<string, string>();
  private readonly imageStore = new ImageAttachmentStore();
  // Detected lazily in startBackgroundFdAutocomplete() — detection spawns
  // `fd --version`, which must not happen before the workspace trust gate:
  // on Windows a bare command name resolves into the (untrusted) cwd first.
  private fdPath: string | null = null;
  private fdDownloadStarted = false;
  sessionEventUnsubscribe: (() => void) | undefined;
  cancelInFlight: (() => void) | undefined;
  aborted = false;
  private terminalFocusTrackingDispose: (() => void) | undefined;
  private terminalThemeTrackingDispose: (() => void) | undefined;
  private clipboardImageHintController: ClipboardImageHintController | undefined;
  private catalogWatchDispose: (() => void) | undefined;
  private uninstallRainbowDance: () => void;
  private signalCleanupHandlers: Array<() => void> = [];
  private isShuttingDown = false;
  private readonly migrationPlan: MigrationPlan | null;
  private readonly migrateOnly: boolean;
  private readonly telemetryDisabled: boolean;
  private startupNotice: string | undefined;
  private lastActivityMode: string | undefined;
  private currentLoadingTip: { kind: LoadingTipKind; tip: string | undefined } | undefined =
    undefined;
  private lastHistoryContent: string | undefined;
  private skillSlashCommands: readonly KimiSlashCommand[] = [];
  private pluginSlashCommands: readonly KimiSlashCommand[] = [];
  private dynamicCommandUnsubscribe: Array<() => void> = [];
  private readonly startupAgentName: string | undefined;
  private readonly startupAgentFile: string | undefined;
  // Live `!` shell output entries, keyed by commandId so concurrent commands
  // each update their own card and stale events are dropped. Mutated in place
  // as `shell.output` events arrive; removed when the command completes.
  private readonly shellOutputStreams = new Map<
    string,
    { entry: TranscriptEntry; component: ShellRunComponent }
  >();
  /** `!` commands typed while the session is busy; drained one at a time. */
  private bashQueue: QueuedBashCommand[] = [];
  readonly streamingUI: StreamingUIController;
  readonly authFlow: AuthFlowController;
  readonly sessionEventHandler: SessionEventHandler;
  readonly sessionReplay: SessionReplayRenderer;
  readonly surveyController: SurveyController;
  readonly editorKeyboard: EditorKeyboardController;
  readonly tasksBrowserController: TasksBrowserController;
  readonly btwPanelController: BtwPanelController;
  private readonly mcpStatusController: McpStatusController;

  /** Timer that auto-clears the one-shot "moved to background" footer hint. */
  private detachHintClearTimer: ReturnType<typeof setTimeout> | undefined;

  // The currently-mounted approval panel, if any. Kept so the full-screen
  // preview viewer can restore focus to the exact same instance (and its
  // selection / feedback state) when it closes.
  private activeApprovalPanel: ApprovalPanelComponent | undefined;
  // Active full-screen approval preview. While set, the previous screen is
  // stashed in `takeover` (root children in regular mode, the layout root in
  // fullscreen); closing restores it.
  private approvalPreview:
    | {
        component: ApprovalPreviewViewer;
        takeover: ScreenTakeover;
        panel: ApprovalPanelComponent;
      }
    | undefined;

  public onExit?: (exitCode?: number) => Promise<void>;

  /** URL opened in the browser just before exit (e.g. by `/web`); printed by onExit. */
  public exitOpenUrl: string | undefined;

  /**
   * Task that takes over the process after the TUI shuts down, instead of
   * exiting (`/web` starting a new server: the server keeps this terminal
   * attached until Ctrl+C). Set via {@link setExitForegroundTask}.
   */
  public exitForegroundTask: ((exitCode: number) => Promise<void>) | undefined;

  track(event: string, properties?: Parameters<KimiHarness['track']>[1]): void {
    this.harness.track(event, properties);
  }

  constructor(harness: KimiHarness, startupInput: KimiTUIStartupInput) {
    this.harness = harness;
    this.harnessFactory = startupInput.harnessFactory;
    const tuiOptions: KimiTUIOptions = {
      initialAppState: createInitialAppState(startupInput),
      startup: {
        sessionFlag: startupInput.cliOptions.session,
        continueLast: startupInput.cliOptions.continue,
        yolo: startupInput.cliOptions.yolo,
        auto: startupInput.cliOptions.auto,
        plan: startupInput.cliOptions.plan,
        model: startupInput.cliOptions.model,
        startupNotice: startupInput.startupNotice,
      },
    };
    this.options = tuiOptions;
    this.migrationPlan = startupInput.migrationPlan ?? null;
    this.migrateOnly = startupInput.migrateOnly ?? false;
    this.telemetryDisabled = startupInput.telemetryDisabled ?? false;
    this.startupNotice = startupInput.startupNotice;
    this.startupAgentName = startupInput.cliOptions.agent;
    this.startupAgentFile = startupInput.cliOptions.agentFiles[0];
    this.state = createTUIState(tuiOptions);
    this.state.footer.setExpandHintProvider(() => this.toolOutputExpandHint());
    this.uninstallRainbowDance = installRainbowDance(() => {
      this.state.ui.requestRender();
    });

    this.interactionController = new InteractionController({
      showApprovalPanel: (payload) => {
        this.showApprovalPanel(payload);
      },
      hideApprovalPanel: () => {
        this.hideApprovalPanel();
      },
      showQuestionDialog: (payload) => {
        this.showQuestionDialog(payload);
      },
      hideQuestionDialog: () => {
        this.hideQuestionDialog();
      },
      onApprovalResolved: (payload, response) => {
        this.appendApprovalTranscriptEntry(payload, response);
      },
    });
    this.streamingUI = new StreamingUIController(this);
    this.authFlow = new AuthFlowController(this);
    this.sessionEventHandler = new SessionEventHandler(this);
    this.sessionReplay = new SessionReplayRenderer(this);
    this.surveyController = new SurveyController(this, {
      accessToken: () => this.harness.auth.getCachedAccessToken(),
      telemetryDisabled: () => isTelemetryDisabledByEnv() || this.telemetryDisabled,
    });
    this.tasksBrowserController = new TasksBrowserController(this);
    this.btwPanelController = new BtwPanelController(this);
    this.mcpStatusController = new McpStatusController(this);
    this.editorKeyboard = new EditorKeyboardController(this, this.imageStore);
    this.editorKeyboard.install();
    this.buildLayout();
  }

  // =========================================================================
  // Autocomplete
  // =========================================================================

  private getSlashCommands(): readonly KimiSlashCommand[] {
    return sortSlashCommands([
      ...BUILTIN_SLASH_COMMANDS,
      ...this.skillSlashCommands,
      ...this.pluginSlashCommands,
    ]).filter((command) => isExperimentalFlagEnabled(command.experimentalFlag));
  }

  /**
   * Rebuild the dynamic slash-command maps (skills from the skill catalog,
   * plugin commands from the plugin registry) and refresh autocomplete.
   * Subscriptions keep the maps current on `skill.changed` / plugin mutation
   * events; `/reload` also calls this directly.
   */
  async refreshDynamicCommands(): Promise<void> {
    const catalog = this.harness.app.resolve(SkillCatalogRef);
    if (catalog === undefined) {
      this.skillSlashCommands = [];
      this.skillCommandMap.clear();
    } else {
      const { commands, commandMap } = buildSkillSlashCommands(catalog.listInvocableSkills());
      this.skillSlashCommands = commands;
      this.skillCommandMap.clear();
      for (const [name, skillName] of commandMap) this.skillCommandMap.set(name, skillName);
    }
    const plugin = this.harness.app.resolve(PluginRef);
    if (plugin === undefined) {
      this.pluginSlashCommands = [];
      this.pluginCommandMap.clear();
    } else {
      const defs: readonly PluginCommandDef[] = await plugin.listPluginCommands();
      const { commands, commandMap } = buildPluginSlashCommands(defs);
      this.pluginSlashCommands = commands;
      this.pluginCommandMap.clear();
      for (const [name, body] of commandMap) this.pluginCommandMap.set(name, body);
    }
    this.refreshSlashCommandAutocomplete();
  }

  private startDynamicCommandTracking(): void {
    for (const off of this.dynamicCommandUnsubscribe) off();
    this.dynamicCommandUnsubscribe = [];
    void this.refreshDynamicCommands();
    try {
      this.dynamicCommandUnsubscribe.push(
        this.harness.app.on('skill.changed', () => {
          void this.refreshDynamicCommands();
        }),
        this.harness.app.on('plugin.changed', () => {
          void this.refreshDynamicCommands();
        }),
        this.harness.app.on('plugin.mutated', () => {
          void this.refreshDynamicCommands();
        }),
      );
    } catch {
      // Event subscription is best-effort; /reload still refreshes manually.
    }
  }

  private stopDynamicCommandTracking(): void {
    for (const off of this.dynamicCommandUnsubscribe) off();
    this.dynamicCommandUnsubscribe = [];
  }

  private async notifyPluginUpdatesIfAny(): Promise<void> {
    const plugin = this.harness.app.resolve(PluginRef);
    if (plugin === undefined) return;
    try {
      const updates = await plugin.checkUpdates();
      const available = updates.filter((update) => update.updateAvailable);
      if (available.length === 0 || this.aborted) return;
      this.showStatus(
        `Plugin updates available: ${available.map((update) => update.id).join(', ')} — review them in /plugins.`,
        'warning',
      );
    } catch {
      // Plugin update checks are best-effort and never block startup.
    }
  }

  private setupAutocomplete(): void {
    const slashCommands: SlashAutocompleteCommand[] = this.getSlashCommands().map((cmd) => {
      const completer = cmd.completeArgs;
      return {
        name: cmd.name,
        aliases: cmd.aliases,
        description: cmd.description,
        ...(cmd.argumentHint !== undefined ? { argumentHint: cmd.argumentHint } : {}),
        ...(completer !== undefined
          ? { getArgumentCompletions: (prefix: string) => completer(prefix) }
          : {}),
      };
    });
    const skillCommandNames = new Set(this.skillCommandMap.keys());
    const provider = new FileMentionProvider(
      slashCommands,
      this.state.appState.workDir,
      this.fdPath,
      [],
      () => this.state.appState.inputMode,
      skillCommandNames,
    );
    this.state.editor.setAutocompleteProvider(provider);

    const argumentHints = new Map<string, string>();
    for (const cmd of slashCommands) {
      if (cmd.argumentHint === undefined) continue;
      argumentHints.set(cmd.name, cmd.argumentHint);
      for (const alias of cmd.aliases ?? []) {
        argumentHints.set(alias, cmd.argumentHint);
      }
    }
    this.state.editor.setArgumentHints(argumentHints);
    this.state.editor.setSkillCommandNames(skillCommandNames);
  }

  refreshSlashCommandAutocomplete(): void {
    this.setupAutocomplete();
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async start(): Promise<void> {
    startupTrace('tui:start');
    // Signal handlers must be installed before raw mode to avoid EIO loops.
    this.registerSignalHandlers();
    // Outer try rolls back signal listeners on startup failure.
    try {
      // The workspace trust gate must run before anything else in startup —
      // including the migration branch: a workspace that needs migration is
      // not implicitly trusted, and later startup steps spawn child processes.
      startupTrace('trustPrompt:begin');
      const trustPromptStartedLoop = await this.maybeRunWorkspaceTrustPrompt();
      startupTrace('trustPrompt:end');

      if (this.migrationPlan !== null) {
        // Migration needs the event loop running first (pi-tui component).
        // When the trust prompt already started it, starting it again would
        // re-run pi-tui's terminal.start() — stacking a second Kitty
        // keyboard-protocol push and duplicate stdin listeners.
        if (!trustPromptStartedLoop) this.startEventLoop();
        try {
          const migrationResult = await this.runMigrationScreen(this.migrationPlan);
          if (this.migrateOnly) {
            const failed = migrationResult.decision === 'now' && migrationResult.migrated === false;
            this.disposeTerminalTracking();
            this.state.ui.stop();
            await this.onExit?.(failed ? 1 : 0);
            return;
          }
          await this.initMainTui();
          this.startBackgroundFdAutocomplete();
          await this.finishStartup();
        } catch (error) {
          this.disposeTerminalTracking();
          this.state.ui.stop();
          throw error;
        }
        return;
      }

      startupTrace('initMainTui:begin');
      await this.initMainTui();
      startupTrace('initMainTui:end');
      // Debug-only input→render latency overlay (KIMI_TUI_INPUT_LATENCY=1).
      if (process.env['KIMI_TUI_INPUT_LATENCY']) installInputLatencyProbe(this.state.ui);
      // When the trust prompt already started the event loop, starting it
      // again would re-run pi-tui's terminal.start() — stacking a second
      // Kitty keyboard-protocol push (leaking CSI-u mode past exit) and
      // duplicate stdin listeners.
      if (!trustPromptStartedLoop) this.startEventLoop();
      startupTrace('eventLoop:started');
      try {
        this.startBackgroundFdAutocomplete();
        startupTrace('finishStartup:begin');
        await this.finishStartup();
        startupTrace('finishStartup:end');
      } catch (error) {
        this.disposeTerminalTracking();
        this.state.ui.stop();
        throw error;
      }
    } catch (error) {
      this.unregisterSignalHandlers();
      throw error;
    }
  }

  private async loadBanner(): Promise<void> {
    const provider = new BannerProvider(this.state.appState.version);
    const displayState = await readBannerDisplayState();
    const now = new Date();
    const banner = await provider.load({
      state: displayState,
      now,
    });
    this.state.appState.banner = banner;
    if (banner === null) return;

    this.renderBanner();
    this.state.ui.requestRender();

    if (banner.display === 'always') return;
    try {
      await writeBannerDisplayState({
        version: 1,
        shown: {
          ...displayState.shown,
          [banner.key]: { lastShownAt: now.toISOString() },
        },
      });
    } catch {
      // Best-effort: banner display state should never block startup.
    }
  }

  private renderBanner(): void {
    if (this.state.appState.banner === null || this.state.appState.banner === undefined) {
      return;
    }
    if (this.state.transcriptContainer.children.some((child) => child instanceof BannerComponent)) {
      return;
    }
    const welcomeIndex = this.state.transcriptContainer.children.findIndex(
      (child) => child instanceof WelcomeComponent,
    );
    const banner = new BannerComponent(this.state.appState.banner);
    if (welcomeIndex >= 0) {
      this.state.transcriptContainer.children.splice(welcomeIndex + 1, 0, banner);
    } else {
      this.state.transcriptContainer.children.unshift(banner);
    }
    this.state.transcriptContainer.invalidate();
  }

  private async initMainTui(): Promise<void> {
    await this.init();

    // Mount only after init() succeeds; see mountFooter().
    this.mountFooter();
    this.mcpStatusController.start();
    this.startDynamicCommandTracking();
    this.renderWelcome();
    void this.loadBanner();
    this.setupAutocomplete();
    void this.loadPersistedInputHistory();
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(this.state.editor);
    this.state.ui.setFocus(this.state.editor);
  }

  private startEventLoop(): void {
    // Dispose any previous focus/clipboard/theme tracking so re-entering the
    // event loop (e.g. a future TUI reconnect) can't stack duplicate listeners.
    this.disposeTerminalTracking();
    this.state.ui.start();
    this.startClipboardImageHintController();
    this.terminalFocusTrackingDispose = installTerminalFocusTracking(this.state);
    this.refreshTerminalThemeTracking();
  }

  private startClipboardImageHintController(): void {
    this.clipboardImageHintController = new ClipboardImageHintController({
      ui: this.state.ui,
      footer: this.state.footer,
      getModelSupportsImage: () => this.supportsCurrentModelCapability('image_in'),
      requestRender: () => {
        this.state.ui.requestRender();
      },
    });
    this.clipboardImageHintController.start();
  }

  private startBackgroundFdAutocomplete(): void {
    if (this.fdDownloadStarted) return;
    this.fdDownloadStarted = true;

    this.fdPath = detectFdPath();
    if (this.fdPath !== null) {
      this.setupAutocomplete();
      return;
    }

    void ensureFdPath()
      .then((fdPath) => {
        if (fdPath === null) return;
        this.fdPath = fdPath;
        this.setupAutocomplete();
      })
      .catch(() => {
        // Best-effort background bootstrap: autocomplete keeps using the filesystem fallback.
      });
  }

  private async finishStartup(): Promise<void> {
    if (this.startupNotice !== undefined) {
      this.showStatus(this.startupNotice);
      this.startupNotice = undefined;
    }
    void this.showTmuxKeyboardWarningIfNeeded();
    void this.showConfigWarningsIfAny();
    void this.notifyPluginUpdatesIfAny();
    if (this.state.startupState === 'picker') {
      void this.bootstrapFromPicker();
      return;
    }
    if (this.session !== undefined) {
      this.sessionEventHandler.startSubscription();
      this.updateTerminalTitle();
    }
    void this.fetchSessions();
  }

  private async showTmuxKeyboardWarningIfNeeded(): Promise<void> {
    const warning = await detectTmuxKeyboardWarning();
    if (warning === undefined || this.aborted) return;
    this.showStatus(warning, 'warning');
  }

  private async init(): Promise<void> {
    this.refreshAvailableModels();
    this.catalogWatchDispose?.();
    const catalog = this.harness.app.resolve(ProviderCatalogRef);
    if (catalog === undefined) {
      this.catalogWatchDispose = undefined;
    } else {
      this.catalogWatchDispose = watch(catalog.snapshot, () => {
        this.refreshAvailableModels();
      });
    }

    const { startup } = this.options;
    const { workDir } = this.state.appState;
    const isResumeStartup = startup.sessionFlag !== undefined || startup.continueLast;

    try {
      if (isResumeStartup) {
        if (startup.sessionFlag === '') {
          this.state.startupState = 'picker';
          return;
        }

        if (startup.sessionFlag !== undefined) {
          const sessions = await this.listSessionsByRecency();
          const target = sessions.find((session) => session.id === startup.sessionFlag);
          if (target === undefined) {
            throw new Error(`Session "${startup.sessionFlag}" not found.`);
          }
          const session = await this.harness.resumeSession(startup.sessionFlag);
          await this.switchToSession(session, `Resumed session (${session.id}).`);
        } else {
          // --continue: the most recently active session in this workspace.
          const sessions = await this.listSessionsByRecency();
          const target = sessions[0];
          if (target !== undefined) {
            const session = await this.harness.resumeSession(target.id);
            await this.switchToSession(session, `Resumed session (${session.id}).`);
          } else {
            await this.createNewSession();
            this.startupNotice = combineStartupNotice(
              this.startupNotice,
              `No sessions to continue under "${workDir}"; starting a fresh session.`,
            );
          }
        }
      } else {
        // Lazy session creation: start session-less and create the session on
        // the first message. Startup flags are carried in appState and applied
        // when that session is created; until then the footer shows the config
        // defaults the engine would apply at createSession time.
        this.hydrateLazyConfigDefaults();
        this.appendStartupNotice(SESSIONLESS_STARTUP_NOTICE);
      }
    } catch (error) {
      if (!isOAuthLoginRequiredError(error)) throw error;
      this.authFlow.enterLoginRequiredStartupState();
      return;
    }

    this.applyStartupFlagOverrides();
    this.state.startupState = 'ready';
  }

  async stop(exitCode?: number): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    this.aborted = true;
    this.streamingUI.discardPending();
    // Stop background polling, streaming intervals, and per-component timers
    // before tearing the UI down, so they can't keep firing requestRender after
    // stop() returns (or leak when stop() runs without process.exit).
    this.stopActivitySpinner();
    this.streamingUI.disposeActiveCompactionBlock();
    this.streamingUI.resetToolUi();
    this.disposeTranscriptChildren();
    this.editorKeyboard.dispose();
    this.surveyController.dispose();
    this.tasksBrowserController.close();
    this.btwPanelController.clear();
    this.mcpStatusController.stop();
    this.stopDynamicCommandTracking();
    this.state.footer.dispose();
    this.catalogWatchDispose?.();
    this.catalogWatchDispose = undefined;
    this.disposeTerminalTracking();
    // Restore the terminal even if closing the session / harness throws — a
    // SIGTERM during a network or MCP shutdown must not leave the user stuck in
    // raw mode with a hidden cursor.
    try {
      await this.closeSession('shutting down');
      this.bashQueue = [];
      this.imageStore.clear();
      await this.closeCurrentHarness();
    } finally {
      this.uninstallRainbowDance();
      try {
        await this.state.terminal.drainInput();
      } catch {
        // best effort — the terminal may already be dead (SIGHUP / EIO).
      }
      try {
        this.stopUiForExit();
      } catch {
        // best effort terminal restore.
      }
    }
    if (this.onExit) {
      await this.onExit(exitCode);
    }
  }

  // SIGHUP / dead-terminal EIO → emergencyTerminalExit (no cleanup, avoids
  // EIO write-loop that can pin a CPU core). SIGTERM → normal stop().
  private registerSignalHandlers(): void {
    this.unregisterSignalHandlers();

    const signals: NodeJS.Signals[] = ['SIGTERM'];
    if (process.platform !== 'win32') {
      signals.push('SIGHUP');
    }

    for (const signal of signals) {
      const handler = (): void => {
        if (signal === 'SIGHUP') {
          this.emergencyTerminalExit();
          return;
        }
        // Registering a SIGTERM listener disables Node's default exit(143),
        // so we must reinstate it after stop() or on failure.
        this.stop(143).then(
          () => {
            process.exit(143);
          },
          () => {
            this.emergencyTerminalExit(143);
          },
        );
      };
      process.prependListener(signal, handler);
      this.signalCleanupHandlers.push(() => {
        process.off(signal, handler);
      });
    }

    const terminalErrorHandler = (error: Error): void => {
      if (isDeadTerminalError(error)) {
        this.emergencyTerminalExit();
      }
    };
    process.stdout.on('error', terminalErrorHandler);
    process.stderr.on('error', terminalErrorHandler);
    this.signalCleanupHandlers.push(() => {
      process.stdout.off('error', terminalErrorHandler);
    });
    this.signalCleanupHandlers.push(() => {
      process.stderr.off('error', terminalErrorHandler);
    });
  }

  private unregisterSignalHandlers(): void {
    const handlers = this.signalCleanupHandlers;
    this.signalCleanupHandlers = [];
    for (const cleanup of handlers) cleanup();
  }

  // Exit codes follow POSIX 128+signum: 129 = SIGHUP, 143 = SIGTERM.
  private emergencyTerminalExit(exitCode = 129): never {
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    // Best-effort terminal restore: stop() may not have run (SIGHUP) or may
    // have thrown (SIGTERM cleanup failure), so recover raw mode / cursor /
    // bracketed paste before exiting instead of leaving the user's shell broken.
    restoreTerminalModes();
    process.exit(exitCode);
  }

  private disposeTerminalTracking(): void {
    this.stopTerminalThemeTracking();
    this.clipboardImageHintController?.stop();
    this.clipboardImageHintController = undefined;
    this.terminalFocusTrackingDispose?.();
    this.terminalFocusTrackingDispose = undefined;
  }

  private buildLayout(): void {
    const { ui } = this.state;
    // Fullscreen mounts its layout root (transcript ScrollView + bottom dock)
    // in createTUIState; the root children list stays empty there.
    if (ui instanceof TuiAltScreen) return;
    ui.clear();
    ui.addChild(this.state.transcriptContainer);
    ui.addChild(this.state.activityContainer);
    ui.addChild(this.state.todoPanelContainer);
    ui.addChild(this.state.notifyPanelContainer);
    ui.addChild(this.state.queueContainer);
    ui.addChild(this.state.btwPanelContainer);
    ui.addChild(this.state.surveyContainer);
    ui.addChild(this.state.editorContainer);
    // Footer is mounted later (mountFooter), not here.
  }

  // Footer is the only chrome with content before a session is ready, so
  // mounting it at construction lets a stray pre-start render leak it to the
  // terminal — e.g. above the error when resuming a missing session. Mount it
  // only once init() succeeds. FooterComponent isn't a Container, so wrap it to
  // pick up the same outer gutter as the panels above.
  private mountFooter(): void {
    const footerWrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
    footerWrap.addChild(this.state.footer);
    const dock = this.state.dockContainer;
    if (dock !== undefined) {
      // Dock sizing contract: the footer may shrink to 1 row under extreme
      // height pressure, but never disappears (see createTUIState).
      dock.addChild(footerWrap, { shrink: 1, minSize: 1 });
      return;
    }
    this.state.ui.addChild(footerWrap);
  }

  // Fullscreen exit: leave the alternate screen with the frame preserved,
  // then replay the transcript through a main-screen renderer so native
  // scrollback ends up with the same inline layout a regular session would
  // have produced (pi's "transcript" exit form).
  private stopUiForExit(): void {
    const ui = this.state.ui;
    if (!(ui instanceof TuiAltScreen)) {
      ui.stop();
      return;
    }
    ui.stop({ preserveScreen: true });
    const main = new TuiMainScreen(ui.terminal);
    main.addChild(this.state.transcriptContainer);
    main.addChild(this.state.activityContainer);
    main.addChild(this.state.todoPanelContainer);
    main.addChild(this.state.notifyPanelContainer);
    main.addChild(this.state.queueContainer);
    main.addChild(this.state.btwPanelContainer);
    main.addChild(this.state.surveyContainer);
    main.addChild(this.state.editorContainer);
    const footerWrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
    footerWrap.addChild(this.state.footer);
    main.addChild(footerWrap);
    // First paint of a main-screen renderer writes every line sequentially,
    // landing the whole transcript in native scrollback.
    main.renderNow();
    main.stop();
  }

  // =========================================================================
  // Input Dispatch
  // =========================================================================

  handlePlanToggle(next: boolean): void {
    void slashCommands.handlePlanCommand(this, next ? 'on' : 'off');
  }

  handleInputModeChange(mode: 'prompt' | 'bash'): void {
    this.setAppState({ inputMode: mode });
    this.surveyController.notifyInputModeChanged(mode);
    this.updateEditorBorderHighlight();
  }

  handleUserInput(text: string): void {
    const wasBashMode = this.state.appState.inputMode === 'bash';
    if (wasBashMode) {
      // A submit always exits bash mode (the `!` is consumed by this command).
      this.state.editor.inputMode = 'prompt';
      this.handleInputModeChange('prompt');
    }
    if (text.trim().length === 0) return;
    if (this.state.appState.isReplaying) {
      this.showError('Cannot send input while session history is replaying.');
      return;
    }
    // Shell commands are stored with a leading `!` so ↑ recall can tell them
    // apart from prompts and restore bash mode (see CustomEditor's mode-aware
    // history navigation). The `!` is stripped again when the entry is recalled.
    const historyText = wasBashMode ? `!${text}` : text;
    void this.persistInputHistory(historyText);
    if (wasBashMode) {
      // Only one foreground action at a time: queue the shell command while
      // another shell command or an agent turn is in progress.
      if (this.state.appState.streamingPhase !== 'idle') {
        this.bashQueue.push({ id: randomUUID(), text });
        this.track('input_queue');
        this.updateQueueDisplay();
        this.state.ui.requestRender();
        return;
      }
      void this.runShellCommandFromInput(text);
      return;
    }
    slashCommands.dispatchInput(this, text);
  }

  private async runShellCommandFromInput(command: string): Promise<void> {
    let session = this.session;
    if (session === undefined) {
      session = await this.ensureSession();
      if (session === undefined) return;
      // A concurrent first message may have started a prompt while this lazy
      // creation was in flight; honor the busy gate here instead of running
      // the shell command concurrently with an agent turn.
      if (this.state.appState.streamingPhase !== 'idle') {
        this.bashQueue.push({ id: randomUUID(), text: command });
        this.updateQueueDisplay();
        this.state.ui.requestRender();
        return;
      }
    }
    const main = this.mainAgent();
    if (main === undefined) return;
    const shellCommands = main.resolve(ShellCommandRef);
    if (shellCommands === undefined) {
      this.showError('Shell commands are not available in this session.');
      return;
    }
    // Echo the command locally (bash-input) with a `$` prompt.
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: currentTheme.fg('shellMode', `$ ${command}`),
      bullet: '',
    });
    // Create the live output entry up front. ShellRunComponent owns its own
    // rendering (running card → final view) and is mutated in place as output
    // streams in and on completion.
    const commandId = randomUUID();
    const outputEntry: TranscriptEntry = {
      id: commandId,
      kind: 'status',
      turnId: undefined,
      renderMode: 'plain',
      content: '',
    };
    const outputComponent = new ShellRunComponent(() => this.state.ui.requestRender());
    // Inherit the current ctrl+o state, same as freshly mounted tool calls —
    // the global toggle only reaches components that exist when it fires.
    if (this.state.toolOutputExpanded) outputComponent.setExpanded(true);
    this.shellOutputStreams.set(commandId, { entry: outputEntry, component: outputComponent });
    this.state.transcriptEntries.push(outputEntry);
    markTranscriptComponent(outputComponent, outputEntry);
    this.state.transcriptContainer.addChild(outputComponent);
    // Treat command execution as a streaming phase so input queues, the activity
    // pane shows the moon spinner, and ctrl+b is enabled while it runs.
    this.setAppState({ streamingPhase: 'shell' });
    this.state.ui.requestRender();

    this.track('shell_command');

    void shellCommands.run({ command, commandId }).then(
      ({ stdout, stderr, isError, backgrounded }) => {
        this.finishShellOutput(commandId, stdout, stderr, isError, backgrounded);
      },
      (error: unknown) => {
        const message = formatErrorMessage(error);
        this.finishShellOutput(commandId, '', message, true);
        this.showError(`Shell command failed: ${message}`);
      },
    );
  }

  handleShellOutput(commandId: string, text: string): void {
    const stream = this.shellOutputStreams.get(commandId);
    if (stream === undefined) return;
    if (text.length === 0) return;
    stream.component.append(text);
  }

  cancelRunningShellCommand(): void {
    const main = this.mainAgent();
    if (main === undefined) return;
    const shellCommands = main.resolve(ShellCommandRef);
    if (shellCommands === undefined) return;
    for (const commandId of this.shellOutputStreams.keys()) {
      shellCommands.cancel(commandId);
    }
  }

  private finishShellOutput(
    commandId: string,
    stdout: string,
    stderr: string,
    isError?: boolean,
    backgrounded?: boolean,
  ): void {
    const stream = this.shellOutputStreams.get(commandId);
    if (stream === undefined) return;
    if (backgrounded === true) {
      // The command moved to the background after its timeout; the ack remind
      // carries the details and the footer task badge tracks it from here.
      stream.component.finishBackgrounded();
      stream.entry.content = 'Moved to background.';
      this.shellOutputStreams.delete(commandId);
    } else {
      stream.component.finish(stdout, stderr, isError);
      // Keep the transcript entry's metadata in sync for anything that reads it
      // (export / copy). The component renders itself.
      stream.entry.content = formatBashOutputForDisplay(stdout, stderr, isError);
      this.shellOutputStreams.delete(commandId);
    }
    // When the last shell command finishes, leave the shell streaming phase
    // and release one queued bash command (if any).
    if (this.shellOutputStreams.size === 0) {
      this.setAppState({ streamingPhase: 'idle' });
      this.drainBashQueue();
    }
  }

  drainBashQueue(): void {
    if (this.state.appState.streamingPhase !== 'idle') return;
    const next = this.bashQueue.shift();
    if (next === undefined) return;
    this.updateQueueDisplay();
    void this.runShellCommandFromInput(next.text);
  }

  async sendNormalUserInput(text: string): Promise<void> {
    // An open btw panel captures prompt-mode submits as follow-up questions.
    if (this.btwPanelController.sendUserInput(text)) return;
    if (this.state.appState.model.trim().length === 0) {
      this.showError(LLM_NOT_SET_MESSAGE);
      return;
    }
    let extraction: ExtractionResult;
    // A just-pasted image may still be finishing its background ingestion
    // (compression): give it a bounded moment so the submit uses the final
    // bytes. Undefined when nothing is pending, keeping the media-free send
    // path synchronous.
    const ingestionWait = pendingMediaIngestions(
      text,
      this.imageStore,
      MEDIA_INGESTION_SUBMIT_WAIT_MS,
    );
    if (ingestionWait !== undefined) await ingestionWait;
    try {
      extraction = extractMediaAttachments(text, this.imageStore);
    } catch (error) {
      this.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
      return;
    }
    if (!this.validateMediaCapabilities(extraction)) return;
    const session = await this.ensureSession();
    if (session === undefined) return;
    this.submitUserMessage(session, text, extraction);
    this.updateQueueDisplay();
    this.state.ui.requestRender();
  }

  private submitUserMessage(
    session: KimiSession,
    text: string,
    extraction?: ExtractionResult,
  ): void {
    const main = this.mainAgent();
    if (main === undefined) {
      this.failSessionRequest('Failed to send: the agent is not running.');
      return;
    }
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: text,
      imageAttachmentIds:
        extraction !== undefined && extraction.imageAttachmentIds.length > 0
          ? extraction.imageAttachmentIds
          : undefined,
    });
    if (this.state.appState.streamingPhase === 'idle') {
      this.beginSessionRequest();
    }
    const content =
      extraction !== undefined && extraction.hasMedia
        ? extraction.parts
        : [{ type: 'text' as const, text }];
    const ack = main.submit(
      { role: 'user', content },
      { origin: { kind: 'user' }, tracked: true, promptId: randomUUID() },
    );
    if (ack === undefined) {
      this.failSessionRequest('Failed to send: the agent is not running.');
    }
  }

  validateMediaCapabilities(extraction: {
    hasMedia: boolean;
    imageAttachmentIds: readonly number[];
  }): boolean {
    if (!extraction.hasMedia) return true;
    if (
      extraction.imageAttachmentIds.length > 0 &&
      !this.supportsCurrentModelCapability('image_in')
    ) {
      this.showError('Current model does not support image input.');
      return false;
    }
    return true;
  }

  private supportsCurrentModelCapability(capability: string): boolean {
    const capabilities =
      this.state.appState.availableModels[this.state.appState.model]?.capabilities;
    if (capabilities === undefined) return true;
    return capabilities.includes(capability);
  }

  private async loadPersistedInputHistory(): Promise<void> {
    try {
      const file = getInputHistoryFile(this.state.appState.workDir);
      const entries = await loadInputHistory(file);
      for (const entry of entries) {
        this.state.editor.addToHistory(entry.content);
      }
      this.lastHistoryContent = entries.at(-1)?.content;
    } catch {
      // best-effort
    }
  }

  private async persistInputHistory(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (trimmed === this.lastHistoryContent) return;
    this.state.editor.addToHistory(trimmed);
    try {
      const file = getInputHistoryFile(this.state.appState.workDir);
      const written = await appendInputHistory(file, trimmed, this.lastHistoryContent);
      if (written) this.lastHistoryContent = trimmed;
    } catch {
      this.lastHistoryContent = trimmed;
    }
  }

  /**
   * Recall the most recently queued engine-queue item into the editor:
   * cancels it in the engine and restores its text as the draft.
   */
  recallLastQueued(): { text: string; mode?: 'prompt' | 'bash' } | undefined {
    if (this.bashQueue.length > 0) {
      const last = this.bashQueue.pop()!;
      this.updateQueueDisplay();
      return { text: last.text, mode: 'bash' };
    }
    const queued = this.engineQueueItems();
    const last = queued.at(-1);
    if (last === undefined) return undefined;
    this.session?.main.cancel(last.id);
    this.updateQueueDisplay();
    return { text: last.text };
  }

  // =========================================================================
  // Session Requests
  // =========================================================================

  beginSessionRequest(): void {
    this.streamingUI.resetLiveText();
    this.streamingUI.resetToolUi();
    this.patchLivePane({
      mode: 'waiting',
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.setAppState({
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
  }

  failSessionRequest(message: string): void {
    this.setAppState({ streamingPhase: 'idle' });
    this.resetLivePane();
    this.showError(message);
  }

  /**
   * Engine queue items (prompts submitted while the agent is busy), mapped
   * for the queue pane. Sourced live from the agent machine snapshot.
   */
  engineQueueItems(): QueuePaneItem[] {
    const snapshot = this.mainAgent()?.snapshot.value;
    if (snapshot === undefined) return [];
    return snapshot.context.queue.map((entry) => ({
      id: entry.meta?.promptId ?? nextTranscriptId(),
      text: entry.message.content
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join(''),
      kind: 'prompt' as const,
    }));
  }

  queuePaneItems(): QueuePaneItem[] {
    return [
      ...this.engineQueueItems(),
      ...this.bashQueue.map((item) => ({
        id: item.id,
        text: item.text,
        kind: 'bash' as const,
      })),
    ];
  }

  /**
   * Ctrl-S: steer every steerable queued prompt into the running turn, then
   * (when given) submit the editor draft and steer it too.
   */
  steerQueuedAndDraft(draft: string | undefined): void {
    const main = this.mainAgent();
    if (main === undefined) return;
    const phase = this.state.appState.streamingPhase;
    if (phase === 'idle' || phase === 'shell') return;
    const queued = this.engineQueueItems();
    if (queued.length > 0) {
      main.steer(queued.map((item) => item.id));
    }
    if (draft !== undefined && draft.trim().length > 0) {
      let extraction: ExtractionResult | undefined;
      try {
        const result = extractMediaAttachments(draft, this.imageStore);
        if (result.hasMedia) extraction = result;
      } catch (error) {
        this.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
        return;
      }
      if (extraction !== undefined && !this.validateMediaCapabilities(extraction)) return;
      const promptId = randomUUID();
      this.appendTranscriptEntry({
        id: nextTranscriptId(),
        kind: 'user',
        turnId: this.streamingUI.getTurnContext().turnId,
        renderMode: 'plain',
        content: draft,
        imageAttachmentIds:
          extraction !== undefined && extraction.imageAttachmentIds.length > 0
            ? extraction.imageAttachmentIds
            : undefined,
      });
      const content =
        extraction !== undefined ? extraction.parts : [{ type: 'text' as const, text: draft }];
      main.submit(
        { role: 'user', content },
        { origin: { kind: 'user' }, tracked: true, promptId },
      );
      main.steer([promptId]);
    }
    this.updateQueueDisplay();
  }

  /** Esc / Ctrl+C: abort the running turn and drop every queued prompt. */
  cancelOngoingWork(): void {
    const main = this.mainAgent();
    if (main === undefined) return;
    this.cancelRunningShellCommand();
    for (const item of this.engineQueueItems()) {
      main.cancel(item.id);
    }
    this.bashQueue = [];
    main.abort();
    this.updateQueueDisplay();
  }

  cancelCurrentCompaction(): void {
    const main = this.mainAgent();
    if (main === undefined) return;
    // Compaction feature not mounted — nothing to cancel.
    main.resolve(CompactionRef)?.cancel();
  }

  /**
   * Fork a read-only side agent and open the BTW panel with the question.
   * The panel owns follow-up prompts while it is open (see sendNormalUserInput).
   */
  async askBtw(question: string): Promise<void> {
    const trimmed = question.trim();
    if (trimmed.length === 0) return;
    const session = await this.ensureSession();
    if (session === undefined) return;
    const btw = session.handle.resolve(BtwRef);
    if (btw === undefined) {
      this.showError('Failed to start /btw: btw feature is not installed');
      return;
    }
    try {
      const { agentId } = await btw.ask();
      this.btwPanelController.open(agentId, trimmed);
    } catch (error) {
      this.showError(`Failed to start /btw: ${formatErrorMessage(error)}`);
    }
  }

  // =========================================================================
  // State & Accessors
  // =========================================================================

  setStartupReady(): void {
    this.state.startupState = 'ready';
  }

  pushTranscriptEntry(entry: TranscriptEntry): void {
    this.state.transcriptEntries.push(entry);
  }

  setExternalEditorRunning(running: boolean): void {
    this.state.externalEditorRunning = running;
  }

  appendStartupNotice(extra: string): void {
    this.startupNotice = combineStartupNotice(this.startupNotice, extra);
  }

  getCurrentSessionId(): string {
    return this.state.appState.sessionId;
  }

  hasSessionContent(): boolean {
    return this.state.transcriptEntries.length > 0;
  }

  setExitOpenUrl(url: string): void {
    this.exitOpenUrl = url;
  }

  setExitForegroundTask(task: (exitCode: number) => Promise<void>): void {
    this.exitForegroundTask = task;
  }

  async getStartupMcpMs(): Promise<number> {
    return 0;
  }

  configDefaultModel(): string | undefined {
    const value = this.harness.config.get<unknown>('defaultModel');
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  setAppState(patch: Partial<AppState>): void {
    if (!hasPatchChanges(this.state.appState, patch)) return;
    Object.assign(this.state.appState, patch);
    if ('planMode' in patch) this.updateEditorBorderHighlight();
    this.state.footer.setState(this.state.appState);
    this.updateActivityPane();
    this.state.ui.requestRender();
  }

  patchLivePane(patch: Partial<LivePaneState>): void {
    if (!hasPatchChanges(this.state.livePane, patch)) return;
    Object.assign(this.state.livePane, patch);
    this.updateActivityPane();
    this.state.ui.requestRender();
  }

  resetLivePane(): void {
    this.state.livePane = { ...INITIAL_LIVE_PANE };
    this.updateActivityPane();
    this.state.ui.requestRender();
  }

  // =========================================================================
  // Session Runtime
  // =========================================================================

  requireSession(): KimiSession {
    if (this.session === undefined) {
      throw new Error(NO_ACTIVE_SESSION_MESSAGE);
    }
    return this.session;
  }

  /**
   * The live main agent handle. Undo and compaction swap the agent's branch
   * and remount it, so the handle captured at session creation goes stale —
   * always resolve through the session handle first.
   */
  mainAgent(): AgentHandle | undefined {
    const session = this.session;
    if (session === undefined) return undefined;
    return session.handle.get(MAIN_AGENT_ID) ?? session.main;
  }

  /**
   * Compaction swaps the main agent's branch and leaves it paused; the host
   * owns the remount. The resulting `agent.opened` event re-runs the event
   * subscription (see SessionEventHandler).
   */
  async remountMainAgent(): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    try {
      if (session.handle.get(MAIN_AGENT_ID) !== undefined) {
        await session.handle.close(MAIN_AGENT_ID);
      }
      await session.handle.create({ agentId: MAIN_AGENT_ID });
    } catch (error) {
      this.showError(`Failed to resume after compaction: ${formatErrorMessage(error)}`);
    }
  }

  /**
   * The main agent was remounted by the engine (undo / host remount after
   * compaction): rebind every subscription and facade watcher to the new
   * handle.
   */
  onMainAgentRemounted(): void {
    if (this.aborted) return;
    this.sessionEventHandler.startSubscription();
    this.updateQueueDisplay();
  }

  /**
   * Seed appState with the config defaults (model, thinking effort, plan
   * mode), so the footer reflects them while no session exists.
   */
  hydrateLazyConfigDefaults(): void {
    const { startup } = this.options;
    const patch: Partial<AppState> = {};
    const startupModel = startup.model ?? this.configDefaultModel();
    if (startupModel !== undefined) {
      patch.model = startupModel;
      const selected = this.state.appState.availableModels[startupModel];
      if (selected?.maxContextSize !== undefined) {
        patch.maxContextTokens = selected.maxContextSize;
      }
    } else {
      patch.model = '';
      patch.maxContextTokens = 0;
    }
    const effort = thinkingEffortFromConfig(
      this.harness.config.get<{ enabled?: boolean; effort?: string } | undefined>('thinking'),
    );
    if (effort !== undefined) {
      patch.thinkingEffort = effort;
    }
    if (this.harness.config.get<boolean>('defaultPlanMode') === true && !startup.plan) {
      patch.planMode = true;
    }
    this.setAppState(patch);
  }

  refreshAvailableModels(): void {
    const catalog = this.harness.app.resolve(ProviderCatalogRef);
    // Provider catalog not mounted — keep the previous model list.
    if (catalog === undefined) return;
    try {
      const { models, providers } = collectAvailableModels(catalog);
      const patch: Partial<AppState> = { availableModels: models, availableProviders: providers };
      // The managed catalog can land after the session-less footer defaults
      // were hydrated — backfill the active model's context cap when it does.
      const selected = models[this.state.appState.model];
      if (selected?.maxContextSize !== undefined) {
        patch.maxContextTokens = selected.maxContextSize;
      }
      this.setAppState(patch);
    } catch {
      // Provider catalog not mounted — keep the previous model list.
    }
  }

  /**
   * Lazy-create the session on first use. Returns the existing session, or
   * creates one and runs the same assembly `createNewSession` performs.
   * Returns undefined and shows the error when creation fails.
   *
   * Concurrent first-use triggers (a double Enter, or a slash command right
   * after a prompt) both observe `session === undefined`, so the first caller
   * owns the creation and the rest share the in-flight promise.
   */
  async ensureSession(): Promise<KimiSession | undefined> {
    if (this.ensureSessionPromise !== null) return this.ensureSessionPromise;
    if (this.session !== undefined) return this.session;
    this.ensureSessionPromise = this.lazyCreateSession().finally(() => {
      this.ensureSessionPromise = null;
    });
    return this.ensureSessionPromise;
  }

  /** Await the in-flight lazy session creation, if any; no-op otherwise. */
  async waitForLazyCreation(): Promise<void> {
    await this.ensureSessionPromise;
  }

  private async lazyCreateSession(): Promise<KimiSession | undefined> {
    let session: KimiSession;
    try {
      session = await this.createSessionWithStartupProfile();
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to start a session: ${msg}`);
      return undefined;
    }
    this.resetSessionRuntime();
    await this.setSession(session);
    this.sessionEventHandler.startSubscription();
    this.applyStartupFlagOverrides();
    return session;
  }

  /**
   * `--agent` / `--agent-file` bind the main agent's system prompt at session
   * creation: the profile renders its prompt and the main agent is created
   * with it explicitly (the default creation path would freeze the default
   * profile's prompt into the agent spec).
   */
  private async createSessionWithStartupProfile(): Promise<KimiSession> {
    return createSessionWithStartupProfile(this.harness, {
      agentName: this.startupAgentName,
      agentFile: this.startupAgentFile,
      cwd: this.state.appState.workDir,
    });
  }

  async setSession(session: KimiSession): Promise<void> {
    const previous = this.session;
    this.sessionEventHandler.stopSubscription();
    this.tasksBrowserController.close();
    this.btwPanelController.clear();
    this.session = session;
    this.harness.setTelemetryContext({ sessionId: session.id });
    this.setAppState({ sessionId: session.id });
    // The session record's meta event fired when the session was opened —
    // before the TUI subscribed — so sync the title directly.
    try {
      const record = await this.harness.app.space.get(session.id);
      this.setAppState({ sessionTitle: record?.title ?? null });
    } catch {
      this.setAppState({ sessionTitle: null });
    }
    if (previous !== undefined && previous.id !== session.id) {
      await previous.close();
    }
  }

  /**
   * Apply CLI startup overrides (`-m`, `-y`/`--auto`, `--plan`) to the live
   * session via the feature facades. Runs once after the (lazy or resumed)
   * session is up; the facade watchers then own the footer state.
   */
  private applyStartupFlagOverrides(): void {
    const session = this.session;
    if (session === undefined) return;
    const { startup } = this.options;
    if (startup.model !== undefined && startup.model !== this.configDefaultModel()) {
      void this.applyModelChoice(startup.model);
    }
    if (startup.auto) {
      void this.applyPermissionChoice('auto');
    } else if (startup.yolo) {
      void this.applyPermissionChoice('yolo');
    }
    if (startup.plan && !this.state.appState.planMode) {
      void this.applyPlanEnter();
    }
  }

  private async applyModelChoice(alias: string): Promise<void> {
    const main = this.mainAgent();
    if (main === undefined) return;
    try {
      const agentModel = main.resolve(AgentModelRef);
      if (agentModel === undefined) throw new Error('provider-catalog agent model is not available');
      await agentModel.setModel(alias);
    } catch (error) {
      this.showError(`Failed to switch model: ${formatErrorMessage(error)}`);
    }
  }

  private async applyPermissionChoice(
    mode: PermissionMode,
  ): Promise<void> {
    const main = this.mainAgent();
    if (main === undefined) return;
    try {
      const permission = main.resolve(PermissionRef);
      if (permission === undefined) throw new Error('permission feature is not installed');
      await permission.setModeAndBroadcast(mode);
    } catch (error) {
      this.showError(`Failed to set permission mode: ${formatErrorMessage(error)}`);
    }
  }

  private async applyPlanEnter(): Promise<void> {
    const main = this.mainAgent();
    if (main === undefined) return;
    try {
      const plan = main.resolve(PlanRef);
      if (plan === undefined) throw new Error('plan feature is not installed');
      await plan.enter();
    } catch (error) {
      this.showError(`Failed to enter plan mode: ${formatErrorMessage(error)}`);
    }
  }

  async closeSession(reason: string): Promise<void> {
    void reason;
    const previous = this.session;
    this.sessionEventHandler.stopSubscription();
    this.session = undefined;
    this.harness.setTelemetryContext({ sessionId: null });
    this.setAppState({ goal: null });
    await previous?.close();
  }

  async fetchSessions(): Promise<void> {
    this.state.loadingSessions = true;
    try {
      const sessions = await this.listSessionsByRecency();
      this.state.sessions = sessions.map((session) =>
        sessionRowForRecord(session, this.state.appState.workDir),
      );
    } catch (error) {
      // The picker must keep working (it renders the empty state), but a
      // swallowed failure surfaces as a misleading "No sessions found." —
      // keep a log trail so the real error stays discoverable.
      log.warn('failed to fetch sessions for picker', { error: String(error) });
    } finally {
      this.state.loadingSessions = false;
    }
  }

  private async listSessionsByRecency(): Promise<readonly SessionListEntry[]> {
    return listSessionsByRecency(this.harness, this.state.appState.workDir);
  }

  updateTerminalTitle(): void {
    const trimmed = this.state.appState.sessionTitle?.trim() ?? '';
    const label = trimmed.length > 0 ? trimmed.slice(0, MAX_TERMINAL_TITLE_LENGTH) : PRODUCT_NAME;
    this.state.terminal.setTitle(label);
  }

  resetSessionRuntime(): void {
    this.aborted = false;
    this.surveyController.reset();
    this.streamingUI.discardPending();
    this.bashQueue = [];
    this.state.swarmModeEntry = undefined;
    this.streamingUI.resetToolCallState();
    this.streamingUI.resetToolUi();
    this.state.footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0 });
    this.streamingUI.setTodoList([]);
    this.streamingUI.setTurnId(undefined);
    this.setAppState({ mcpServersSummary: null });
    this.streamingUI.setStep(0);
    this.streamingUI.resetLiveText();
    this.updateQueueDisplay();
  }

  private async showResumeOtherWorkDirHint(session: SessionRow): Promise<void> {
    this.hideSessionPicker();
    const command = `cd ${quoteShellArg(session.work_dir)} && kimi --resume ${quoteShellArg(session.id)}`;
    const message = `Current session is in a different working directory.\n  To resume, run: ${command}`;
    try {
      await copyTextToClipboard(command);
      this.showStatus(`${message}\n  Command copied to clipboard`, 'warning');
    } catch {
      this.showStatus(`${message}\n  Failed to copy command to clipboard`, 'warning');
    }
  }

  private async resumeSession(targetSessionId: string): Promise<boolean> {
    // A first-use lazy creation may still be in flight: wait it out so the
    // checks below see settled state — the pending prompt would otherwise
    // replace the resumed session when creation completes.
    await this.waitForLazyCreation();
    if (targetSessionId === this.state.appState.sessionId) {
      this.showStatus('Already on this session.');
      return true;
    }
    if (this.state.appState.streamingPhase !== 'idle') {
      this.showError('Cannot switch sessions while streaming — press Esc or Ctrl-C first.');
      return false;
    }

    let session: KimiSession;
    try {
      session = await this.harness.resumeSession(targetSessionId);
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to resume session ${targetSessionId}: ${msg}`);
      return false;
    }

    await this.switchToSession(session, `Resumed session (${session.id}).`);
    return true;
  }

  async switchToSession(session: KimiSession, statusMessage: string): Promise<void> {
    const previousId = this.session?.id;
    this.resetSessionRuntime();
    await this.setSession(session);
    if (session.id !== previousId) {
      this.clearTranscriptAndRedraw();
      this.sessionReplay.hydrate(session);
    }
    this.updateTerminalTitle();
    this.sessionEventHandler.startSubscription();
    this.showStatus(statusMessage);
  }

  async reloadCurrentSessionView(session: KimiSession, statusMessage: string): Promise<void> {
    this.sessionEventHandler.stopSubscription();
    this.resetSessionRuntime();
    this.session = session;
    this.harness.setTelemetryContext({ sessionId: session.id });
    this.updateTerminalTitle();
    this.sessionEventHandler.startSubscription();
    this.showStatus(statusMessage);
  }

  async createNewSession(): Promise<void> {
    const planModeWasActive = this.state.appState.planMode;
    const permissionMode = this.state.appState.permissionMode;
    let session: KimiSession;
    try {
      session = await this.createSessionWithStartupProfile();
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to start a new session: ${msg}`);
      return;
    }

    this.resetSessionRuntime();
    await this.setSession(session);
    this.sessionEventHandler.startSubscription();
    this.clearTranscriptAndRedraw();
    // Carry the live modes into the fresh session (config defaults alone
    // would reset them).
    if (permissionMode !== 'manual') {
      void this.applyPermissionChoice(permissionMode);
    }
    if (planModeWasActive) {
      void this.applyPlanEnter();
    }
    this.showStatus(`Started a new session (${session.id}).`);
    void this.showConfigWarningsIfAny();
  }

  /** Surface config.toml load warnings (degraded or kept-previous config) in the status bar. */
  private async showConfigWarningsIfAny(): Promise<void> {
    try {
      for (const diagnostic of this.harness.config.diagnostics()) {
        this.showStatus(diagnostic.message, 'warning');
      }
    } catch {
      /* diagnostics are best-effort */
    }
  }

  // =========================================================================
  // Transcript Rendering
  // =========================================================================

  private createTranscriptComponent(entry: TranscriptEntry): Component | null {
    if (entry.compactionData !== undefined) {
      const data = entry.compactionData;
      const block = new CompactionComponent(this.state.ui, data.instruction);
      if (data.result === 'cancelled') {
        block.markCanceled();
      } else {
        block.markDone(data.tokensBefore, data.tokensAfter, data.summary);
        if (this.state.toolOutputExpanded) {
          block.setExpanded(true);
        }
      }
      return block;
    }

    switch (entry.kind) {
      case 'user': {
        const images = entry.imageAttachmentIds
          ?.map((id) => this.imageStore.get(id))
          .filter((a): a is ImageAttachment => a?.kind === 'image');
        return new UserMessageComponent(entry.content, images, entry.bullet);
      }
      case 'skill_activation':
        return new SkillActivationComponent(
          entry.skillName ?? entry.content,
          entry.skillArgs,
          entry.skillTrigger,
        );
      case 'cron':
        return new CronMessageComponent(entry.content, entry.cronData ?? {});
      case 'assistant': {
        const component = new AssistantMessageComponent();
        component.updateContent(entry.content);
        return component;
      }
      case 'thinking': {
        const thinking = new ThinkingComponent(entry.content, true);
        if (this.state.toolOutputExpanded) thinking.setExpanded(true);
        return thinking;
      }
      case 'tool_call':
        if (entry.toolCallData) {
          const tc = new ToolCallComponent(
            entry.toolCallData,
            entry.toolCallData.result,
            this.state.ui,
            this.state.appState.workDir,
          );
          if (this.state.toolOutputExpanded) tc.setExpanded(true);
          return tc;
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(entry.content, entry.detail)
          : new StatusMessageComponent(entry.content, entry.color);
      case 'status':
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(entry.content, entry.detail)
          : new StatusMessageComponent(entry.content, entry.color);
      case 'welcome':
        return null;
      default:
        return null;
    }
  }

  appendTranscriptEntry(entry: TranscriptEntry): void {
    this.state.transcriptEntries.push(entry);
    const component = this.createTranscriptComponent(entry);
    if (component) {
      markTranscriptComponent(component, entry);
      this.state.transcriptContainer.addChild(component);
    }
    const trimmed = this.trimTranscriptWindow();
    const merged = this.mergeCurrentTurnSteps();
    if (component || trimmed || merged) {
      this.state.ui.requestRender();
    }
  }

  private appendApprovalTranscriptEntry(
    request: ApprovalPanelData,
    response: ApprovalPanelResponse,
  ): void {
    if (request.tool_name === 'ExitPlanMode') return;
    const parts: string[] = [];
    switch (response.response) {
      case 'approved':
        parts.push('Approved');
        break;
      case 'approved_for_session':
        parts.push('Approved for session');
        break;
      case 'rejected':
        parts.push('Rejected');
        break;
      case 'cancelled':
        parts.push('Cancelled');
        break;
    }
    parts.push(`: ${request.action}`);
    if (response.feedback !== undefined && response.feedback.length > 0) {
      parts.push(` — "${response.feedback}"`);
    }
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'status',
      turnId: this.streamingUI.getTurnContext().turnId,
      renderMode: 'notice',
      content: parts.join(''),
    });
  }

  private renderWelcome(): void {
    if (
      this.state.transcriptContainer.children.some((child) => child instanceof WelcomeComponent)
    ) {
      return;
    }
    const welcome = new WelcomeComponent(this.state.appState);
    this.state.transcriptContainer.addChild(welcome);
  }

  private clearTerminalInlineImages(): void {
    if (getCapabilities().images !== 'kitty') return;
    this.state.terminal.write(deleteAllKittyImages());
  }

  private disposeTranscriptChildren(): void {
    // Dispose disposable children (e.g. ShellRunComponent's 1s timer,
    // ThinkingComponent's spinner) before dropping them, so a /clear, session
    // switch, or shutdown can't leak intervals that keep firing requestRender
    // on a removed component.
    for (const child of this.state.transcriptContainer.children) {
      if (hasDispose(child)) child.dispose();
    }
  }

  private clearTranscriptAndRedraw(): void {
    this.streamingUI.discardPending();
    this.state.transcriptEntries = [];
    this.streamingUI.disposeActiveCompactionBlock();
    this.streamingUI.resetLiveText();
    this.streamingUI.resetToolUi();
    this.disposeTranscriptChildren();
    this.state.transcriptContainer.clear();
    this.clearTerminalInlineImages();
    this.state.todoPanel.clear();
    this.state.todoPanelContainer.clear();
    this.imageStore.clear();
    this.renderWelcome();
    // No forced full render on session reset: let the differential renderer
    // converge on its own (a mass change above the viewport still makes the
    // engine repaint everything, but nothing is forced destructively here).
    this.state.ui.requestRender();
  }

  private isTurnBoundaryComponent(child: Component): boolean {
    if (
      !(child instanceof UserMessageComponent) &&
      !(child instanceof SkillActivationComponent) &&
      !(child instanceof ReplayTurnBoundaryComponent)
    ) {
      return false;
    }
    const entry = getTranscriptComponentEntry(child);
    if (entry === undefined) return false;
    // Turn-starting entries (live or replayed) carry an undefined turnId;
    // steer messages carry the running turn's id and are not boundaries.
    return entry.turnId === undefined;
  }

  /**
   * Fold-segment boundary: everything {@link isTurnBoundaryComponent} counts,
   * plus the cron card. A cron-fired turn mounts no user message, so without
   * the card as a boundary its output would share the previous user turn's
   * fold segment — and the completed-turn assistant cap would fold that turn's
   * final answer into the step summary.
   */
  private isFoldSegmentBoundaryComponent(child: Component): boolean {
    return this.isTurnBoundaryComponent(child) || child instanceof CronMessageComponent;
  }

  private trimTranscriptWindow(): boolean {
    if (!TRANSCRIPT_WINDOW_ENABLED || TRANSCRIPT_MAX_TURNS <= 0) return false;
    // Session replay already caps history to its own turn limit; trimming during
    // replay would shrink it further and fight that limit.
    if (this.state.appState.isReplaying) return false;

    const children = this.state.transcriptContainer.children;

    // Trim whole turns by *position* in the child list rather than by entry
    // lookup — otherwise only the (registered) user message would be removed and
    // the rest of the turn would be left behind.
    const boundaries: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (this.isTurnBoundaryComponent(children[i]!)) boundaries.push(i);
    }

    const turns = groupTurns(this.state.transcriptEntries);

    const toRemove = turnsToTrim(turns, TRANSCRIPT_MAX_TURNS, TRANSCRIPT_HYSTERESIS);
    if (toRemove.size === 0) return false;

    // Reclaim image bytes referenced by trimmed user messages. The transcript
    // renders historical thumbnails via imageStore.get(id), so an attachment can
    // only be dropped once its owning user message leaves the transcript.
    for (const entry of toRemove) {
      if (entry.kind === 'user' && entry.imageAttachmentIds !== undefined) {
        this.imageStore.removeMany(entry.imageAttachmentIds);
      }
    }

    let boundariesToRemove = 0;
    for (const entry of toRemove) {
      if (entry.kind === 'user' && entry.turnId === undefined) {
        boundariesToRemove++;
      }
    }
    if (boundariesToRemove === 0) {
      this.state.transcriptEntries = this.state.transcriptEntries.filter((e) => !toRemove.has(e));
      return true;
    }

    let boundariesSeen = 0;
    let cutoff = 0;
    for (let i = 0; i < children.length; i++) {
      if (this.isTurnBoundaryComponent(children[i]!)) {
        if (boundariesSeen === boundariesToRemove) {
          cutoff = i;
          break;
        }
        boundariesSeen++;
      }
    }

    const componentsToRemove: Component[] = [];
    for (let i = 0; i < cutoff; i++) {
      const child = children[i]!;
      if (child instanceof WelcomeComponent) continue;
      componentsToRemove.push(child);
    }
    for (const child of componentsToRemove) {
      // pi-tui Container.removeChild (not a DOM node); `child.remove()` does not exist.
      // oxlint-disable-next-line unicorn/prefer-dom-node-remove
      this.state.transcriptContainer.removeChild(child);
      if (hasDispose(child)) child.dispose();
    }

    this.state.transcriptEntries = this.state.transcriptEntries.filter((e) => !toRemove.has(e));
    return true;
  }

  mergeCurrentTurnSteps(): boolean {
    return this.foldCurrentTurnContent(
      TRANSCRIPT_KEEP_RECENT_STEPS,
      TRANSCRIPT_KEEP_RECENT_ASSISTANT,
    );
  }

  /**
   * Fold the just-finished turn's assistant messages down to the completed-turn
   * cap: while a turn is live it may keep TRANSCRIPT_KEEP_RECENT_ASSISTANT
   * messages mounted, but once it ends only the conclusion-bearing tail stays.
   * Called when a turn finishes; the finished turn is still the current one at
   * that point (no newer boundary exists yet).
   */
  mergeCompletedTurnAssistants(): boolean {
    return this.foldCurrentTurnContent(
      TRANSCRIPT_KEEP_RECENT_STEPS,
      TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED,
    );
  }

  private foldCurrentTurnContent(keepSteps: number, keepAssistants: number): boolean {
    if (keepSteps <= 0 && keepAssistants <= 0) return false;
    const children = this.state.transcriptContainer.children;

    // Find the start of the current fold segment.
    let turnStart = -1;
    for (let i = children.length - 1; i >= 0; i--) {
      if (this.isFoldSegmentBoundaryComponent(children[i]!)) {
        turnStart = i;
        break;
      }
    }
    if (turnStart < 0) return false;

    // Locate an existing summary, the assistant messages, and the mergeable steps.
    let summaryIndex = -1;
    const stepIndices: number[] = [];
    const assistantIndices: number[] = [];
    for (let i = turnStart + 1; i < children.length; i++) {
      const child = children[i]!;
      if (child instanceof StepSummaryComponent) {
        summaryIndex = i;
        continue;
      }
      if (child instanceof AssistantMessageComponent) {
        assistantIndices.push(i);
        continue;
      }
      stepIndices.push(i);
    }

    // Fold the oldest steps / assistant messages beyond their respective caps;
    // the most recent ones stay mounted. Children are chronological, so the
    // oldest of each kind sit at the front of their index lists.
    const stepMergeCount = keepSteps > 0 ? Math.max(0, stepIndices.length - keepSteps) : 0;
    const assistantMergeCount =
      keepAssistants > 0 ? Math.max(0, assistantIndices.length - keepAssistants) : 0;
    if (stepMergeCount === 0 && assistantMergeCount === 0) return false;
    const toMergeIndices = [
      ...stepIndices.slice(0, stepMergeCount),
      ...assistantIndices.slice(0, assistantMergeCount),
    ];

    let thinkingCount = 0;
    let toolCount = 0;
    for (const idx of toMergeIndices) {
      const child = children[idx]!;
      if (child instanceof ThinkingComponent) thinkingCount++;
      else if (child instanceof ToolCallComponent) toolCount++;
    }
    if (thinkingCount === 0 && toolCount === 0 && assistantMergeCount === 0) return false;

    let summary: StepSummaryComponent;
    if (summaryIndex >= 0) {
      summary = children[summaryIndex] as StepSummaryComponent;
      summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
    } else {
      summary = new StepSummaryComponent();
      summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
    }

    // Rebuild children: keep everything except the merged steps, with the summary
    // sitting right after the user message.
    const toMergeSet = new Set(toMergeIndices);
    const newChildren: Component[] = [];
    for (let i = 0; i <= turnStart; i++) newChildren.push(children[i]!);
    newChildren.push(summary);
    for (let i = turnStart + 1; i < children.length; i++) {
      if (i === summaryIndex) continue;
      if (toMergeSet.has(i)) continue;
      newChildren.push(children[i]!);
    }

    for (const idx of toMergeIndices) {
      const child = children[idx]!;
      if (hasDispose(child)) child.dispose();
    }

    children.splice(0, children.length, ...newChildren);
    return true;
  }

  mergeAllTurnSteps(): void {
    if (TRANSCRIPT_KEEP_RECENT_STEPS <= 0 && TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED <= 0)
      return;
    const children = this.state.transcriptContainer.children;

    const boundaries: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (this.isFoldSegmentBoundaryComponent(children[i]!)) boundaries.push(i);
    }
    if (boundaries.length === 0) return;

    const newChildren: Component[] = [];
    const toDispose: Component[] = [];
    for (let i = 0; i < boundaries[0]!; i++) newChildren.push(children[i]!);

    for (let t = 0; t < boundaries.length; t++) {
      const turnStart = boundaries[t]!;
      const turnEnd = t + 1 < boundaries.length ? boundaries[t + 1]! : children.length;
      newChildren.push(children[turnStart]!);

      let summaryIndex = -1;
      const stepIndices: number[] = [];
      const assistantIndices: number[] = [];
      for (let i = turnStart + 1; i < turnEnd; i++) {
        const child = children[i]!;
        if (child instanceof StepSummaryComponent) summaryIndex = i;
        else if (child instanceof AssistantMessageComponent) assistantIndices.push(i);
        else stepIndices.push(i);
      }

      const stepMergeCount =
        TRANSCRIPT_KEEP_RECENT_STEPS > 0
          ? Math.max(0, stepIndices.length - TRANSCRIPT_KEEP_RECENT_STEPS)
          : 0;
      // Replayed turns are all completed turns, so the stricter completed-turn
      // assistant cap applies (matching what live turns fold to on turn end).
      const assistantMergeCount =
        TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED > 0
          ? Math.max(0, assistantIndices.length - TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED)
          : 0;
      if (stepMergeCount > 0 || assistantMergeCount > 0) {
        const toMergeIndices = [
          ...stepIndices.slice(0, stepMergeCount),
          ...assistantIndices.slice(0, assistantMergeCount),
        ];
        let thinkingCount = 0;
        let toolCount = 0;
        for (const idx of toMergeIndices) {
          const child = children[idx]!;
          if (child instanceof ThinkingComponent) thinkingCount++;
          else if (child instanceof ToolCallComponent) toolCount++;
        }
        let summary: StepSummaryComponent;
        if (summaryIndex >= 0) {
          summary = children[summaryIndex] as StepSummaryComponent;
          summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
        } else {
          summary = new StepSummaryComponent();
          summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
        }
        newChildren.push(summary);
        for (const idx of toMergeIndices) toDispose.push(children[idx]!);
        const toMergeSet = new Set(toMergeIndices);
        for (let i = turnStart + 1; i < turnEnd; i++) {
          if (i === summaryIndex) continue;
          if (toMergeSet.has(i)) continue;
          newChildren.push(children[i]!);
        }
      } else {
        for (let i = turnStart + 1; i < turnEnd; i++) newChildren.push(children[i]!);
      }
    }

    for (const child of toDispose) {
      if (hasDispose(child)) child.dispose();
    }
    children.splice(0, children.length, ...newChildren);
  }

  showStatus(message: string, color?: ColorToken): void {
    this.state.transcriptContainer.addChild(new StatusMessageComponent(message, color));
    this.state.ui.requestRender();
  }

  showNotice(title: string, detail?: string): void {
    this.state.transcriptContainer.addChild(new NoticeMessageComponent(title, detail));
    this.state.ui.requestRender();
  }

  showError(message: string): void {
    this.showStatus(`Error: ${message}`, 'error');
  }

  showLoginProgressSpinner(label: string): LoginProgressSpinnerHandle {
    return this.showProgressSpinner(label);
  }

  showProgressSpinner(label: string): LoginProgressSpinnerHandle {
    const tint = (s: string): string => currentTheme.fg('primary', s);
    const spinner = new MoonLoader(this.state.ui, 'braille', tint, label);
    this.state.transcriptContainer.addChild(new Spacer(1));
    this.state.transcriptContainer.addChild(spinner);
    this.state.ui.requestRender();
    return {
      stop: ({ ok, label: finalLabel }) => {
        spinner.stop();
        const tone = ok ? 'success' : 'error';
        const symbol = ok ? '✓' : '✗';
        spinner.setText(currentTheme.fg(tone, `${symbol} ${finalLabel}`));
        this.state.ui.requestRender();
      },
      setLabel: (nextLabel) => {
        spinner.setLabel(nextLabel);
      },
    };
  }

  showLoginAuthorizationPrompt(auth: DeviceAuthorization): LoginProgressSpinnerHandle {
    openUrl(auth.verificationUriComplete);
    this.state.transcriptContainer.addChild(
      new DeviceCodeBoxComponent({
        title: 'Sign in to Kimi Code',
        url: auth.verificationUriComplete,
        code: auth.userCode,
        hint: 'Press Ctrl-C to cancel',
      }),
    );
    this.state.ui.requestRender();
    return this.showLoginProgressSpinner('Waiting for authorization…');
  }

  // =========================================================================
  // Panes / Presentation State
  // =========================================================================

  updateActivityPane(): void {
    const effectiveMode = this.resolveActivityPaneMode();
    const tipKind = loadingTipKind(effectiveMode);
    // Pick a fresh loading tip when the loading kind changes. The same kind
    // covers waiting/tool (both moon spinners) and any intermediate thinking
    // phase, so a continuous burst of tool calls does not flip tips. Clear the
    // cache only when there is no loading UI at all.
    if (effectiveMode === 'idle' || effectiveMode === 'session' || effectiveMode === 'hidden') {
      this.currentLoadingTip = undefined;
    } else if (
      tipKind !== undefined &&
      (this.currentLoadingTip === undefined || this.currentLoadingTip.kind !== tipKind)
    ) {
      const previousTip = this.currentLoadingTip?.tip;
      this.currentLoadingTip = {
        kind: tipKind,
        tip: pickRandomWorkingTip(previousTip)?.text,
      };
    }
    this.syncTerminalProgress(this.shouldShowTerminalProgress(effectiveMode));
    // Carry the retry state in the mode key so an incoming/cleared
    // `llm.retrying` rebuilds the waiting pane with fresh label and
    // detail instead of hitting the cached-pane early return below.
    const retry = effectiveMode === 'waiting' ? this.state.appState.stepRetry : null;
    const retryKey =
      retry === null ? '' : `${formatStepRetryLabel(retry)}|${formatStepRetryDetail(retry)}`;
    const activityModeKey = `${effectiveMode}:${retryKey}`;

    if (
      activityModeKey === this.lastActivityMode &&
      (effectiveMode === 'waiting' || effectiveMode === 'thinking' || effectiveMode === 'tool')
    ) {
      return;
    }

    this.lastActivityMode = activityModeKey;
    this.state.activityContainer.clear();

    switch (effectiveMode) {
      case 'hidden':
        this.stopActivitySpinner();
        this.state.ui.requestRender();
        return;
      case 'waiting': {
        const stepRetry = this.state.appState.stepRetry;
        const spinner = this.ensureActivitySpinner('moon', waitingSpinnerLabel(stepRetry));
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'waiting',
            spinner,
            tip: stepRetry === null ? this.currentLoadingTip?.tip : undefined,
            detail: stepRetry === null ? undefined : formatStepRetryDetail(stepRetry),
          }),
        );
        break;
      }
      case 'thinking': {
        this.stopActivitySpinner();
        break;
      }
      case 'composing': {
        const spinner = this.ensureActivitySpinner('braille', 'working…', (s) =>
          currentTheme.fg('primary', s),
        );
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'composing',
            spinner,
            tip: this.currentLoadingTip?.tip,
          }),
        );
        break;
      }
      case 'tool': {
        const spinner = this.ensureActivitySpinner('moon');
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'tool',
            spinner,
            tip: this.currentLoadingTip?.tip,
          }),
        );
        break;
      }
      case 'idle':
      case 'session': {
        this.stopActivitySpinner();
        // Keep a placeholder row so the activity area does not fully shrink
        // when the spinner is removed at the end of streaming; combined with
        // pi-tui's clamp, this avoids a destructive full redraw (viewport jump).
        this.state.activityContainer.addChild(new Spacer(1));
        break;
      }
    }
    this.state.ui.requestRender();
  }

  private resolveActivityPaneMode(): EffectiveActivityPaneMode {
    if (this.state.activeDialog === 'session-picker') return 'hidden';
    if (this.state.livePane.pendingApproval !== null) return 'hidden';
    if (this.state.appState.isCompacting) return 'hidden';
    if (this.state.livePane.pendingQuestion !== null) return 'hidden';

    const streamingPhase = this.state.appState.streamingPhase;

    // A running `!` shell command shows the moon spinner (same as `waiting`)
    // until it finishes, signalling that input is busy / queued.
    if (streamingPhase === 'shell') return 'waiting';

    if (this.state.livePane.mode === 'idle') {
      if (streamingPhase === 'thinking' || streamingPhase === 'composing') {
        return streamingPhase;
      }
    }

    return this.state.livePane.mode;
  }

  updateQueueDisplay(): void {
    this.state.queueContainer.clear();
    const queued = this.queuePaneItems();
    if (queued.length === 0) return;

    this.state.queueContainer.addChild(
      new QueuePaneComponent({
        messages: queued,
        isCompacting: this.state.appState.isCompacting,
        isStreaming: this.state.appState.streamingPhase !== 'idle',
        canSteerImmediately: this.state.appState.streamingPhase !== 'idle',
      }),
    );
  }

  /**
   * Index of the first transcript child ctrl+o may expand: a component is
   * expandable only if it sits at or after the start of the
   * (totalTurns - expandTurns)-th turn, i.e. it belongs to one of the most
   * recent `expandTurns` turns. Position-based so it also covers streaming
   * components that have no entry in the metadata map.
   */
  private expandCutoff(children: readonly Component[]): number {
    const boundaries: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (this.isTurnBoundaryComponent(children[i]!)) boundaries.push(i);
    }
    return expandCutoffIndex(children.length, boundaries, TRANSCRIPT_EXPAND_TURNS);
  }

  /**
   * What the footer's ctrl+o hint should offer: `expand` while a card in the
   * expandable window keeps content out of its collapsed form, `collapse`
   * once the toggle shows it, `null` when ctrl+o would change nothing.
   */
  private toolOutputExpandHint(): 'expand' | 'collapse' | null {
    const children = this.state.transcriptContainer.children;
    if (this.state.toolOutputExpanded) {
      // Toggling off collapses every expanded card, including one that slid
      // out of the expansion window since it was expanded, so any expanded
      // card with hidden content keeps the collapse hint on.
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        if (isExpandedComponent(child) && hasHiddenContent(child)) return 'collapse';
      }
      return null;
    }
    const cutoff = this.expandCutoff(children);
    for (let i = children.length - 1; i >= cutoff; i--) {
      if (hasHiddenContent(children[i])) return 'expand';
    }
    return null;
  }

  toggleToolOutputExpansion(): void {
    this.state.toolOutputExpanded = !this.state.toolOutputExpanded;
    const children = this.state.transcriptContainer.children;
    const expandCutoff = this.expandCutoff(children);

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (!isExpandable(child)) continue;
      child.setExpanded(this.state.toolOutputExpanded && i >= expandCutoff);
    }
    // Differential render only — no destructive full redraw on expand/collapse.
    // (When the expanded region reaches above the viewport, the engine's own
    // fallback may still do a full render; that path is not forced from here.)
    this.state.ui.requestRender();
  }

  toggleTodoPanelExpansion(): void {
    this.state.todoPanel.toggleExpanded();
    this.state.ui.requestRender();
  }

  toggleNotifyPanelFocus(): boolean {
    return false;
  }

  handleNotifyPanelKey(_key: 'left' | 'right' | 'up' | 'down' | 'escape'): boolean {
    return false;
  }

  async detachCurrentForegroundTask(): Promise<void> {
    // A running `!` shell command takes priority over agent foreground tasks.
    if (this.shellOutputStreams.size > 0) {
      this.showDetachHint('Shell commands already run in the background after their timeout.');
      return;
    }

    const session = this.session;
    if (session === undefined) {
      this.showError(NO_ACTIVE_SESSION_MESSAGE);
      return;
    }
    let bash: ReturnType<typeof resolveBash> | undefined;
    try {
      bash = resolveBash(session);
    } catch {
      bash = undefined;
    }
    const running = bash?.running() ?? [];
    const target = running[0];
    if (bash === undefined || target === undefined) {
      this.showDetachHint('No foreground task running.');
      return;
    }
    if (bash.detach(target)) {
      this.showDetachHint('Moved to background.');
      return;
    }
    this.showDetachHint('Task already finished.');
  }

  /** Show a one-shot footer hint that auto-clears after DETACH_HINT_DISPLAY_MS. */
  private showDetachHint(hint: string): void {
    if (this.detachHintClearTimer !== undefined) {
      clearTimeout(this.detachHintClearTimer);
      this.detachHintClearTimer = undefined;
    }
    this.state.footer.setTransientHint(hint);
    this.detachHintClearTimer = setTimeout(() => {
      this.detachHintClearTimer = undefined;
      // Don't clobber a newer transient hint (e.g. the exit-confirmation
      // prompt) that took over while this timer was pending.
      if (this.state.footer.getTransientHint() !== hint) return;
      this.state.footer.setTransientHint(null);
      this.state.ui.requestRender();
    }, DETACH_HINT_DISPLAY_MS);
    this.state.ui.requestRender();
  }

  updateEditorBorderHighlight(text?: string): void {
    const trimmed = (text ?? this.state.editor.getText()).trimStart();
    const isBash = this.state.appState.inputMode === 'bash';
    const highlighted = this.state.appState.planMode || isBash || trimmed.startsWith('/');
    this.state.editor.borderHighlighted = highlighted;
    // Shell mode gets its own hue; plan-mode and slash context stay primary.
    const borderToken = isBash ? 'shellMode' : highlighted ? 'primary' : 'border';
    this.state.editor.borderColor = (s: string) => currentTheme.fg(borderToken, s);
    this.state.ui.requestRender();
  }

  updateGoalLengthWarning(text: string | undefined): void {
    const warning = text === undefined ? undefined : goalObjectiveLengthWarning(text);
    this.state.footer.setWarningHint(warning ?? null);
  }

  async applyTheme(themeName: ThemeName, resolved?: ResolvedTheme): Promise<void> {
    const palette = await getColorPalette(themeName === 'auto' ? (resolved ?? 'dark') : themeName);
    currentTheme.setPalette(palette);
    this.setAppState({ theme: themeName });
    this.updateEditorBorderHighlight();
    // Force every historical message to re-render so Markdown/Text caches
    // (which hold old ANSI colour codes) are cleared.
    this.state.transcriptContainer.invalidate();
    this.state.ui.requestRender(true);
  }

  refreshTerminalThemeTracking(): void {
    this.stopTerminalThemeTracking();
    if (!isBuiltInTheme(this.state.appState.theme) || this.state.appState.theme !== 'auto') return;

    this.terminalThemeTrackingDispose = installTerminalThemeTracking(this.state, (resolved) => {
      void this.applyResolvedAutoTheme(resolved);
    });
  }

  private stopTerminalThemeTracking(): void {
    this.terminalThemeTrackingDispose?.();
    this.terminalThemeTrackingDispose = undefined;
  }

  private async applyResolvedAutoTheme(resolved: ResolvedTheme): Promise<void> {
    if (this.state.appState.theme !== 'auto') return;
    const palette = getBuiltInPalette(resolved);
    if (currentTheme.palette === palette) return;
    currentTheme.setPalette(palette);
    this.updateEditorBorderHighlight();
    // Repaint already-rendered transcript entries (status/markdown caches hold
    // old ANSI codes), matching applyTheme()'s behaviour.
    this.state.transcriptContainer.invalidate();
    this.state.ui.requestRender(true);
  }

  private shouldShowTerminalProgress(effectiveMode: EffectiveActivityPaneMode): boolean {
    if (this.state.appState.isCompacting) return true;
    return (
      effectiveMode === 'waiting' ||
      effectiveMode === 'thinking' ||
      effectiveMode === 'composing' ||
      effectiveMode === 'tool'
    );
  }

  private syncTerminalProgress(active: boolean): void {
    if (!this.state.terminalState.supportsProgress) return;
    if (this.state.terminalState.progressActive === active) return;
    this.state.terminal.setProgress(active);
    this.state.terminalState.progressActive = active;
  }

  private ensureActivitySpinner(
    style: SpinnerStyle,
    label = '',
    colorFn?: (s: string) => string,
  ): MoonLoader {
    if (this.state.activitySpinner?.style !== style) {
      this.stopActivitySpinner();
    }

    if (this.state.activitySpinner === null) {
      const instance = new MoonLoader(this.state.ui, style, colorFn, label);
      this.state.activitySpinner = { instance, style };
      return instance;
    }

    this.state.activitySpinner.instance.setLabel(label);
    if (colorFn !== undefined) {
      this.state.activitySpinner.instance.setColorFn(colorFn);
    }
    return this.state.activitySpinner.instance;
  }

  private stopActivitySpinner(): void {
    if (this.state.activitySpinner !== null) {
      this.state.activitySpinner.instance.stop();
      this.state.activitySpinner = null;
    }
  }

  // =========================================================================
  // Dialogs / Selectors
  // =========================================================================

  mountEditorReplacement(panel: Component & Focusable): void {
    this.surveyController.closeSilently();
    this.state.editorReplacementMounted = true;
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(panel);
    this.state.ui.setFocus(panel);
    this.state.ui.requestRender();
  }

  restoreEditor(): void {
    this.state.editorReplacementMounted = false;
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(this.state.editor);
    this.state.ui.setFocus(this.state.editor);
    // Differential render only: closing a tall panel leaves the editor a few
    // rows above the bottom (blank tail) until the next append, but avoids a
    // destructive full redraw on every dialog close.
    this.state.ui.requestRender();
  }

  restoreInputText(text: string): void {
    this.restoreEditor();
    this.state.editor.setText(text);
    this.updateEditorBorderHighlight(text);
    this.state.ui.requestRender();
  }

  private async runMigrationScreen(plan: MigrationPlan): Promise<MigrationScreenResult> {
    const result = await new Promise<MigrationScreenResult>((resolve) => {
      const screen = new MigrationScreenComponent({
        plan,
        sourceHome: plan.sourceHome,
        targetHome: this.harness.homeDir,
        skipDecisionStep: this.migrateOnly,
        requestRender: () => {
          this.state.ui.requestRender();
        },
        onComplete: (r) => {
          resolve(r);
        },
      });
      this.mountEditorReplacement(screen);
    });
    this.restoreEditor();
    if (result.decision === 'never') {
      // Persist the skip marker `detectPendingMigration` checks, so "Never ask
      // again" actually stops the prompt from reappearing every launch.
      try {
        writeFileSync(join(this.harness.homeDir, '.skip-migration-from-kimi-cli'), '', 'utf-8');
      } catch {
        // Non-blocking: a failed marker write must never crash startup.
      }
    }
    return result;
  }

  /**
   * Startup gate: before any session is created, ask whether to trust this
   * folder when the workspace is not trusted yet (project-level MCP servers
   * stay disabled while untrusted). Best-effort throughout — a failed check
   * or trust write never blocks startup. Choosing "don't trust" (or Esc)
   * exits the program before any session is created; the prompt reappears on
   * the next launch: the engine's untrusted state is indistinguishable from
   * never-trusted. Returns true when the prompt started the event loop (the
   * caller must not start it again).
   *
   * A granted trust is persisted and then applied to the current launch by
   * recreating the harness: the mount captured `trusted: false` for the MCP
   * and external-hooks features before the prompt ran, so the running instance
   * would otherwise keep the workspace's MCP servers gated until the next
   * launch.
   */
  private async maybeRunWorkspaceTrustPrompt(): Promise<boolean> {
    const workDir = this.state.appState.workDir;
    let trusted = false;
    try {
      trusted = this.harness.trust.isTrusted(workDir);
    } catch {
      return false;
    }
    if (trusted) return false;
    this.startEventLoop();
    const choice = await new Promise<TrustPromptChoice>((resolve) => {
      this.state.activeDialog = 'trust-prompt';
      this.mountEditorReplacement(
        new TrustPromptComponent({
          workDir,
          gatedMcpServers: [],
          onSelect: (c) => {
            resolve(c);
          },
        }),
      );
    });
    this.state.activeDialog = null;
    if (choice !== 'trust') {
      // Declining trust exits the program (Claude Code's "No, exit" semantics):
      // stop() runs the standard shutdown path and ends in process.exit. The
      // editor is NOT restored first — its frame would linger as an orphaned
      // input box above the exit message; the prompt stays as the last frame.
      await this.stop();
      return true;
    }
    this.restoreEditor();
    try {
      this.harness.trust.trust(workDir);
    } catch {
      // A failed write leaves the workspace untrusted (re-asked next launch).
    }
    await this.recreateHarnessAfterTrustGrant();
    return true;
  }

  /**
   * Swap the untrusted harness for one created after the trust grant so MCP
   * servers and hooks honor the grant in this launch. Only valid while no
   * session exists — the trust prompt runs before any session is created.
   * The new harness is built before the old one closes so a creation failure
   * keeps the old (untrusted) harness usable and aborts startup with the
   * original error.
   */
  private async recreateHarnessAfterTrustGrant(): Promise<void> {
    const factory = this.harnessFactory;
    if (factory === undefined || this.session !== undefined) return;
    const recreated = await factory();
    await this.closeCurrentHarness();
    this.harness = recreated;
    this.harnessClosed = false;
  }

  private async closeCurrentHarness(): Promise<void> {
    if (this.harnessClosed) return;
    this.harnessClosed = true;
    await this.harness.close();
  }

  showHelpPanel(): void {
    this.state.activeDialog = 'help';
    this.mountEditorReplacement(
      new HelpPanelComponent({
        commands: this.getSlashCommands(),
        onClose: () => {
          this.hideHelpPanel();
        },
      }),
    );
  }

  private hideHelpPanel(): void {
    this.state.activeDialog = null;
    this.restoreEditor();
  }

  private sessionPickerOptions: {
    readonly applyStartupModes: boolean;
    readonly closeOnCancel: boolean;
    readonly forwardEditorExit: boolean;
  } = {
    applyStartupModes: false,
    closeOnCancel: false,
    forwardEditorExit: false,
  };
  private sessionPickerComponent: SessionPickerComponent | undefined;

  async showSessionPicker(): Promise<void> {
    await this.openSessionPicker({
      applyStartupModes: false,
      closeOnCancel: false,
      forwardEditorExit: false,
    });
  }

  private async bootstrapFromPicker(): Promise<void> {
    await this.openSessionPicker({
      applyStartupModes: true,
      closeOnCancel: true,
      forwardEditorExit: true,
    });
  }

  private async openSessionPicker(options: {
    readonly applyStartupModes: boolean;
    readonly closeOnCancel: boolean;
    readonly forwardEditorExit: boolean;
  }): Promise<void> {
    this.sessionPickerOptions = options;
    await this.fetchSessions();
    this.remountSessionPicker();
  }

  private remountSessionPicker(initialSelectedSessionId?: string): void {
    this.mountSessionPicker({
      initialSelectedSessionId,
      applyStartupModes: this.sessionPickerOptions.applyStartupModes,
      onCancel: () => {
        this.hideSessionPicker();
        if (this.sessionPickerOptions.closeOnCancel) void this.stop();
      },
      onCtrlC: this.sessionPickerOptions.forwardEditorExit
        ? () => {
            this.state.editor.onCtrlC?.();
          }
        : undefined,
      onCtrlD: this.sessionPickerOptions.forwardEditorExit
        ? () => {
            this.state.editor.onCtrlD?.();
          }
        : undefined,
    });
  }

  hideSessionPicker(): void {
    this.sessionPickerComponent = undefined;
    this.editorKeyboard.clearPendingExit();
    this.state.activeDialog = null;
    this.restoreEditor();
  }

  private async deleteSessionFromPicker(session: SessionRow): Promise<void> {
    try {
      await this.waitForLazyCreation();
      if (session.id === this.state.appState.sessionId && this.session !== undefined) {
        await this.deleteCurrentSessionFromPicker(session);
        return;
      }
      await this.harness.deleteSession(session.id);
      // fetchSessions swallows refetch errors, so drop the row locally first —
      // a failed refetch must not resurrect it in the remounted list.
      this.state.sessions = this.state.sessions.filter((row) => row.id !== session.id);
      await this.fetchSessions();
      if (this.state.activeDialog !== 'session-picker') return;
      this.remountSessionPicker();
      this.showStatus('Session deleted.');
    } catch (error) {
      this.showError(`Failed to delete session ${session.id}: ${formatErrorMessage(error)}`);
    }
  }

  private async deleteCurrentSessionFromPicker(session: SessionRow): Promise<void> {
    // The picker stays mounted (locking input) until the replacement session
    // is ready — restoring the editor mid-flight would let a prompt race the swap.
    try {
      // Tear down before deleting so no events from the dying session reach the UI.
      await this.closeSession('deleting session');
      await this.harness.deleteSession(session.id);
    } catch (error) {
      const message = `Failed to delete session ${session.id}: ${formatErrorMessage(error)}`;
      try {
        const resumed = await this.harness.resumeSession(session.id);
        await this.switchToSession(resumed, `Resumed session (${resumed.id}).`);
      } catch {
        // Reattach failed and the session is already unloaded: detach before
        // the fallback create so a failed create leaves no ghost UI behind.
        this.setAppState({ sessionId: '' });
        this.clearTranscriptAndRedraw();
        await this.createNewSession();
      }
      this.showError(message);
      this.hideSessionPicker();
      return;
    }
    // The session is gone whether or not replacement creation succeeds: detach
    // first so a failed create leaves no ghost (stale id + transcript) behind.
    this.setAppState({ sessionId: '' });
    this.clearTranscriptAndRedraw();
    await this.createNewSession();
    this.hideSessionPicker();
  }

  openUndoSelector(): void {
    void slashCommands.handleUndoCommand(this, '');
  }

  private mountSessionPicker(options: {
    readonly onCancel: () => void;
    readonly onCtrlC?: () => void;
    readonly onCtrlD?: () => void;
    readonly initialSelectedSessionId?: string;
    // CLI mode flags (--auto/--yolo/--plan) target the session picked at
    // startup (bare --session); later /sessions switches keep the picked
    // session's own persisted modes.
    readonly applyStartupModes?: boolean;
  }): void {
    this.state.activeDialog = 'session-picker';
    const picker = new SessionPickerComponent({
      sessions: this.state.sessions,
      loading: this.state.loadingSessions,
      currentSessionId: this.state.appState.sessionId,
      initialSelectedSessionId: options.initialSelectedSessionId,
      onSelect: (session: SessionRow) =>
        this.handleSessionPickerSelect(session, options.applyStartupModes === true).catch(
          (error) => {
            this.showError(`Failed to apply startup flags: ${formatErrorMessage(error)}`);
          },
        ),
      onCancel: options.onCancel,
      onCtrlC: options.onCtrlC,
      onCtrlD: options.onCtrlD,
      onDeleteRequest: (session: SessionRow) => this.deleteSessionFromPicker(session),
    });
    this.sessionPickerComponent = picker;
    this.mountEditorReplacement(picker);
  }

  private async handleSessionPickerSelect(
    session: SessionRow,
    applyStartupModes: boolean,
  ): Promise<void> {
    if (session.work_dir !== '' && session.work_dir !== this.state.appState.workDir) {
      await this.showResumeOtherWorkDirHint(session);
      if (applyStartupModes) await this.stop(0);
      return;
    }

    const switched = await this.resumeSession(session.id);
    if (!switched) return;
    if (applyStartupModes) {
      this.applyStartupFlagOverrides();
    }
    this.hideSessionPicker();
  }

  private showApprovalPanel(payload: ApprovalPanelData): void {
    this.patchLivePane({ pendingApproval: { data: payload } });
    notifyTerminalOnce(this.state, `approval:${payload.id}`, {
      title: 'Kimi Code approval required',
      body: payload.tool_name,
    });
    const panel = new ApprovalPanelComponent(
      { data: payload },
      (response: ApprovalPanelResponse) => {
        this.interactionController.respondApproval(response);
      },
      () => {
        this.toggleToolOutputExpansion();
      },
      (block) => {
        this.openApprovalPreview(panel, block);
      },
    );
    this.activeApprovalPanel = panel;
    this.mountEditorReplacement(panel);
  }

  private hideApprovalPanel(): void {
    // If the full-screen preview is open, fold it back first so the saved-
    // children stack stays consistent with what mountEditorReplacement set up.
    if (this.approvalPreview !== undefined) this.closeApprovalPreview();
    this.activeApprovalPanel = undefined;
    this.patchLivePane({ pendingApproval: null });
    this.restoreEditor();
  }

  // Mounts the full-screen approval preview viewer on top of the current
  // approval panel. Uses the same nested-takeover pattern as
  // openTaskOutputViewer: beginScreenTakeover swaps the viewer in (root
  // children in regular mode, the layout root in fullscreen) and closing restores
  // it. The approval panel instance is
  // kept around in `activeApprovalPanel` so its selection state survives.
  private openApprovalPreview(panel: ApprovalPanelComponent, block: ApprovalPreviewBlock): void {
    if (this.approvalPreview !== undefined) return;
    const viewer = new ApprovalPreviewViewer(
      {
        block,
        onClose: () => {
          this.closeApprovalPreview();
        },
      },
      this.state.terminal,
    );
    const takeover = beginScreenTakeover(this.state.ui, viewer);
    this.state.ui.setFocus(viewer);
    this.state.ui.requestRender(true);
    this.approvalPreview = { component: viewer, takeover, panel };
  }

  private closeApprovalPreview(): void {
    const preview = this.approvalPreview;
    if (preview === undefined) return;
    this.approvalPreview = undefined;
    endScreenTakeover(this.state.ui, preview.takeover);
    this.state.ui.setFocus(preview.panel);
    this.state.ui.requestRender(true);
  }

  private showQuestionDialog(payload: QuestionPanelData): void {
    this.patchLivePane({ pendingQuestion: { data: payload } });
    notifyTerminalOnce(this.state, `question:${payload.id}`, {
      title: 'Kimi Code needs your answer',
      body: payload.questions[0]?.question,
    });
    const dialog = new QuestionDialogComponent(
      { data: payload },
      (response) => {
        this.interactionController.respondQuestion(response);
      },
      6,
      () => {
        this.toggleToolOutputExpansion();
      },
    );
    this.mountEditorReplacement(dialog);
  }

  private hideQuestionDialog(): void {
    this.patchLivePane({ pendingQuestion: null });
    this.restoreEditor();
  }
}

function sessionRowForRecord(
  session: SessionListEntry,
  workDir: string,
): SessionRow {
  return {
    id: session.id,
    title: session.title ?? null,
    work_dir: workDir,
    updated_at: session.updatedAtMs,
  };
}

function resolveBash(session: KimiSession): {
  running(): readonly string[];
  detach(toolCallId: string): boolean;
} {
  const main = session.handle.get(MAIN_AGENT_ID) ?? session.main;
  const bash = main.resolve(BashRef);
  if (bash === undefined) throw new Error('bash feature is not installed');
  return bash;
}
