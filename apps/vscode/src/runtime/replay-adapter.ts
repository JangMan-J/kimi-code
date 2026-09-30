import type {
  ContentPart as EngineContentPart,
  HistoryMessage,
  MediaSource,
  ToolCall as EngineToolCall,
  ToolMeta,
} from "@moonshot-ai/agent-core";

import type {
  ContentPart as LegacyContentPart,
  DisplayBlock,
  LegacyWireEvent,
  RunResult,
  TokenUsage,
  ToolCall,
} from "../../shared/legacy-sdk";
import type { UIStreamEvent } from "../../shared/types";
import { toLegacyToolName, type AdapterTokenUsage } from "./event-adapter";
import { deriveToolDisplay } from "./tool-display";

function mediaUrlFromSource(source: MediaSource): string {
  switch (source.kind) {
    case "url":
      return source.url;
    case "store":
      return source.ref;
    case "inline":
      return `data:${source.mimeType};base64,${source.data}`;
    case "file":
      return source.id;
  }
}

export interface ReplayStatus {
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly planMode?: boolean;
  readonly contextTokens?: number;
  readonly maxContextTokens?: number;
  readonly usage?: AdapterTokenUsage;
}

export interface ReplayAgentSource {
  readonly history: readonly HistoryMessage[];
}

export interface ReplaySessionSource {
  readonly agents: Readonly<Record<string, ReplayAgentSource>>;
  readonly roster?: Readonly<Record<string, { readonly source?: string }>>;
  readonly status?: ReplayStatus;
}

interface SubagentReplayInvocation {
  readonly parentAgentId: string;
  readonly parentToolCallId: string;
  readonly childAgentId: string;
  readonly startedAt: number;
  readonly order: number;
  records: readonly HistoryMessage[];
}

interface SubagentReplayIndex {
  readonly byParentCall: ReadonlyMap<string, readonly SubagentReplayInvocation[]>;
}

export function replaySessionToWebviewEvents(
  source: ReplaySessionSource,
  sessionId: string,
): UIStreamEvent[] {
  const main = source.agents["main"];
  if (main === undefined) throw new Error("Session history is unavailable.");
  return replayAgentToWebviewEvents(
    main.history,
    sessionId,
    source.status,
    buildSubagentReplayIndex(source),
  );
}

export function replayToWebviewEvents(
  history: readonly HistoryMessage[],
  sessionId: string,
  status?: ReplayStatus,
): UIStreamEvent[] {
  return replayAgentToWebviewEvents(history, sessionId, status);
}

function replayAgentToWebviewEvents(
  history: readonly HistoryMessage[],
  sessionId: string,
  status?: ReplayStatus,
  subagents?: SubagentReplayIndex,
): UIStreamEvent[] {
  const events: UIStreamEvent[] = [];
  let turnOpen = false;
  let step = 0;
  const toolDisplays = new Map<string, readonly DisplayBlock[]>();

  const leadingStatus: Record<string, unknown> = {};
  if (status?.modelAlias !== undefined) leadingStatus["model"] = status.modelAlias;
  if (status?.thinkingEffort !== undefined) leadingStatus["thinking_effort"] = status.thinkingEffort;
  if (status?.planMode !== undefined) leadingStatus["plan_mode"] = status.planMode;
  if (Object.keys(leadingStatus).length > 0) {
    events.push(withSession({ type: "StatusUpdate", payload: leadingStatus }, sessionId));
  }

  const completeTurn = () => {
    if (!turnOpen) return;
    const result: RunResult = { status: "finished" };
    events.push({ type: "stream_complete", result, _sessionId: sessionId });
    turnOpen = false;
  };

  const ensureStep = () => {
    if (!turnOpen) return;
    if (step === 0) {
      step = 1;
      events.push(withSession({ type: "StepBegin", payload: { n: step } }, sessionId));
    }
  };

  for (const entry of history) {
    const message = entry.message;
    if (message.role === "user") {
      if (isCompactionSummary(entry)) {
        if (turnOpen) {
          ensureStep();
          events.push(withSession({ type: "CompactionBegin", payload: {} }, sessionId));
          events.push(withSession({ type: "CompactionEnd", payload: {} }, sessionId));
        }
        continue;
      }
      if (isInternalEntry(entry)) continue;
      if (!isVisibleUserMessage(entry)) continue;
      const imported = importedContextReplay(message.content);
      completeTurn();
      step = 0;
      turnOpen = true;
      events.push(
        withSession(
          {
            type: "TurnBegin",
            payload: {
              user_input: imported?.input ?? replayUserInput(message.content, entry),
            },
          },
          sessionId,
        ),
      );
      if (imported !== undefined) {
        ensureStep();
        events.push(
          withSession(
            { type: "ContentPart", payload: { type: "text", text: imported.confirmation } },
            sessionId,
          ),
        );
      }
      continue;
    }

    if (message.role === "assistant") {
      if (!turnOpen) continue;
      ensureStep();
      for (const part of toLegacyContent(message.content)) {
        events.push(withSession({ type: "ContentPart", payload: part }, sessionId));
      }
      for (const call of message.toolCalls) {
        const display = deriveToolDisplay(call.name, parseToolArguments(call.arguments));
        toolDisplays.set(call.id, display);
        const toolCall: ToolCall = {
          type: "function",
          id: call.id,
          function: {
            name: toLegacyToolName(call.name),
            arguments: call.arguments,
          },
        };
        events.push(withSession({ type: "ToolCall", payload: toolCall }, sessionId));
        if (subagents !== undefined) {
          for (const nested of renderSubagentInvocations(
            subagents,
            "main",
            call.id,
            [],
            new Set(),
          )) {
            events.push(withSession(nested, sessionId));
          }
        }
      }
      continue;
    }

    if (message.role === "tool" && turnOpen) {
      ensureStep();
      const display = toolDisplays.get(message.toolCallId) ?? [];
      toolDisplays.delete(message.toolCallId);
      events.push(
        withSession(
          {
            type: "ToolResult",
            payload: {
              tool_call_id: message.toolCallId,
              return_value: {
                is_error: (entry.meta as ToolMeta | undefined)?.isError === true,
                output: toLegacyContent(message.content),
                message: "",
                display: [...display],
              },
            },
          },
          sessionId,
        ),
      );
    }
  }

  completeTurn();
  const resumedStatus = resumedStatusPayload(status);
  if (Object.keys(resumedStatus).length > 0) {
    events.push(withSession({ type: "StatusUpdate", payload: resumedStatus }, sessionId));
  }
  return events;
}

