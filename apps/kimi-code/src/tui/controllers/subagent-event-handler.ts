import {
  AgentModelRef,
  type AgentHandle,
} from '@moonshot-ai/agent-core';
import type { ToolOutput } from '@moonshot-ai/agent-core/agent-machine/tool';
import { watch } from '@moonshot-ai/agent-core/kernel/index';
import {
  UsageRef,
  parseSpawnSource,
  SUBAGENT_UPDATE_KEY,
} from '@moonshot-ai/harness-core';
import type { KimiSession } from '@moonshot-ai/kimi-code-sdk';

import type { ToolCallBlockData } from '../types';
import { toolOutcomeToResult, type StreamingUIController } from './streaming-ui';

export interface SubagentEventHost {
  session: KimiSession | undefined;
  readonly streamingUI: StreamingUIController;
}

interface ChildSubscription {
  readonly agentId: string;
  readonly agentName: string | undefined;
  readonly runInBackground: boolean;
  parentToolCallId: string;
  readonly off: Array<() => void>;
}

export class SubagentEventHandler {
  private readonly children = new Map<string, ChildSubscription>();

  constructor(private readonly host: SubagentEventHost) {}

  reset(): void {
    for (const child of this.children.values()) {
      for (const off of child.off) off();
    }
    this.children.clear();
  }

  onToolUpdate(toolCallId: string, update: { key: string; text: string }): void {
    if (update.key !== SUBAGENT_UPDATE_KEY) return;
    const agentId = update.text;
    if (agentId.length === 0) return;
    const { streamingUI } = this.host;
    const toolCall = streamingUI.getActiveToolCall(toolCallId);
    if (toolCall === undefined) return;
    if (streamingUI.getToolComponent(toolCallId) === undefined) {
      streamingUI.onToolCallStart(toolCall);
    }
    const tc = streamingUI.getToolComponent(toolCallId);
    if (tc === undefined) return;
    const runInBackground = toolCall.args['run_in_background'] === true;
    const agentName = this.profileNameOf(toolCall, agentId);
    tc.onSubagentSpawned({ agentId, agentName, runInBackground });
    this.associate(agentId, toolCallId, agentName, runInBackground);
  }

  onToolDetached(toolCallId: string): void {
    const child = this.childByToolCall(toolCallId);
    if (child === undefined) return;
    this.host.streamingUI.getToolComponent(toolCallId)?.markBackgrounded();
  }

  onToolDone(toolCallId: string, outcome: ToolOutput): void {
    const child = this.childByToolCall(toolCallId);
    if (child === undefined) return;
    const tc = this.host.streamingUI.getToolComponent(toolCallId);
    if (tc === undefined) return;
    const result = toolOutcomeToResult(toolCallId, outcome);
    const parsed = parseAgentResult(result.output);
    if (result.is_error === true) {
      tc.onSubagentFailed({ error: parsed.error ?? result.output });
      return;
    }
    if (parsed.status === 'failed') {
      tc.onSubagentFailed({ error: parsed.error ?? result.output });
      return;
    }
    tc.onSubagentCompleted({ resultSummary: parsed.summary ?? '' });
  }

  onAgentClosed(agentId: string): void {
    const child = this.children.get(agentId);
    if (child === undefined) return;
    for (const off of child.off) off();
    this.children.delete(agentId);
  }

  private childByToolCall(toolCallId: string): ChildSubscription | undefined {
    for (const child of this.children.values()) {
      if (child.parentToolCallId === toolCallId) return child;
    }
    return undefined;
  }

  private profileNameOf(toolCall: ToolCallBlockData, agentId: string): string | undefined {
    const explicit = toolCall.args['subagent_type'];
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;
    const roster = this.host.session?.handle.stores.session.getState().roster.agents[agentId];
    return parseSpawnSource(roster?.source)?.profileName;
  }

