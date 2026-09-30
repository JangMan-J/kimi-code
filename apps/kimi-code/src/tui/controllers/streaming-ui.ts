import {
  createMessageAccumulator,
  extractText,
  type AssistantEntry,
  type MessageAccumulator,
  type StreamedMessagePart,
  type ToolCall,
  type ToolUpdate,
} from '@moonshot-ai/agent-core';
import type { ToolOutput } from '@moonshot-ai/agent-core/agent-machine/tool';
import { SUBAGENT_UPDATE_KEY } from '@moonshot-ai/harness-core';
import type { KimiSession } from '@moonshot-ai/kimi-code-sdk';

import { AgentGroupComponent } from '../components/messages/agent-group';
import { AssistantMessageComponent } from '../components/messages/assistant-message';
import { currentWorkingTip } from '../components/chrome/working-tips';
import { CompactionComponent } from '../components/dialogs/compaction';
import { ReadGroupComponent } from '../components/messages/read-group';
import { ThinkingComponent } from '../components/messages/thinking';
import { ToolCallComponent } from '../components/messages/tool-call';
import { STREAMING_UI_FLUSH_MS } from '../constant/streaming';
import { hasDispose } from '../utils/component-capabilities';
import { notifyTerminalOnce } from '../utils/terminal-notification';
import { nextTranscriptId } from '../utils/transcript-id';
import type { TodoItem } from '../components/chrome/todo-panel';
import type {
  AppState,
  LivePaneState,
  ToolCallBlockData,
  ToolResultBlockData,
  TranscriptEntry,
} from '../types';
import type { TUIState } from '../tui-state';

export interface StreamingUIHost {
  state: TUIState;
  session: KimiSession | undefined;
  setAppState(patch: Partial<AppState>): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  updateActivityPane(): void;
  updateQueueDisplay(): void;
  pushTranscriptEntry(entry: TranscriptEntry): void;
  mergeCurrentTurnSteps(): void;
  mergeCompletedTurnAssistants(): void;
}

