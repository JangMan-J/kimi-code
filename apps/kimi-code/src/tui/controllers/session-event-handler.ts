import {
  AgentModelRef,
  MAIN_AGENT_ID,
  type AgentEmitted,
  type AgentHandle,
  type LlmRetrying,
  type SessionRecord,
  type TurnOutcome,
} from '@moonshot-ai/agent-core';
import { watch } from '@moonshot-ai/agent-core/kernel/index';
import {
  GoalRef,
  PermissionRef,
  PlanRef,
  TaskRef,
  TodoRef,
  TokenCountingRef,
  UsageRef,
  type GoalChange,
  type GoalSnapshot,
} from '@moonshot-ai/harness-core';
import type { KimiSession } from '@moonshot-ai/kimi-code-sdk';

import { GoalMarkerComponent, buildGoalMarker } from '../components/messages/goal-markers';
import {
  GoalCompletionMessageComponent,
  GoalSetMessageComponent,
} from '../components/messages/goal-panel';
import {
  OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE,
} from '../constant/kimi-tui';
import { sumTokenUsage, type AppState, type LivePaneState, type TranscriptEntry } from '../types';
import type { TUIState } from '../tui-state';
import { buildGoalCompletionMessage } from '../utils/goal-completion';
import { nextTranscriptId } from '../utils/transcript-id';
import type { ColorToken } from '../theme';
import type { InteractionController } from '../reverse-rpc/interaction-controller';
import type { StreamingUIController } from './streaming-ui';
import { SubagentEventHandler } from './subagent-event-handler';
import type { SurveyController } from './survey-controller';

export interface SessionEventHost {
  state: TUIState;
  session: KimiSession | undefined;
  aborted: boolean;
  sessionEventUnsubscribe: (() => void) | undefined;
  readonly streamingUI: StreamingUIController;
  readonly surveyController: SurveyController;
  readonly interactionController: InteractionController;

  requireSession(): KimiSession;
  /** The live main agent handle (rebound on undo / compaction remount). */
  mainAgent(): AgentHandle | undefined;
  /** The main agent was remounted by the engine — rebind subscriptions. */
  onMainAgentRemounted(): void;
  /** Compaction swapped the agent's branch — remount the main agent. */
  remountMainAgent(): Promise<void>;
  setAppState(patch: Partial<AppState>): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  showError(msg: string): void;
  showStatus(msg: string, color?: ColorToken): void;
  updateQueueDisplay(): void;
  updateTerminalTitle(): void;
  /** Turn boundary reached — release the next queued `!` command, if any. */
  drainBashQueue(): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  handleShellOutput(commandId: string, text: string): void;
  mergeCurrentTurnSteps(): void;
  configDefaultModel(): string | undefined;
}

export class SessionEventHandler {
  readonly subagentEventHandler: SubagentEventHandler;
  private lastGoalId: string | null = null;
  private readonly renderedSkillActivationIds = new Set<string>();

  constructor(private readonly host: SessionEventHost) {
    this.subagentEventHandler = new SubagentEventHandler(host);
  }

