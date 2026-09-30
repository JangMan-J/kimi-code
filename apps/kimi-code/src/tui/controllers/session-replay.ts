import {
  MAIN_AGENT_ID,
  extractText,
  type AssistantEntry,
  type ToolEntry,
  type UserEntry,
} from '@moonshot-ai/agent-core';
import type { KimiSession } from '@moonshot-ai/kimi-code-sdk';

import { ReplayTurnBoundaryComponent } from '../components/messages/user-message';
import type { AppState, ToolCallBlockData, ToolResultBlockData, TranscriptEntry } from '../types';
import type { TUIState } from '../tui-state';
import { markTranscriptComponent } from '../utils/transcript-component-metadata';
import {
  classifyReplayUserEntry,
  limitReplayTurns,
  replayTurnLog,
  type ReplaySkillActivation,
  type ReplayTurn,
} from '../utils/message-replay';
import { nextTranscriptId } from '../utils/transcript-id';
import type { StreamingUIController } from './streaming-ui';

export interface SessionReplayHost {
  state: TUIState;
  readonly streamingUI: StreamingUIController;
  setAppState(patch: Partial<AppState>): void;
  showError(msg: string): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  mergeAllTurnSteps(): void;
}

export class SessionReplayRenderer {
  constructor(private readonly host: SessionReplayHost) {}

  hydrate(session: KimiSession): boolean {
    this.host.setAppState({ isReplaying: true });
    this.replayedCallIds.clear();
    try {
      const store = session.handle.stores.get(MAIN_AGENT_ID);
      if (store === undefined) {
        this.host.showError('Session history is unavailable for this session.');
        return false;
      }
      const log = store.attach(replayTurnLog());
      let turns: readonly ReplayTurn[];
      try {
        turns = limitReplayTurns(log.getState().turns);
      } finally {
        log.dispose();
      }
      for (const turn of turns) {
        this.renderTurn(turn);
      }
      this.finalizeUnfinishedToolCalls();
      this.host.streamingUI.setTurnId(undefined);
      this.host.streamingUI.setStep(0);
      this.host.mergeAllTurnSteps();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.host.showError(`Failed to replay session history: ${message}`);
      return false;
    } finally {
      this.host.setAppState({ isReplaying: false });
    }
  }

  private finalizeUnfinishedToolCalls(): void {
    const { streamingUI } = this.host;
    for (const toolCallId of this.replayedCallIds) {
      streamingUI.completeToolResult(toolCallId, {
        tool_call_id: toolCallId,
        output: 'aborted',
        synthetic: true,
      });
    }
    this.replayedCallIds.clear();
  }

  private readonly replayedCallIds = new Set<string>();

  private renderTurn(turn: ReplayTurn): void {
    const turnId = turn.turnId === undefined ? undefined : String(turn.turnId);
    this.host.streamingUI.setTurnId(turnId);
    let step = 0;
    let boundaryMounted = false;
    const ensureBoundary = (): void => {
      if (boundaryMounted) return;
      boundaryMounted = true;
      const boundary = new ReplayTurnBoundaryComponent();
      markTranscriptComponent(boundary, {
        id: nextTranscriptId(),
        kind: 'user',
        turnId: undefined,
        renderMode: 'plain',
        content: '',
      });
      this.host.state.transcriptContainer.addChild(boundary);
    };

    for (const entry of turn.entries) {
      switch (entry.message.role) {
        case 'user': {
          const rendered = this.renderUserEntry(entry as UserEntry);
          boundaryMounted = boundaryMounted || rendered;
          break;
        }
        case 'assistant': {
          step = this.renderAssistantEntry(entry as AssistantEntry, step);
          break;
        }
        case 'tool': {
          this.renderToolEntry(entry as ToolEntry);
          break;
        }
        default:
          break;
      }
    }
    ensureBoundary();
    this.host.streamingUI.flushNow();
  }

  private renderUserEntry(entry: UserEntry): boolean {
    const action = classifyReplayUserEntry(entry);
    const { streamingUI } = this.host;
    switch (action.kind) {
      case 'skip':
        return false;
      case 'boundary':
        return false;
      case 'cron':
        streamingUI.flushNow();
        this.host.appendTranscriptEntry({
          id: nextTranscriptId(),
          kind: 'cron',
          turnId: undefined,
          renderMode: 'plain',
          content: action.prompt,
          cronData: action.data,
        });
        return true;
      case 'compaction-summary':
        streamingUI.flushNow();
        this.host.appendTranscriptEntry({
          id: nextTranscriptId(),
          kind: 'status',
          turnId: undefined,
          renderMode: 'plain',
          content: 'Compaction complete',
          compactionData: { summary: action.summary },
        });
        return false;
      case 'compaction-elision':
        streamingUI.flushNow();
        this.host.appendTranscriptEntry({
          id: nextTranscriptId(),
          kind: 'status',
          turnId: undefined,
          renderMode: 'plain',
          content: action.text,
        });
        return false;
      case 'prompt': {
        streamingUI.flushNow();
        for (const skill of action.skills) {
          this.renderSkillActivation(skill);
        }
        if (action.text.trim().length > 0) {
          this.host.appendTranscriptEntry({
            id: nextTranscriptId(),
            kind: 'user',
            turnId: undefined,
            renderMode: 'plain',
            content: action.text,
          });
        }
        return true;
      }
    }
  }

  private renderSkillActivation(skill: ReplaySkillActivation): void {
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'skill_activation',
      turnId: undefined,
      renderMode: 'plain',
      content: `Activated skill: ${skill.skillName}`,
      skillActivationId: skill.activationId,
      skillName: skill.skillName,
      skillArgs: skill.skillArgs,
      skillTrigger: skill.trigger,
    });
  }

  private renderAssistantEntry(entry: AssistantEntry, step: number): number {
    const { streamingUI } = this.host;
    const thinking = entry.message.content
      .flatMap((part) =>
        part.type === 'think' && part.hidden !== true && part.think.trim().length > 0
          ? [part.think]
          : [],
      )
      .join('');
    if (thinking.length > 0) {
      streamingUI.onThinkingUpdate(thinking);
      streamingUI.onThinkingEnd();
    }
    const text = extractText(entry.message);
    if (text.trim().length > 0) {
      streamingUI.onStreamingTextStart();
      streamingUI.onStreamingTextUpdate(text);
      streamingUI.onStreamingTextEnd();
    }
    const toolCalls = entry.message.toolCalls;
    if (toolCalls.length === 0) return step;
    const currentStep = step;
    streamingUI.setStep(currentStep);
    for (const call of toolCalls) {
      const toolCall: ToolCallBlockData = {
        id: call.id,
        name: call.name,
        args: parseReplayToolArgs(call.arguments),
        step: currentStep,
        turnId: streamingUI.getTurnContext().turnId,
      };
      streamingUI.registerToolCall(toolCall);
      this.replayedCallIds.add(call.id);
      if (call.name === 'Agent' || call.name === 'AgentSwarm') {
        streamingUI.onToolCallStart(toolCall);
      }
    }
    return step + 1;
  }

  private renderToolEntry(entry: ToolEntry): void {
    const { streamingUI } = this.host;
    const toolCallId = entry.message.toolCallId;
    if (!this.replayedCallIds.has(toolCallId)) return;
    this.replayedCallIds.delete(toolCallId);
    const result: ToolResultBlockData = {
      tool_call_id: toolCallId,
      output: extractText(entry.message),
      is_error: entry.meta?.isError === true ? true : undefined,
    };
    streamingUI.completeToolResult(toolCallId, result);
  }
}

function parseReplayToolArgs(raw: string | null): Record<string, unknown> {
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