function buildSubagentReplayIndex(source: ReplaySessionSource): SubagentReplayIndex {
  const invocations: SubagentReplayInvocation[] = [];
  let order = 0;

  for (const [parentAgentId, parent] of Object.entries(source.agents)) {
    const calls = new Map<string, { readonly name: string; readonly order: number }>();
    let time = 0;
    for (const entry of parent.history) {
      time += 1;
      const { message } = entry;
      if (message.role === "assistant") {
        for (const call of message.toolCalls) {
          calls.set(call.id, { name: call.name, order: order++ });
        }
        continue;
      }
      if (message.role !== "tool") continue;
      const call = calls.get(message.toolCallId);
      if (call === undefined || (call.name !== "Agent" && call.name !== "AgentSwarm")) continue;
      for (const childAgentId of subagentIdsFromResult(call.name, message.content)) {
        if (source.agents[childAgentId] === undefined) continue;
        if (parentAgentIdOf(source, childAgentId) !== parentAgentId) continue;
        invocations.push({
          parentAgentId,
          parentToolCallId: message.toolCallId,
          childAgentId,
          startedAt: time,
          order: call.order,
          records: [],
        });
      }
    }
  }

  const byChild = new Map<string, SubagentReplayInvocation[]>();
  for (const invocation of invocations) {
    const entries = byChild.get(invocation.childAgentId) ?? [];
    entries.push(invocation);
    byChild.set(invocation.childAgentId, entries);
  }
  for (const [childAgentId, entries] of byChild) {
    entries.sort(compareInvocation);
    const history = source.agents[childAgentId]?.history ?? [];
    const promptStarts = history.flatMap((entry, index) =>
      entry.message.role === "user" ? [index] : [],
    );
    for (const [index, invocation] of entries.entries()) {
      const start = promptStarts[Math.min(index, promptStarts.length - 1)] ?? 0;
      const end = promptStarts[index + 1] ?? history.length;
      invocation.records = index < promptStarts.length ? history.slice(start, end) : [];
    }
  }

  const byParentCall = new Map<string, SubagentReplayInvocation[]>();
  for (const invocation of invocations) {
    const key = parentCallKey(invocation.parentAgentId, invocation.parentToolCallId);
    const entries = byParentCall.get(key) ?? [];
    entries.push(invocation);
    byParentCall.set(key, entries);
  }
  for (const entries of byParentCall.values()) entries.sort(compareInvocation);
  return { byParentCall };
}

function parentAgentIdOf(source: ReplaySessionSource, childAgentId: string): string | undefined {
  const origin = source.roster?.[childAgentId]?.source;
  if (origin === undefined) return undefined;
  const match = /^spawn:([^:]+):/.exec(origin);
  if (match !== null) return match[1];
  return origin === "session-init" ? "main" : undefined;
}

function compareInvocation(a: SubagentReplayInvocation, b: SubagentReplayInvocation): number {
  return a.startedAt - b.startedAt || a.order - b.order;
}