export function parseToolCallArgs(call: ToolCall): Record<string, unknown> {
  const raw = call.arguments;
  if (raw === null || raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function toolOutcomeToResult(toolCallId: string, outcome: ToolOutput): ToolResultBlockData {
  if (outcome.type === 'succeeded') {
    return {
      tool_call_id: toolCallId,
      output: extractText(outcome.result),
      is_error: outcome.result.isError === true ? true : undefined,
    };
  }
  if (outcome.type === 'failed') {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    return { tool_call_id: toolCallId, output: message, is_error: true };
  }
  const reason = outcome.reason instanceof Error ? outcome.reason.message : outcome.reason;
  return {
    tool_call_id: toolCallId,
    output: typeof reason === 'string' && reason.length > 0 ? reason : 'Tool call aborted.',
    is_error: true,
    synthetic: true,
  };
}

export class StreamingUIController {
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFlushAt: number | undefined;
  private pendingAssistantFlush = false;
  private pendingThinkingFlush = false;

  // ---------------------------------------------------------------------------
  // Streaming runtime state (private — accessed via semantic methods below)
  // ---------------------------------------------------------------------------

  private _currentTurnId: string | undefined = undefined;
  private _currentStep = 0;
  private _accumulator: MessageAccumulator | undefined = undefined;
  private _assistantDraft = '';
  private _thinkingDraft = '';
  private _streamingBlock: { component: AssistantMessageComponent; entry: TranscriptEntry } | null = null;
  private _activeThinkingComponent: ThinkingComponent | undefined = undefined;
  private _activeCompactionBlock: CompactionComponent | undefined = undefined;
  private _activeToolCalls = new Map<string, ToolCallBlockData>();
  private _pendingToolComponents = new Map<string, ToolCallComponent>();
  private _pendingAgentGroup: {
    readonly turnId: string | undefined;
    readonly step: number;
    solo?: ToolCallComponent;
    group?: AgentGroupComponent;
  } | null = null;
  private _pendingReadGroup: {
    readonly turnId: string | undefined;
    readonly step: number;
    solo?: ToolCallComponent;
    group?: ReadGroupComponent;
  } | null = null;

  constructor(private readonly host: StreamingUIHost) {}

  // ---------------------------------------------------------------------------
  // Turn context — read/write accessors
  // ---------------------------------------------------------------------------

  getTurnContext(): { turnId: string | undefined; step: number } {
    return { turnId: this._currentTurnId, step: this._currentStep };
  }

  setTurnId(turnId: string | undefined): void {
    this._currentTurnId = turnId;
  }

  setStep(step: number): void {
    this._currentStep = step;
  }

  hasActiveTurn(): boolean {
    return this._currentTurnId !== undefined;
  }

  // ---------------------------------------------------------------------------
  // v3 event ingestion
  // ---------------------------------------------------------------------------

  onTurnStarted(turnId: number): void {
    this._currentTurnId = String(turnId);
    this._currentStep = 0;
    this._accumulator = undefined;
    this.resetToolUi();
    this.resetLiveText();
  }

  onStepStarted(step: number): void {
    this.flushNow();
    this._currentStep = step;
    this._accumulator = undefined;
    this.resetToolUi();
    this.finalizeLiveTextBuffers('waiting');
  }

  onStreamPart(part: StreamedMessagePart): void {
    if (part.type === 'text') {
      this.accumulator().push(part);
      if (this.hasThinkingDraft()) {
        this.flushThinkingToTranscript('idle');
      }
      this.appendAssistantDelta(part.text);
      this.host.patchLivePane({ mode: 'idle', pendingApproval: null, pendingQuestion: null });
      if (this.host.state.appState.streamingPhase !== 'composing') {
        this.host.setAppState({ streamingPhase: 'composing', streamingStartTime: Date.now() });
      }
      this.scheduleFlush();
      return;
    }
    if (part.type === 'think') {
      this.accumulator().push(part);
      if (part.think.trim().length === 0 && !this.hasThinkingDraft()) return;
      this.appendThinkingDelta(part.think);
      this.host.patchLivePane({ mode: 'idle' });
      if (this.host.state.appState.streamingPhase !== 'thinking') {
        this.host.setAppState({ streamingPhase: 'thinking', streamingStartTime: Date.now() });
      }
      this.scheduleFlush();
      return;
    }
    // Tool call deltas are ignored: `turn.spawn_tools` carries the complete
    // calls, so partial-JSON previews are unnecessary.
  }

  onLlmDone(entry: AssistantEntry): void {
    this.flushNow();
    if (this.hasThinkingDraft()) {
      this.flushThinkingToTranscript('idle');
    }
    const text = extractText(entry.message);
    if (this._streamingBlock !== null) {
      if (text.length > 0) {
        this._streamingBlock.entry.content = text;
      }
      this.onStreamingTextEnd();
    }
    this._assistantDraft = '';
    this._accumulator = undefined;
    this.host.updateActivityPane();
    this.host.state.ui.requestRender();
  }

  onSpawnTools(toolCalls: readonly ToolCall[]): void {
    this.flushNow();
    const { turnId, step } = this.getTurnContext();
    for (const call of toolCalls) {
      const toolCall: ToolCallBlockData = {
        id: call.id,
        name: call.name,
        args: parseToolCallArgs(call),
        step,
        turnId,
      };
      this.registerToolCall(toolCall);
    }
    this.host.patchLivePane({ mode: 'tool', pendingApproval: null, pendingQuestion: null });
  }

  onToolUpdate(toolCallId: string, update: ToolUpdate): void {
    if (update.key === SUBAGENT_UPDATE_KEY) return;
    if (update.text.length === 0) return;
    const tc = this.getToolComponent(toolCallId);
    if (tc === undefined) return;
    tc.appendProgress(update.text, { replace: false });
  }

  onToolDone(toolCallId: string, outcome: ToolOutput): ToolCallBlockData | undefined {
    this.flushNow();
    const result = toolOutcomeToResult(toolCallId, outcome);
    return this.completeToolResult(toolCallId, result);
  }

  onToolDetached(toolCallId: string, text: string): void {
    this.flushNow();
    // A detached (backgrounded) call completes its card with the detach ack;
    // the eventual `tool.done` then finds nothing tracked and is skipped.
    this.completeToolResult(toolCallId, {
      tool_call_id: toolCallId,
      output: text,
      synthetic: true,
    });
  }

  // ---------------------------------------------------------------------------
  // Text streaming — semantic write accessors
  // ---------------------------------------------------------------------------

  appendThinkingDelta(delta: string): void {
    this._thinkingDraft += delta;
    this.pendingThinkingFlush = true;
  }

  appendAssistantDelta(delta: string): void {
    if (this._streamingBlock === null) {
      this.onStreamingTextStart();
    }
    this._assistantDraft += delta;
    this.pendingAssistantFlush = true;
  }

  hasThinkingDraft(): boolean {
    return this._thinkingDraft.length > 0;
  }

  hasActiveThinkingComponent(): boolean {
    return this._activeThinkingComponent !== undefined;
  }

  hasStreamingBlock(): boolean {
    return this._streamingBlock !== null;
  }

  getStreamingBlockComponent(): AssistantMessageComponent | undefined {
    return this._streamingBlock?.component;
  }

  // ---------------------------------------------------------------------------
  // Tool call state — semantic accessors
  // ---------------------------------------------------------------------------

  getActiveToolCall(id: string): ToolCallBlockData | undefined {
    return this._activeToolCalls.get(id);
  }

  getToolComponent(id: string): ToolCallComponent | undefined {
    return this._pendingToolComponents.get(id);
  }

  /** Registers a tool call that arrived via `turn.spawn_tools` (complete
   *  arguments). Updates or creates the component; returns whether the call
   *  was new (no previous entry). */
  registerToolCall(toolCall: ToolCallBlockData): boolean {
    const existing = this._activeToolCalls.get(toolCall.id);
    this._activeToolCalls.set(toolCall.id, toolCall);
    const existingComponent = this._pendingToolComponents.get(toolCall.id);
    if (existingComponent !== undefined) {
      existingComponent.updateToolCall(toolCall);
    } else if (existing === undefined) {
      this.finalizeLiveTextBuffers('tool');
      if (toolCall.name !== 'Agent' && toolCall.name !== 'AgentSwarm') {
        this.onToolCallStart(toolCall);
      }
    }
    return existing === undefined;
  }

  /** Completes a tool call: delivers the result and removes tracking state.
   *  Returns the matched ToolCallBlockData, or undefined if no call was tracked. */
  completeToolResult(toolCallId: string, result: ToolResultBlockData): ToolCallBlockData | undefined {
    const matchedCall = this._activeToolCalls.get(toolCallId);
    if (matchedCall !== undefined) {
      this.onToolCallEnd(toolCallId, result);
    }
    this._activeToolCalls.delete(toolCallId);
    return matchedCall;
  }

  // ---------------------------------------------------------------------------
  // Dispose helpers (moved from KimiTUI)
  // ---------------------------------------------------------------------------

  disposeActiveThinkingComponent(): void {
    if (this._activeThinkingComponent !== undefined) {
      this._activeThinkingComponent.dispose();
      this._activeThinkingComponent = undefined;
    }
  }

  disposeAndClearPendingToolComponents(): void {
    for (const component of this._pendingToolComponents.values()) {
      if (hasDispose(component)) component.dispose();
    }
    this._pendingToolComponents.clear();
  }

  disposeActiveCompactionBlock(): void {
    if (this._activeCompactionBlock !== undefined) {
      this._activeCompactionBlock.dispose();
      this._activeCompactionBlock = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Flush control
  // ---------------------------------------------------------------------------

  hasPending(): boolean {
    return this.pendingAssistantFlush || this.pendingThinkingFlush;
  }

  clearFlushTimer(): void {
    if (this.flushTimer === undefined) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private clearFlushTimerIfIdle(): void {
    if (this.hasPending()) return;
    this.clearFlushTimer();
  }

  discardPending(): void {
    this.clearFlushTimer();
    this.pendingAssistantFlush = false;
    this.pendingThinkingFlush = false;
  }

  scheduleFlush(): void {
    if (!this.hasPending()) return;
    if (this.flushTimer !== undefined) return;
    const delay =
      this.lastFlushAt === undefined
        ? 0
        : Math.max(0, STREAMING_UI_FLUSH_MS - (Date.now() - this.lastFlushAt));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, delay);
  }

  flushNow(): void {
    this.clearFlushTimer();
    this.flush();
  }

  private flush(): void {
    if (!this.hasPending()) return;
    this.lastFlushAt = Date.now();
    const shouldFlushThinking = this.pendingThinkingFlush;
    const shouldFlushAssistant = this.pendingAssistantFlush;
    this.pendingThinkingFlush = false;
    this.pendingAssistantFlush = false;

    if (shouldFlushThinking && this._thinkingDraft.length > 0) {
      this.onThinkingUpdate(this._thinkingDraft);
    }
    if (shouldFlushAssistant) {
      this.onStreamingTextUpdate(this._assistantDraft);
    }
  }

  markAssistantDirty(): void {
    this.pendingAssistantFlush = true;
  }

  markThinkingDirty(): void {
    this.pendingThinkingFlush = true;
  }

  // ---------------------------------------------------------------------------
  // Text streaming
  // ---------------------------------------------------------------------------

  flushThinkingToTranscript(nextMode: LivePaneState['mode'] = 'idle'): void {
    this.flushNow();
    this._thinkingDraft = '';
    this.onThinkingEnd();
    this.host.patchLivePane({ mode: nextMode });
  }

  finalizeAssistantStream(): void {
    this.flushNow();
    if (this._streamingBlock !== null) {
      this.onStreamingTextEnd();
    }
    this._assistantDraft = '';
    this.host.updateActivityPane();
    this.host.state.ui.requestRender();
  }

  resetLiveText(): void {
    this.pendingAssistantFlush = false;
    this.pendingThinkingFlush = false;
    this.clearFlushTimerIfIdle();
    this._assistantDraft = '';
    this._streamingBlock = null;
    this._thinkingDraft = '';
    this.disposeActiveThinkingComponent();
  }

  resetToolUi(): void {
    this.disposeAndClearPendingToolComponents();
    this._pendingAgentGroup = null;
    this._pendingReadGroup = null;
    this.resetToolCallState();
  }

  resetToolCallState(): void {
    this._activeToolCalls.clear();
  }

  finalizeLiveTextBuffers(nextMode: LivePaneState['mode'] = 'idle'): void {
    this.flushThinkingToTranscript(nextMode);
    this.finalizeAssistantStream();
  }

  finalizeTurn(): void {
    const { state } = this.host;
    if (state.appState.streamingPhase === 'idle') return;
    const completedTurnKey =
      this._currentTurnId ?? `local:${String(state.appState.streamingStartTime)}`;
    this.finalizeLiveTextBuffers('idle');
    // The finished turn keeps only its conclusion-bearing tail; intermediate
    // chatter folds into the step summary.
    this.host.mergeCompletedTurnAssistants();
    this.resetToolCallState();
    this._currentTurnId = undefined;

    this.host.setAppState({ streamingPhase: 'idle' });
    this.host.resetLivePane();
    notifyTerminalOnce(state, `turn-complete:${completedTurnKey}`, {
      title: 'Kimi Code task complete',
      body: state.appState.sessionTitle ?? undefined,
    });
  }

  // ---------------------------------------------------------------------------
  // Live Render Hooks
  // ---------------------------------------------------------------------------

  onStreamingTextStart(): void {
    const { state } = this.host;
    this._pendingAgentGroup = null;
    this._pendingReadGroup = null;
    const entry = {
      id: nextTranscriptId(),
      kind: 'assistant' as const,
      turnId: this._currentTurnId,
      renderMode: 'markdown' as const,
      content: '',
      modelText: true,
    };
    const component = new AssistantMessageComponent();
    this._streamingBlock = { component, entry };
    this.host.pushTranscriptEntry(entry);
    state.transcriptContainer.addChild(component);
    state.ui.requestRender();
  }

  onStreamingTextUpdate(fullText: string): void {
    const block = this._streamingBlock;
    if (block !== null) {
      block.entry.content = fullText;
      block.component.updateContent(fullText, { transient: true });
      this.host.state.ui.requestRender();
    }
  }

  onStreamingTextEnd(): void {
    const block = this._streamingBlock;
    if (block !== null) {
      block.component.updateContent(block.entry.content, { transient: false });
    }
    this._streamingBlock = null;
  }

  onThinkingUpdate(fullText: string): void {
    // Skip thinking that carries nothing visible — empty (e.g. encrypted
    // reasoning) or whitespace-only (a model occasionally streams a single
    // space as thinking).
    if (fullText.trim().length === 0 && this._activeThinkingComponent === undefined) return;
    const { state } = this.host;
    if (this._activeThinkingComponent === undefined) {
      this._pendingAgentGroup = null;
      this._pendingReadGroup = null;
      this._activeThinkingComponent = new ThinkingComponent(
        fullText,
        true,
        'live',
        state.ui,
      );
      if (state.toolOutputExpanded) this._activeThinkingComponent.setExpanded(true);
      state.transcriptContainer.addChild(this._activeThinkingComponent);
    } else {
      this._activeThinkingComponent.setText(fullText);
    }
    state.ui.requestRender();
  }

  onThinkingEnd(): void {
    if (this._activeThinkingComponent === undefined) return;
    this._activeThinkingComponent.finalize();
    this._activeThinkingComponent = undefined;
    this.host.state.ui.requestRender();
    this.host.mergeCurrentTurnSteps();
  }

  onToolCallStart(toolCall: ToolCallBlockData): void {
    if (toolCall.name === 'AskUserQuestion') return;

    const { state } = this.host;
    const tc = new ToolCallComponent(
      toolCall,
      undefined,
      state.ui,
      state.appState.workDir,
    );
    if (state.toolOutputExpanded) tc.setExpanded(true);
    this._pendingToolComponents.set(toolCall.id, tc);

    if (toolCall.name !== 'Agent') this._pendingAgentGroup = null;
    if (toolCall.name !== 'Read') this._pendingReadGroup = null;

    let handled = this.tryAttachAgentToolCall(toolCall, tc);
    if (!handled) handled = this.tryAttachReadToolCall(toolCall, tc);
    if (!handled) {
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
    }
  }

  onToolCallEnd(toolCallId: string, result: ToolResultBlockData): void {
    const { state } = this.host;
    const matchedCall = this._activeToolCalls.get(toolCallId);
    const tc = this._pendingToolComponents.get(toolCallId);
    if (tc) {
      tc.setResult(result);
      this._pendingToolComponents.delete(toolCallId);
      state.ui.requestRender();
      this.host.mergeCurrentTurnSteps();
      return;
    }

    if (matchedCall !== undefined && matchedCall.name === 'AskUserQuestion') {
      const completed = new ToolCallComponent(
        matchedCall,
        result,
        state.ui,
        state.appState.workDir,
      );
      if (state.toolOutputExpanded) completed.setExpanded(true);
      state.transcriptContainer.addChild(completed);
      state.ui.requestRender();
    } else if (matchedCall !== undefined) {
      // A call whose card never mounted (an Agent call that finished without a
      // subagent update) still gets its completed card at result time.
      this.onToolCallStart(matchedCall);
      const mounted = this._pendingToolComponents.get(toolCallId);
      if (mounted !== undefined) {
        mounted.setResult(result);
        this._pendingToolComponents.delete(toolCallId);
        state.ui.requestRender();
      }
    }
    this.host.mergeCurrentTurnSteps();
  }

  setTodoList(todos: readonly TodoItem[]): void {
    const { state } = this.host;
    state.todoPanel.setTodos(todos);
    state.todoPanelContainer.clear();
    if (!state.todoPanel.isEmpty()) {
      state.todoPanelContainer.addChild(state.todoPanel);
    }
    state.ui.requestRender();
  }

  beginCompaction(instruction?: string): void {
    const { state } = this.host;
    if (this._activeCompactionBlock !== undefined) {
      this._activeCompactionBlock.markDone();
      this._activeCompactionBlock = undefined;
    }
    const block = new CompactionComponent(state.ui, instruction, currentWorkingTip()?.text);
    this._activeCompactionBlock = block;
    state.transcriptContainer.addChild(block);
    if (state.toolOutputExpanded) {
      block.setExpanded(true);
    }
    state.ui.requestRender();
  }

  endCompaction(tokensBefore?: number, tokensAfter?: number, summary?: string): void {
    const block = this._activeCompactionBlock;
    if (block === undefined) return;
    block.markDone(tokensBefore, tokensAfter, summary);
    this._activeCompactionBlock = undefined;
    this.host.state.ui.requestRender();
  }

  cancelCompaction(): void {
    const block = this._activeCompactionBlock;
    if (block === undefined) return;
    block.markCanceled();
    this._activeCompactionBlock = undefined;
    this.host.state.ui.requestRender();
  }

  // ---------------------------------------------------------------------------
  // Tool call grouping
  // ---------------------------------------------------------------------------

  private accumulator(): MessageAccumulator {
    this._accumulator ??= createMessageAccumulator();
    return this._accumulator;
  }

  private tryAttachAgentToolCall(toolCall: ToolCallBlockData, tc: ToolCallComponent): boolean {
    const { state } = this.host;
    if (toolCall.name !== 'Agent') {
      this._pendingAgentGroup = null;
      return false;
    }

    const step = toolCall.step ?? this._currentStep;
    const turnId = toolCall.turnId ?? this._currentTurnId;
    const pending = this._pendingAgentGroup;

    if (pending !== null && (pending.step !== step || pending.turnId !== turnId)) {
      this._pendingAgentGroup = null;
    }

    const cur = this._pendingAgentGroup;
    if (cur === null) {
      this._pendingAgentGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }

    if (cur.group !== undefined) {
      cur.group.attach(toolCall.id, tc);
      return true;
    }

    const solo = cur.solo;
    if (solo === undefined) {
      this._pendingAgentGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }
    const group = this.upgradeSoloAgentToGroup(solo);
    group.attach(toolCall.id, tc);
    this._pendingAgentGroup = { step, turnId, group };
    state.ui.requestRender();
    return true;
  }

  private upgradeSoloAgentToGroup(solo: ToolCallComponent): AgentGroupComponent {
    const { state } = this.host;
    const group = new AgentGroupComponent(state.ui);
    const children = state.transcriptContainer.children;
    const idx = children.indexOf(solo);
    if (idx >= 0) {
      // In-place replacement is picked up by the container's ref-checked
      // render cache; a tree-wide invalidate is unnecessary (and costly).
      children[idx] = group;
    } else {
      state.transcriptContainer.addChild(group);
    }
    group.attach(solo.toolCallView.id, solo);
    return group;
  }

  private tryAttachReadToolCall(toolCall: ToolCallBlockData, tc: ToolCallComponent): boolean {
    const { state } = this.host;
    if (toolCall.name !== 'Read') {
      this._pendingReadGroup = null;
      return false;
    }

    const step = toolCall.step ?? this._currentStep;
    const turnId = toolCall.turnId ?? this._currentTurnId;
    const pending = this._pendingReadGroup;

    if (pending !== null && (pending.step !== step || pending.turnId !== turnId)) {
      this._pendingReadGroup = null;
    }

    const cur = this._pendingReadGroup;
    if (cur === null) {
      this._pendingReadGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }

    if (cur.group !== undefined) {
      cur.group.attach(toolCall.id, tc);
      return true;
    }

    const solo = cur.solo;
    if (solo === undefined) {
      this._pendingReadGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }
    const group = this.upgradeSoloReadToGroup(solo);
    group.attach(toolCall.id, tc);
    this._pendingReadGroup = { step, turnId, group };
    state.ui.requestRender();
    return true;
  }

  private upgradeSoloReadToGroup(solo: ToolCallComponent): ReadGroupComponent {
    const { state } = this.host;
    const group = new ReadGroupComponent(state.ui);
    if (state.toolOutputExpanded) group.setExpanded(true);
    const children = state.transcriptContainer.children;
    const idx = children.indexOf(solo);
    if (idx >= 0) {
      // In-place replacement is picked up by the container's ref-checked
      // render cache; a tree-wide invalidate is unnecessary (and costly).
      children[idx] = group;
    } else {
      state.transcriptContainer.addChild(group);
    }
    group.attach(solo.toolCallView.id, solo);
    return group;
  }
}