  startSubscription(): void {
    const { host } = this;
    const session = host.requireSession();
    this.stopSubscription();
    this.renderedSkillActivationIds.clear();
    const agent = host.mainAgent();
    if (agent === undefined) return;

    const off: Array<() => void> = [];
    const use = (subscription: { unsubscribe(): void } | (() => void)): void => {
      if (typeof subscription === 'function') off.push(subscription);
      else off.push(() => subscription.unsubscribe());
    };
    use(agent.on('turn.started', (event) => this.handleTurnStarted(event)));
    use(agent.on('step.started', (event) => this.handleStepStarted(event)));
    use(agent.on('llm.streaming.part', (event) => {
      this.clearStepRetry();
      host.streamingUI.onStreamPart(event.part);
    }));
    use(agent.on('llm.started', () => this.markRetryAttemptSent()));
    use(agent.on('llm.retrying', (event) => this.handleRetrying(event)));
    use(agent.on('llm.done', (event) => {
      this.clearStepRetry();
      host.streamingUI.onLlmDone(event.entry);
    }));
    use(agent.on('turn.spawn_tools', (event) => {
      this.clearStepRetry();
      host.surveyController.notifyToolCallStarted();
      host.streamingUI.onSpawnTools(event.toolCalls);
    }));
    use(agent.on('tool.update', (event) => {
      this.subagentEventHandler.onToolUpdate(event.toolCallId, event.update);
      host.streamingUI.onToolUpdate(event.toolCallId, event.update);
    }));
    use(agent.on('tool.detached', (event) => {
      this.subagentEventHandler.onToolDetached(event.toolCallId);
      host.streamingUI.onToolDetached(event.toolCallId, event.text);
    }));
    use(agent.on('tool.done', (event) => {
      this.subagentEventHandler.onToolDone(event.toolCallId, event.outcome);
      host.streamingUI.onToolDone(event.toolCallId, event.outcome);
    }));
    use(agent.on('turn.done', (event) => this.handleTurnDone(event)));
    use(agent.on('prompt.blocked', (event) => this.handlePromptBlocked(event)));

    const handle = session.handle;
    use(handle.on('session.meta_updated', (event) => {
      if (host.aborted) return;
      const meta = event['meta'] as SessionRecord | undefined;
      if (meta?.title !== undefined) {
        host.setAppState({ sessionTitle: meta.title });
        host.updateTerminalTitle();
      }
    }));
    use(handle.on('compaction.started', (event) => {
      if (host.aborted) return;
      host.streamingUI.finalizeLiveTextBuffers('waiting');
      host.setAppState({
        isCompacting: true,
        streamingPhase: 'waiting',
        streamingStartTime: Date.now(),
      });
      const instruction = event['instruction'];
      host.streamingUI.beginCompaction(typeof instruction === 'string' ? instruction : undefined);
    }));
    use(handle.on('compaction.completed', () => {
      if (host.aborted) return;
      // The compaction swapped the agent's branch and left it paused; the
      // host remounts it (the resulting `agent.opened` re-subscribes). The
      // summary card completes once the new branch is live, reading the
      // seeded summary entry back from the swapped-in history.
      void host.remountMainAgent().then(() => {
        if (host.aborted) return;
        host.streamingUI.endCompaction(undefined, undefined, this.readCompactionSummary());
        this.finishCompaction();
        host.surveyController.notifyCompactionFinished();
      });
    }));
    use(handle.on('compaction.cancelled', () => {
      if (host.aborted) return;
      host.streamingUI.cancelCompaction();
      this.finishCompaction();
    }));
    use(handle.on('agent.opened', (event) => {
      if (event['agentId'] !== MAIN_AGENT_ID) return;
      if (event['reopened'] !== true) return;
      host.onMainAgentRemounted();
    }));
    use(handle.on('agent.closed', (event) => {
      const agentId = event['agentId'];
      if (typeof agentId === 'string') this.subagentEventHandler.onAgentClosed(agentId);
    }));
    use(handle.on('goal.updated', (event) => {
      this.handleGoalUpdated(event);
    }));
    use(handle.on('skill.activated', (event) => {
      this.handleSkillActivated(event);
    }));
    use(handle.on('cron.fired', (event) => {
      const origin = event['origin'] as
        | { jobId?: string; cron?: string; recurring?: boolean; coalescedCount?: number; stale?: boolean }
        | undefined;
      const prompt = event['prompt'];
      host.streamingUI.flushNow();
      host.appendTranscriptEntry({
        id: nextTranscriptId(),
        kind: 'cron',
        turnId: host.streamingUI.getTurnContext().turnId,
        renderMode: 'plain',
        content: typeof prompt === 'string' ? prompt : '',
        cronData: {
          jobId: origin?.jobId,
          cron: origin?.cron,
          recurring: origin?.recurring,
          coalescedCount: origin?.coalescedCount,
          stale: origin?.stale,
        },
      });
    }));
    use(handle.on('shell.output', (event) => {
      const commandId = event['commandId'];
      const text = event['text'];
      if (typeof commandId === 'string' && typeof text === 'string') {
        host.handleShellOutput(commandId, text);
      }
    }));

    off.push(this.watchFacades(agent));
    use(watch(agent.snapshot, () => host.updateQueueDisplay()));
    host.interactionController.mountSession(session);

    this.off = off;
    host.sessionEventUnsubscribe = () => {
      this.stopSubscription();
    };
  }