function subagentIdsFromResult(
  toolName: "Agent" | "AgentSwarm",
  content: readonly EngineContentPart[],
): readonly string[] {
  const text = content
    .filter((part): part is Extract<EngineContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
  if (toolName === "Agent") {
    const header = text.split("\n\n", 1)[0] ?? text;
    const match = /(?:^|\n)agent_id:\s*([^\s]+)\s*(?=\n|$)/.exec(header);
    return match === null ? [] : [match[1]!];
  }
  const pattern = /<subagent\b[^>]*\bagent_id="([^"]+)"[^>]*\boutcome="[^"]+">/g;
  return [...text.matchAll(pattern)].map((match) => match[1]!).filter(uniqueString);
}

function uniqueString(value: string, index: number, values: readonly string[]): boolean {
  return values.indexOf(value) === index;
}

function renderSubagentInvocations(
  index: SubagentReplayIndex,
  parentAgentId: string,
  parentToolCallId: string,
  parentChain: readonly SubagentReplayInvocation[],
  visited: ReadonlySet<string>,
): LegacyWireEvent[] {
  const result: LegacyWireEvent[] = [];
  const invocations = index.byParentCall.get(parentCallKey(parentAgentId, parentToolCallId)) ?? [];
  for (const invocation of invocations) {
    const invocationKey = `${invocation.parentAgentId} ${invocation.parentToolCallId} ${invocation.childAgentId} ${String(invocation.startedAt)}`;
    if (visited.has(invocationKey)) continue;
    const nextVisited = new Set([...visited, invocationKey]);
    result.push(
      ...renderSubagentInvocation(index, invocation, [invocation, ...parentChain], nextVisited),
    );
  }
  return result;
}

function renderSubagentInvocation(
  index: SubagentReplayIndex,
  invocation: SubagentReplayInvocation,
  chain: readonly SubagentReplayInvocation[],
  visited: ReadonlySet<string>,
): LegacyWireEvent[] {
  const events: LegacyWireEvent[] = [];
  const toolDisplays = new Map<string, readonly DisplayBlock[]>();
  let step = 0;

  const emit = (event: LegacyWireEvent) => {
    events.push(wrapSubagentEvent(event, chain));
  };

  for (const entry of invocation.records) {
    const { message } = entry;
    if (message.role === "user") {
      step = 0;
      continue;
    }
    if (message.role === "assistant") {
      step += 1;
      emit({ type: "StepBegin", payload: { n: step } });
      for (const part of toLegacyContent(message.content)) {
        emit({ type: "ContentPart", payload: part });
      }
      for (const call of message.toolCalls) {
        const toolCallId = scopedReplayToolCallId(invocation.childAgentId, call.id);
        toolDisplays.set(toolCallId, deriveToolDisplay(call.name, parseToolArguments(call.arguments)));
        emit({
          type: "ToolCall",
          payload: {
            type: "function",
            id: toolCallId,
            function: {
              name: toLegacyToolName(call.name),
              arguments: call.arguments,
            },
          },
        });
        events.push(
          ...renderSubagentInvocations(
            index,
            invocation.childAgentId,
            call.id,
            chain,
            visited,
          ),
        );
      }
      continue;
    }
    if (message.role === "tool") {
      const toolCallId = scopedReplayToolCallId(invocation.childAgentId, message.toolCallId);
      const display = toolDisplays.get(toolCallId) ?? [];
      toolDisplays.delete(toolCallId);
      emit({
        type: "ToolResult",
        payload: {
          tool_call_id: toolCallId,
          return_value: {
            is_error: (entry.meta as ToolMeta | undefined)?.isError === true,
            output: toLegacyContent(message.content),
            message: "",
            display: [...display],
          },
        },
      });
    }
  }
  return events;
}

function wrapSubagentEvent(
  event: LegacyWireEvent,
  chain: readonly SubagentReplayInvocation[],
): LegacyWireEvent {
  let routed = event;
  for (const invocation of chain) {
    routed = {
      type: "SubagentEvent",
      payload: {
        parent_tool_call_id: scopedReplayToolCallId(
          invocation.parentAgentId,
          invocation.parentToolCallId,
        ),
        event: routed,
      },
    };
  }
  return routed;
}

function scopedReplayToolCallId(agentId: string, toolCallId: string): string {
  return agentId === "main" ? toolCallId : `${agentId}:${toolCallId}`;
}

function parentCallKey(agentId: string, toolCallId: string): string {
  return `${agentId} ${toolCallId}`;
}

