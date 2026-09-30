import {
  extractText,
  isSkillPart,
  stripBundledSkillBlocks,
  type HistoryMessage,
  type Projection,
  type PromptOrigin,
  type RecordEvent,
  type UserEntry,
} from '@moonshot-ai/agent-core';

import type { CronTranscriptData, SkillActivationTrigger } from '../types';

export const REPLAY_TURN_LIMIT = 10;

export interface ReplayTurn {
  readonly turnId: number | undefined;
  readonly entries: HistoryMessage[];
  readonly outcome: 'done' | 'failed' | 'aborted' | undefined;
}

export interface ReplayTurnLog {
  readonly turns: readonly ReplayTurn[];
}

export function replayTurnLog<C>(): Projection<ReplayTurnLog, RecordEvent, C> {
  return {
    initial: () => ({ turns: [] }),
    reduce: (state, event) => {
      if (event.type === 'turn.started') {
        const turnId = event['turnId'] as number;
        return { turns: [...state.turns, { turnId, entries: [], outcome: undefined }] };
      }
      if (event.type === 'message.appended') {
        const message = event['message'] as HistoryMessage;
        if (state.turns.length === 0) {
          return { turns: [{ turnId: undefined, entries: [message], outcome: undefined }] };
        }
        const last = state.turns[state.turns.length - 1]!;
        if (last.outcome !== undefined) {
          return { turns: [...state.turns, { turnId: undefined, entries: [message], outcome: undefined }] };
        }
        const next = { ...last, entries: [...last.entries, message] };
        return { turns: [...state.turns.slice(0, -1), next] };
      }
      if (event.type === 'turn.ended') {
        const turnId = event['turnId'] as number;
        const outcome = event['outcome'] as ReplayTurn['outcome'];
        const index = state.turns.findLastIndex((turn) => turn.turnId === turnId);
        if (index < 0) return state;
        return {
          turns: state.turns.map((turn, i) => (i === index ? { ...turn, outcome } : turn)),
        };
      }
      return state;
    },
  };
}

export function limitReplayTurns(
  turns: readonly ReplayTurn[],
  maxTurns: number = REPLAY_TURN_LIMIT,
): readonly ReplayTurn[] {
  if (maxTurns <= 0 || turns.length <= maxTurns) return turns;
  return turns.slice(turns.length - maxTurns);
}

export interface ReplaySkillActivation {
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string;
  readonly trigger?: SkillActivationTrigger;
}

export type ReplayUserAction =
  | { readonly kind: 'skip' }
  | { readonly kind: 'boundary' }
  | { readonly kind: 'cron'; readonly prompt: string; readonly data: CronTranscriptData }
  | { readonly kind: 'compaction-summary'; readonly summary: string }
  | { readonly kind: 'compaction-elision'; readonly text: string }
  | {
      readonly kind: 'prompt';
      readonly text: string;
      readonly skills: readonly ReplaySkillActivation[];
    };

export function classifyReplayUserEntry(entry: UserEntry): ReplayUserAction {
  const meta = entry.meta;
  const source = meta?.source;
  if (source === 'reminder' || source === 'notify' || source === 'async-tool') {
    return { kind: 'skip' };
  }
  if (source === 'compaction') {
    if (meta?.key === 'summary') {
      return { kind: 'compaction-summary', summary: stripSummaryPrefix(extractText(entry.message)) };
    }
    if (meta?.key === 'elision') {
      return { kind: 'compaction-elision', text: extractText(entry.message) };
    }
    return { kind: 'skip' };
  }
  const origin = meta?.origin;
  if (origin?.kind === 'cron_job') {
    return { kind: 'cron', prompt: cronPromptText(extractText(entry.message)), data: cronDataOf(origin) };
  }
  if (origin?.kind === 'system_trigger' || origin?.kind === 'retry' || origin?.kind === 'subagent') {
    return { kind: 'boundary' };
  }
  const skills = skillActivationsOf(entry);
  const text = extractText({ content: stripBundledSkillBlocks(entry.message) });
  if (text.trim().length === 0 && skills.length === 0) return { kind: 'skip' };
  return { kind: 'prompt', text, skills };
}

function skillActivationsOf(entry: UserEntry): ReplaySkillActivation[] {
  const activations: ReplaySkillActivation[] = [];
  for (const part of entry.message.content) {
    if (!isSkillPart(part)) continue;
    activations.push({
      activationId: part.meta.activationId,
      skillName: part.meta.skillName,
      skillArgs: part.meta.skillArgs,
      trigger: triggerOf(entry.meta?.origin),
    });
  }
  return activations;
}

function triggerOf(origin: PromptOrigin | undefined): SkillActivationTrigger | undefined {
  if (origin?.kind !== 'skill_activation') return undefined;
  const trigger = (origin as { readonly trigger?: unknown }).trigger;
  return trigger === 'user-slash' || trigger === 'model-tool' || trigger === 'nested-skill'
    ? trigger
    : undefined;
}

function stripSummaryPrefix(text: string): string {
  const newline = text.indexOf('\n');
  return newline < 0 ? '' : text.slice(newline + 1);
}

function cronPromptText(text: string): string {
  const open = '<prompt>\n';
  const close = '\n</prompt>';
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start >= 0 && end >= start + open.length) {
    return text.slice(start + open.length, end);
  }
  return text;
}

function cronDataOf(origin: { readonly kind: string }): CronTranscriptData {
  const record = origin as Record<string, unknown>;
  return {
    jobId: typeof record['jobId'] === 'string' ? record['jobId'] : undefined,
    cron: typeof record['cron'] === 'string' ? record['cron'] : undefined,
    recurring: typeof record['recurring'] === 'boolean' ? record['recurring'] : undefined,
    coalescedCount:
      typeof record['coalescedCount'] === 'number' ? record['coalescedCount'] : undefined,
    stale: typeof record['stale'] === 'boolean' ? record['stale'] : undefined,
  };
}