  stopSubscription(): void {
    const { host } = this;
    for (const off of this.off ?? []) off();
    this.off = undefined;
    host.sessionEventUnsubscribe = undefined;
    this.subagentEventHandler.reset();
    host.interactionController.unmountSession();
  }

  private off: Array<() => void> | undefined;

  // ---------------------------------------------------------------------------
  // Machine events
  // ---------------------------------------------------------------------------

  private handleTurnStarted(event: Extract<AgentEmitted, { type: 'turn.started' }>): void {
    const { host } = this;
    host.streamingUI.onTurnStarted(event.turnId);
    this.clearStepRetry();
    host.surveyController.notifyTurnStarted(
      event.entry?.meta?.origin === undefined || event.entry.meta.origin.kind === 'user',
    );
    host.patchLivePane({ mode: 'waiting', pendingApproval: null, pendingQuestion: null });
    host.setAppState({ streamingPhase: 'waiting', streamingStartTime: Date.now() });
  }

  private handleStepStarted(event: Extract<AgentEmitted, { type: 'step.started' }>): void {
    const { host } = this;
    host.streamingUI.onStepStarted(event.step);
    host.patchLivePane({ mode: 'waiting', pendingApproval: null, pendingQuestion: null });
    host.setAppState({ streamingPhase: 'waiting', streamingStartTime: Date.now() });
  }

  private handleRetrying(event: LlmRetrying): void {
    if (event.reason !== 'backoff') return;
    const { host } = this;
    // The failure may arrive mid-stream, after thinking/assistant deltas have
    // parked the pane in `thinking`/`composing` — drive it back to waiting so
    // the retry label and detail actually render during the backoff.
    host.streamingUI.flushNow();
    host.patchLivePane({ mode: 'waiting' });
    const error = event.error;
    host.setAppState({
      streamingPhase: 'waiting',
      stepRetry: {
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorName: error.kind,
        errorMessage: error.message,
        phase: 'backoff',
      },
    });
  }

  private markRetryAttemptSent(): void {
    const retry = this.host.state.appState.stepRetry;
    if (retry === null || retry.phase === 'attempt') return;
    this.host.setAppState({ stepRetry: { ...retry, phase: 'attempt' } });
  }

  private clearStepRetry(): void {
    if (this.host.state.appState.stepRetry === null) return;
    this.host.setAppState({ stepRetry: null });
  }

  private handleTurnDone(event: Extract<AgentEmitted, { type: 'turn.done' }>): void {
    const { host } = this;
    host.streamingUI.flushNow();
    this.clearStepRetry();
    host.streamingUI.finalizeTurn();
    host.surveyController.notifyTurnEnded();
    if (event.outcome.type === 'failed') {
      this.showTurnFailure(event.outcome);
    } else if (event.outcome.type === 'aborted') {
      host.showStatus('Interrupted by user', 'error');
    }
    host.updateQueueDisplay();
    host.drainBashQueue();
  }

