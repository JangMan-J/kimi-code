import type { TokenUsage } from '@moonshot-ai/agent-core';
import type { PermissionMode } from '@moonshot-ai/harness-core';
import type { GoalSnapshot } from '@moonshot-ai/harness-core';

import type { NotificationsConfig, StatusLineConfig, UpgradePreferences } from './config';
import type { PendingApproval, PendingQuestion } from './reverse-rpc/types';
import type { ColorToken, ThemeName } from './theme';

export type { PermissionMode, TokenUsage };

export type ThinkingEffort = string;

export interface ModelAlias {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly maxContextSize?: number;
  readonly maxOutputSize?: number;
  readonly capabilities?: readonly string[];
  readonly displayName?: string;
  readonly reasoningKey?: string;
  readonly protocol?: string;
  readonly adaptiveThinking?: boolean;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly offEffort?: string;
  readonly alwaysThinking?: boolean;
}

export interface ProviderConfig {
  readonly type?: string;
  readonly baseUrl?: string;
  readonly oauth?: unknown;
}

export type BannerDisplay = 'always' | 'once' | 'cooldown';

export interface BannerState {
  key: string;
  tag: string | null;
  mainText: string;
  subText: string | null;
  display: BannerDisplay;
  ttlHours?: number;
}

export interface AppState {
  model: string;
  workDir: string;
  sessionId: string;
  permissionMode: PermissionMode;
  planMode: boolean;
  /** 'bash' when the editor is in `!` shell-command mode. */
  inputMode: 'prompt' | 'bash';
  swarmMode: boolean;
  towerMode: boolean;
  /** Live thinking effort of the active session (e.g. 'off', 'on', 'high');
   * mirrors the runtime. The single source of truth for the thinking state in
   * the TUI. */
  thinkingEffort: ThinkingEffort;
  contextUsage: number;
  contextTokens: number;
  maxContextTokens: number;
  cumulativeTokens?: number;
  isCompacting: boolean;
  isReplaying: boolean;
  streamingPhase: 'idle' | 'waiting' | 'thinking' | 'composing' | 'shell';
  streamingStartTime: number;
  /** Pending LLM retry backoff (fed by `llm.retrying`); null when no retry is in flight. */
  stepRetry: StepRetryState | null;
  theme: ThemeName;
  version: string;
  editorCommand: string | null;
  /** Mirrors the TUI config toggle; defaults to false when absent from older fixtures. */
  disablePasteBurst?: boolean;
  /** LaTeX math rendering in Markdown; defaults to true when absent from older fixtures. */
  renderLatex?: boolean;
  /** Mirrors the TUI config toggle; defaults to true when absent from older fixtures. */
  cacheExpiryHint?: boolean;
  disableFeedbackSurvey?: boolean;
  notifications: NotificationsConfig;
  upgrade: UpgradePreferences;
  /** Footer status line customization from tui.toml; absent means the default layout. */
  statusLine?: StatusLineConfig;
  availableModels: Record<string, ModelAlias>;
  availableProviders: Record<string, ProviderConfig>;
  sessionTitle: string | null;
  /** Current goal snapshot for the footer badge; null/undefined when no active goal. */
  goal?: GoalSnapshot | null;
  mcpServersSummary: string | null;
  /** Optional banner shown below the welcome panel; null means no banner to render. */
  banner?: BannerState | null;
}

export function sumTokenUsage(total: TokenUsage): number {
  return total.inputOther + total.output + total.inputCacheRead + total.inputCacheCreation;
}

export interface StepRetryState {
  /** Upcoming attempt number (1-based). */
  nextAttempt: number;
  maxAttempts: number;
  /** Backoff wait before the next attempt, in milliseconds. */
  delayMs: number;
  errorName: string;
  errorMessage: string;
  /** HTTP status code for `APIStatusError`; undefined for network/timeout failures. */
  statusCode?: number;
  /**
   * `backoff` while sleeping before the next attempt (label shows the
   * countdown); `attempt` once the next request has been sent — the countdown
   * has expired by then and is dropped.
   */
  phase: 'backoff' | 'attempt';
}