  private associate(
    agentId: string,
    parentToolCallId: string,
    agentName: string | undefined,
    runInBackground: boolean,
  ): void {
    const session = this.host.session;
    if (session === undefined) return;
    const existing = this.children.get(agentId);
    if (existing !== undefined) {
      existing.parentToolCallId = parentToolCallId;
      return;
    }
    const target = session.handle.get(agentId);
    if (target === undefined) return;
    const off: Array<() => void> = [];
    const card = (): ReturnType<StreamingUIController['getToolComponent']> => {
      const child = this.children.get(agentId);
      if (child === undefined) return undefined;
      return this.host.streamingUI.getToolComponent(child.parentToolCallId);
    };
    const use = (subscription: { unsubscribe(): void } | (() => void)): void => {
      if (typeof subscription === 'function') off.push(subscription);
      else off.push(() => subscription.unsubscribe());
    };
    use(target.on('turn.started', () => {
      card()?.onSubagentStarted({ agentId, agentName, runInBackground });
    }));
    use(target.on('llm.streaming.part', (event) => {
      const part = event.part;
      if (part.type === 'text') card()?.appendSubagentText(part.text, 'text');
      else if (part.type === 'think') card()?.appendSubagentText(part.think, 'thinking');
    }));
    use(target.on('turn.spawn_tools', (event) => {
      for (const call of event.toolCalls) {
        card()?.appendSubToolCall({
          id: call.id,
          name: call.name,
          args: parseChildToolArgs(call.arguments),
        });
      }
    }));
    use(target.on('tool.update', (event) => {
      if (event.update.key === SUBAGENT_UPDATE_KEY) return;
      if (event.update.text.length === 0) return;
      card()?.appendSubToolLiveOutput(event.toolCallId, event.update.text);
    }));
    use(target.on('tool.done', (event) => {
      const result = toolOutcomeToResult(event.toolCallId, event.outcome);
      card()?.finishSubToolCall({
        tool_call_id: event.toolCallId,
        output: result.output,
        is_error: result.is_error,
      });
    }));
    off.push(this.watchChildFacades(target, agentId));
    this.children.set(agentId, { agentId, agentName, runInBackground, parentToolCallId, off });
  }

  private watchChildFacades(target: AgentHandle, agentId: string): () => void {
    const off: Array<() => void> = [];
    const card = (): ReturnType<StreamingUIController['getToolComponent']> => {
      const child = this.children.get(agentId);
      if (child === undefined) return undefined;
      return this.host.streamingUI.getToolComponent(child.parentToolCallId);
    };
    const model = target.resolve(AgentModelRef);
    if (model !== undefined) {
      off.push(watch(model.current, (current) => {
        if (current.alias === undefined) return;
        card()?.updateSubagentMetrics({ modelDisplay: current.alias });
      }, { immediate: true }));
    }
    const usage = target.resolve(UsageRef);
    if (usage !== undefined) {
      off.push(watch(usage.summary, (summary) => {
        card()?.updateSubagentMetrics({ usage: summary.total });
      }, { immediate: true }));
    }
    return () => {
      for (const stop of off) stop();
    };
  }
}

function parseChildToolArgs(raw: string | null): Record<string, unknown> {
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

function parseAgentResult(output: string): {
  readonly status: 'completed' | 'failed' | undefined;
  readonly summary?: string;
  readonly error?: string;
} {
  const statusMatch = /^status:\s*(\w+)/m.exec(output);
  const status =
    statusMatch?.[1] === 'completed'
      ? 'completed'
      : statusMatch?.[1] === 'failed'
        ? 'failed'
        : undefined;
  const summaryMarker = '[summary]\n';
  const summaryStart = output.indexOf(summaryMarker);
  if (status === 'completed' && summaryStart >= 0) {
    let summary = output.slice(summaryStart + summaryMarker.length);
    const hint = summary.indexOf('\n\nresume_hint');
    if (hint >= 0) summary = summary.slice(0, hint);
    return { status, summary: summary.trim() };
  }
  if (status === 'failed') {
    const errorMarker = 'subagent error: ';
    const errorStart = output.indexOf(errorMarker);
    if (errorStart >= 0) {
      let error = output.slice(errorStart + errorMarker.length);
      for (const stop of ['\nresume_hint', '\nnext_step']) {
        const cut = error.indexOf(stop);
        if (cut >= 0) error = error.slice(0, cut);
      }
      return { status, error: error.trim() };
    }
    return { status };
  }
  return { status };
}