  private showTurnFailure(outcome: Extract<TurnOutcome, { type: 'failed' }>): void {
    const { host } = this;
    const failure = outcome.failure;
    if (failure.reason === 'max_steps') {
      host.showError(`reached per-turn step limit (max_steps): ${failure.message}`);
      return;
    }
    const error = failure.error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('login') || message.includes('oauth')) {
      host.showError(OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE);
      return;
    }
    host.showError(message);
  }

  private handlePromptBlocked(event: Extract<AgentEmitted, { type: 'prompt.blocked' }>): void {
    const { host } = this;
    if (host.state.appState.streamingPhase === 'idle') return;
    if (host.streamingUI.hasActiveTurn()) return;
    host.setAppState({ streamingPhase: 'idle' });
    host.showError(
      event.reason === 'gate'
        ? 'Turn stopped: prompt gate blocked the request.'
        : `Turn failed before it started: ${event.error instanceof Error ? event.error.message : String(event.error ?? 'unknown error')}`,
    );
  }

  private finishCompaction(): void {
    const { host } = this;
    if (host.streamingUI.hasActiveTurn()) {
      host.setAppState({ isCompacting: false });
      return;
    }
    host.setAppState({ isCompacting: false, streamingPhase: 'idle' });
  }

  // ---------------------------------------------------------------------------
  // Feature events (goal / skill)
  // ---------------------------------------------------------------------------

  private handleGoalUpdated(event: Record<string, unknown>): void {
    const { host } = this;
    const snapshot = event['snapshot'] as GoalSnapshot | null | undefined;
    const change = event['change'] as GoalChange | undefined;
    if (change?.kind === 'completion' && snapshot !== null && snapshot !== undefined) {
      this.mountGoalComponent(
        new GoalCompletionMessageComponent(buildGoalCompletionMessage(snapshot)),
      );
      this.lastGoalId = null;
      return;
    }
    if (change?.kind === 'lifecycle') {
      const marker = buildGoalMarker(change, host.state.toolOutputExpanded, change.actor);
      if (marker !== null) this.mountGoalComponent(marker);
      this.lastGoalId = snapshot?.goalId ?? null;
      return;
    }
    if (snapshot !== null && snapshot !== undefined && snapshot.goalId !== this.lastGoalId) {
      this.mountGoalComponent(new GoalSetMessageComponent());
    }
    this.lastGoalId = snapshot?.goalId ?? null;
  }

  private mountGoalComponent(component: GoalMarkerComponent | GoalCompletionMessageComponent | GoalSetMessageComponent): void {
    const { host } = this;
    host.state.transcriptContainer.addChild(component);
    host.mergeCurrentTurnSteps();
    host.state.ui.requestRender();
  }

  private handleSkillActivated(event: Record<string, unknown>): void {
    const { host } = this;
    if (event['agentId'] !== MAIN_AGENT_ID) return;
    const activationId = event['activationId'];
    const skillName = event['skillName'];
    if (typeof activationId !== 'string' || typeof skillName !== 'string') return;
    if (this.renderedSkillActivationIds.has(activationId)) return;
    this.renderedSkillActivationIds.add(activationId);
    const trigger = event['trigger'];
    const skillArgs = event['skillArgs'];
    const isUserSlash = trigger === 'user-slash';
    host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'skill_activation',
      turnId: isUserSlash ? undefined : host.streamingUI.getTurnContext().turnId,
      renderMode: 'plain',
      content: `Activated skill: ${skillName}`,
      skillActivationId: activationId,
      skillName,
      skillArgs: typeof skillArgs === 'string' ? skillArgs : undefined,
      skillTrigger:
        trigger === 'user-slash' || trigger === 'model-tool' || trigger === 'nested-skill'
          ? trigger
          : undefined,
    });
  }

  /**
   * The completed compaction's summary is seeded into the swapped-in branch as
   * a user entry flagged `source: 'compaction'`, `key: 'summary'`; its first
   * line is the fixed model-facing prefix, the rest is the summary body.
   */
  private readCompactionSummary(): string | undefined {
    const { host } = this;
    const session = host.session;
    if (session === undefined) return undefined;
    const history = session.handle.stores.get(MAIN_AGENT_ID)?.getState().history;
    if (history === undefined) return undefined;
    const entry = history.findLast(
      (item) => item.meta?.source === 'compaction' && item.meta?.key === 'summary',
    );
    if (entry === undefined || entry.message.role !== 'user') return undefined;
    const text = entry.message.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('');
    const newline = text.indexOf('\n');
    const summary = newline < 0 ? '' : text.slice(newline + 1).trim();
    return summary.length > 0 ? summary : undefined;
  }

  // ---------------------------------------------------------------------------
  // Facade watchers (footer / status)
  // ---------------------------------------------------------------------------

  private watchFacades(agent: AgentHandle): () => void {
    const { host } = this;
    const off: Array<() => void> = [];
    const use = (subscription: { unsubscribe(): void } | (() => void)): void => {
      if (typeof subscription === 'function') off.push(subscription);
      else off.push(() => subscription.unsubscribe());
    };

    const model = agent.resolve(AgentModelRef);
    if (model === undefined) {
      const alias = host.configDefaultModel();
      if (alias !== undefined) {
        host.setAppState({
          model: alias,
          maxContextTokens:
            host.state.appState.availableModels[alias]?.maxContextSize ??
            host.state.appState.maxContextTokens,
        });
      }
    } else {
      off.push(watch(model.current, (current) => {
        const alias = current.alias ?? host.configDefaultModel() ?? '';
        host.setAppState({
          model: alias,
          thinkingEffort: current.thinking ?? host.state.appState.thinkingEffort,
          maxContextTokens:
            host.state.appState.availableModels[alias]?.maxContextSize ??
            agent.model?.spec.maxContextSize ??
            host.state.appState.maxContextTokens,
        });
      }, { immediate: true }));
    }

    const permission = agent.resolve(PermissionRef);
    if (permission !== undefined) {
      off.push(watch(permission.state, (state) => {
        host.setAppState({ permissionMode: state.mode });
      }, { immediate: true }));
    }

    const plan = agent.resolve(PlanRef);
    if (plan !== undefined) {
      off.push(watch(plan.state, (state) => {
        host.setAppState({ planMode: state.active });
      }, { immediate: true }));
    }

    const tokenCounting = agent.resolve(TokenCountingRef);
    if (tokenCounting !== undefined) {
      off.push(watch(tokenCounting.status, (status) => {
        const max = host.state.appState.maxContextTokens;
        host.setAppState({
          contextTokens: status,
          contextUsage: max > 0 ? status / max : 0,
        });
      }, { immediate: true }));
    }

    const usage = agent.resolve(UsageRef);
    if (usage !== undefined) {
      off.push(watch(usage.summary, (summary) => {
        host.setAppState({ cumulativeTokens: sumTokenUsage(summary.total) });
      }, { immediate: true }));
    }

    const tasks = agent.resolve(TaskRef);
    if (tasks !== undefined) {
      off.push(watch(tasks.records, (records) => {
        let bashTasks = 0;
        let agentTasks = 0;
        for (const record of records.values()) {
          if (record.status !== 'running') continue;
          if (record.toolName === 'Agent' || record.toolName === 'AgentSwarm') agentTasks += 1;
          else bashTasks += 1;
        }
        host.state.footer.setBackgroundCounts({ bashTasks, agentTasks });
        host.state.ui.requestRender();
      }, { immediate: true }));
    }

    const todos = agent.resolve(TodoRef);
    if (todos !== undefined) {
      off.push(watch(todos.items, (items) => {
        host.streamingUI.setTodoList(
          items.map((item: { title: string; status: 'pending' | 'in_progress' | 'done' }) => ({
            title: item.title,
            status: item.status,
          })),
        );
      }, { immediate: true }));
    }

    const goal = agent.resolve(GoalRef);
    if (goal !== undefined) {
      this.lastGoalId = goal.getGoal().goal?.goalId ?? null;
      off.push(watch(goal.state, () => {
        host.setAppState({ goal: goal.getGoal().goal });
      }, { immediate: true }));
    }

    return () => {
      for (const stop of off) stop();
    };
  }
}