function resumedStatusPayload(status: ReplayStatus | undefined): {
  context_usage?: number;
  token_usage?: TokenUsage;
} {
  if (status === undefined) return {};
  const contextUsage =
    status.contextTokens !== undefined &&
    status.maxContextTokens !== undefined &&
    status.maxContextTokens > 0
      ? status.contextTokens / status.maxContextTokens
      : undefined;
  return {
    ...(contextUsage === undefined ? {} : { context_usage: contextUsage }),
    ...(status.usage === undefined
      ? {}
      : {
          token_usage: {
            input_other: status.usage.inputOther,
            output: status.usage.output,
            input_cache_read: status.usage.inputCacheRead,
            input_cache_creation: status.usage.inputCacheCreation,
          },
        }),
  };
}

function toLegacyContent(content: readonly EngineContentPart[]): LegacyContentPart[] {
  const result: LegacyContentPart[] = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
        result.push({ type: "text", text: part.text });
        break;
      case "think":
        if (part.hidden === true) break;
        result.push({
          type: "think",
          think: part.think,
          ...(part.encrypted === undefined ? {} : { encrypted: part.encrypted }),
        });
        break;
      case "image_url":
        result.push({ type: "image_url", image_url: { url: mediaUrlFromSource(part.source) } });
        break;
      case "audio_url":
        result.push({ type: "audio_url", audio_url: { url: mediaUrlFromSource(part.source) } });
        break;
      case "video_url":
        result.push({ type: "video_url", video_url: { url: mediaUrlFromSource(part.source) } });
        break;
    }
  }
  return result;
}

function isCompactionSummary(entry: HistoryMessage): boolean {
  const meta = entry.meta as { readonly source?: string; readonly key?: string } | undefined;
  return meta?.source === "compaction" && meta.key === "summary";
}

function isInternalEntry(entry: HistoryMessage): boolean {
  const source = (entry.meta as { readonly source?: string } | undefined)?.source;
  return (
    source === "reminder" ||
    source === "notify" ||
    source === "async-tool" ||
    source === "compaction"
  );
}

function isVisibleUserMessage(entry: HistoryMessage): boolean {
  const origin = (entry.meta as { readonly origin?: unknown } | undefined)?.origin as
    | { readonly kind?: unknown }
    | undefined;
  if (origin === undefined || origin.kind === undefined || origin.kind === "user") return true;
  if (origin.kind === "skill_activation" || origin.kind === "plugin_command") {
    return (origin as { readonly trigger?: unknown }).trigger === "user-slash";
  }
  return (
    origin.kind === "shell_command" &&
    (origin as { readonly phase?: unknown }).phase === "input"
  );
}

function replayUserInput(
  content: readonly EngineContentPart[],
  entry: HistoryMessage,
): LegacyContentPart[] {
  const origin = (entry.meta as { readonly origin?: unknown } | undefined)?.origin as
    | Record<string, unknown>
    | undefined;
  if (origin?.["kind"] === "skill_activation" && origin["trigger"] === "user-slash") {
    const skillName = typeof origin["skillName"] === "string" ? origin["skillName"] : "skill";
    const args = typeof origin["skillArgs"] === "string" ? origin["skillArgs"].trim() : "";
    return [{
      type: "text",
      text: `/skill:${skillName}${args.length > 0 ? ` ${args}` : ""}`,
    }];
  }
  if (origin?.["kind"] === "plugin_command") {
    const pluginId = typeof origin["pluginId"] === "string" ? origin["pluginId"] : "plugin";
    const commandName = typeof origin["commandName"] === "string" ? origin["commandName"] : "command";
    const args = typeof origin["commandArgs"] === "string" ? origin["commandArgs"].trim() : "";
    return [{
      type: "text",
      text: `/${pluginId}:${commandName}${args.length > 0 ? ` ${args}` : ""}`,
    }];
  }
  return toLegacyContent(content);
}

function importedContextReplay(
  content: readonly EngineContentPart[],
): { input: LegacyContentPart[]; confirmation: string } | undefined {
  const importedPart = content.find(
    (part): part is Extract<EngineContentPart, { type: "text" }> =>
      part.type === "text" && part.text.startsWith("<imported_context "),
  );
  if (importedPart === undefined) return undefined;
  const match = /^<imported_context source="([^"]*)">\n([\s\S]*)\n<\/imported_context>$/.exec(
    importedPart.text,
  );
  if (match === null) return undefined;
  const source = decodeXml(match[1]!);
  const importedText = match[2]!;
  const target = importTarget(source);
  return {
    input: [{ type: "text", text: `/import ${target}` }],
    confirmation: `Imported context from ${source} (${String(importedText.length)} chars).`,
  };
}

function importTarget(source: string): string {
  const quoted = /^(?:file|session) '([\s\S]*)'$/.exec(source);
  return quoted?.[1] ?? source;
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function parseToolArguments(raw: string | null): unknown {
  if (raw === null || raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

function withSession<T extends LegacyWireEvent>(event: T, sessionId: string): T & { _sessionId: string } {
  return { ...event, _sessionId: sessionId };
}