export interface ToolCallBlockData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description?: string;
  streamingArguments?: string;
  streamingStartedAtMs?: number;
  result?: ToolResultBlockData;
  subagent?: SubagentReplayBlockData;
  step?: number;
  turnId?: string;
  /** Set when the step ended (e.g. max_tokens) before the tool call's
   *  arguments finished streaming. Renderer flips the header verb to
   *  "Truncated" and stops showing the in-progress argument preview. */
  truncated?: boolean;
}

export interface ToolResultBlockData {
  tool_call_id: string;
  output: string;
  is_error?: boolean;
  synthetic?: boolean;
}

export interface SubagentReplayToolCallData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description?: string;
  result?: ToolResultBlockData;
}

export interface SubagentReplayBlockData {
  id: string;
  name?: string;
  text?: string;
  toolCalls?: readonly SubagentReplayToolCallData[];
}

export interface CompactionTranscriptData {
  readonly result?: 'cancelled';
  readonly summary?: string;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly instruction?: string;
}

export interface CronTranscriptData {
  readonly jobId?: string;
  readonly cron?: string;
  readonly recurring?: boolean;
  readonly coalescedCount?: number;
  readonly stale?: boolean;
  readonly missedCount?: number;
}

export type TranscriptEntryKind =
  | 'welcome'
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'thinking'
  | 'status'
  | 'skill_activation'
  | 'cron';

export type SkillActivationTrigger = 'user-slash' | 'model-tool' | 'nested-skill';

export interface TranscriptEntry {
  id: string;
  kind: TranscriptEntryKind;
  turnId?: string;
  renderMode: 'markdown' | 'plain' | 'notice';
  content: string;
  /**
   * True only for entries holding real model-authored text (created by the
   * assistant stream). Derived cards — hook results, goal completions, goal
   * reminders — share kind 'assistant' but are not replies, so /copy must
   * skip them.
   */
  modelText?: boolean;
  color?: ColorToken;
  detail?: string;
  /** Optional override for the leading bullet of a 'user' message entry. An empty string suppresses the bullet entirely (used by shell-command echoes so `$` replaces the sparkles marker). */
  bullet?: string;
  toolCallData?: ToolCallBlockData;
  compactionData?: CompactionTranscriptData;
  cronData?: CronTranscriptData;
  imageAttachmentIds?: readonly number[];
  skillActivationId?: string;
  skillName?: string;
  skillArgs?: string;
  skillTrigger?: SkillActivationTrigger;
  /** Entry renders a UserPromptSubmit hook result (sits inside its prompt's group window). */
  hookResult?: boolean;
}

export type LivePaneMode =
  | 'idle'
  | 'waiting'
  | 'thinking'
  | 'tool'
  | 'session';

export interface LivePaneState {
  mode: LivePaneMode;
  pendingApproval: PendingApproval | null;
  pendingQuestion: PendingQuestion | null;
}

export interface QueuePaneItem {
  readonly id: string;
  readonly text: string;
  readonly kind: 'prompt' | 'bash';
}

export interface InlineSkillActivation {
  readonly skillName: string;
  /**
   * Skill arguments. Only set for a leading `/skill:<name> args` command that
   * is combined with further inline skills; inline tokens carry no args.
   */
  readonly args?: string;
}

export const INITIAL_LIVE_PANE: LivePaneState = {
  mode: 'idle',
  pendingApproval: null,
  pendingQuestion: null,
};

// ---------------------------------------------------------------------------
// TUI startup / options types (extracted from kimi-tui.ts)
// ---------------------------------------------------------------------------

export interface TUIStartupOptions {
  readonly sessionFlag?: string;
  readonly continueLast: boolean;
  readonly yolo: boolean;
  readonly auto: boolean;
  readonly plan: boolean;
  readonly model?: string;
  readonly startupNotice?: string;
}

export type TUIStartupState = 'pending' | 'ready' | 'picker';

export interface KimiTUIOptions {
  initialAppState: AppState;
  startup: TUIStartupOptions;
}

export interface PendingExit {
  readonly kind: 'ctrl-c' | 'ctrl-d';
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface LoginProgressSpinnerHandle {
  stop(opts: { ok: boolean; label: string }): void;
  setLabel(label: string): void;
}

export type ProgressSpinnerHandle = LoginProgressSpinnerHandle;
