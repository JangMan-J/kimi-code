/**
 * Scenario: a resumed v3 session transcript is rendered through the released VS Code Webview protocol.
 * Responsibilities: visible turns, media, assistant/tool output, subagent routing, compaction, plan state, and hidden injections.
 * Wiring: the pure replay adapter and v3 history shapes are used directly; there are no stubs.
 * Run: pnpm exec vitest run --config apps/vscode/vitest.config.ts test/replay-adapter.test.ts
 */

import type {
  AssistantEntry,
  ContentPart,
  HistoryMessage,
  ToolCall,
  ToolEntry,
  UserEntry,
} from "@moonshot-ai/agent-core";
import { describe, expect, it } from "vitest";

import {
  replaySessionToWebviewEvents,
  replayToWebviewEvents,
  type ReplayStatus,
} from "../src/runtime/replay-adapter";

function user(
  content: ContentPart[] | string,
  meta?: UserEntry["meta"],
): UserEntry {
  return {
    message: {
      role: "user",
      content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    },
    meta,
  };
}

function assistant(
  content: ContentPart[] | string,
  toolCalls: ToolCall[] = [],
  meta?: AssistantEntry["meta"],
): AssistantEntry {
  return {
    message: {
      role: "assistant",
      content: typeof content === "string" ? [{ type: "text", text: content }] : content,
      toolCalls,
    },
    meta,
  };
}

function tool(content: ContentPart[] | string, toolCallId: string, isError?: boolean): ToolEntry {
  return {
    message: {
      role: "tool",
      content: typeof content === "string" ? [{ type: "text", text: content }] : content,
      toolCallId,
    },
    meta: isError === true ? { isError: true } : undefined,
  };
}

function replay(history: readonly HistoryMessage[], status?: ReplayStatus) {
  return replayToWebviewEvents(history, "session-1", status);
}

const DEFAULT_STATUS: ReplayStatus = {
  modelAlias: "kimi-test",
  thinkingEffort: "off",
};

describe("replay adapter (renders v3 session history for the Webview)", () => {
  it("restores the selected model before transcript events", () => {
    expect(replay([], DEFAULT_STATUS)[0]).toMatchObject({
      type: "StatusUpdate",
      payload: { model: "kimi-test" },
    });
  });

  it("restores thinking effort before transcript events", () => {
    expect(replay([], { thinkingEffort: "high" })[0]).toMatchObject({
      type: "StatusUpdate",
      payload: { thinking_effort: "high" },
    });
  });

  it("restores active plan mode before transcript events", () => {
    expect(replay([], { planMode: true })[0]).toMatchObject({
      type: "StatusUpdate",
      payload: { plan_mode: true },
    });
  });

  it("restores context usage after all transcript turns", () => {
    const events = replay([], { contextTokens: 32_000, maxContextTokens: 128_000 });

    expect(events.at(-1)).toMatchObject({
      type: "StatusUpdate",
      payload: { context_usage: 0.25 },
    });
  });

  it("restores cumulative token usage exactly once after all transcript turns", () => {
    const events = replay([], {
      contextTokens: 0,
      maxContextTokens: 128_000,
      usage: { inputOther: 10, output: 4, inputCacheRead: 3, inputCacheCreation: 2 },
    });

    const statusEvents = events.filter(
      (event) =>
        event.type === "StatusUpdate" &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        "token_usage" in event.payload,
    );
    expect(statusEvents).toEqual([
      {
        type: "StatusUpdate",
        payload: {
          context_usage: 0,
          token_usage: {
            input_other: 10,
            output: 4,
            input_cache_read: 3,
            input_cache_creation: 2,
          },
        },
        _sessionId: "session-1",
      },
    ]);
  });

  it("opens one visible turn when replay contains a user prompt", () => {
    const events = replay([user("Fix the test", { origin: { kind: "user" } })]);

    expect(events.filter((event) => event.type !== "StatusUpdate")).toEqual([
      {
        type: "TurnBegin",
        payload: { user_input: [{ type: "text", text: "Fix the test" }] },
        _sessionId: "session-1",
      },
      {
        type: "stream_complete",
        result: { status: "finished" },
        _sessionId: "session-1",
      },
    ]);
  });

  it("converts engine media keys when replay renders a user prompt", () => {
    const events = replay([
      user(
        [
          { type: "image_url", source: { kind: "url", url: "file:///workspace/a.png" } },
          { type: "audio_url", source: { kind: "url", url: "file:///workspace/a.mp3" } },
          { type: "video_url", source: { kind: "url", url: "file:///workspace/a.mp4" } },
        ],
        { origin: { kind: "user" } },
      ),
    ]);

    expect(events.find((event) => event.type === "TurnBegin")).toEqual({
      type: "TurnBegin",
      payload: {
        user_input: [
          { type: "image_url", image_url: { url: "file:///workspace/a.png" } },
          { type: "audio_url", audio_url: { url: "file:///workspace/a.mp3" } },
          { type: "video_url", video_url: { url: "file:///workspace/a.mp4" } },
        ],
      },
      _sessionId: "session-1",
    });
  });

  it("renders assistant text inside the open turn", () => {
    const events = replay([
      user("Explain", { origin: { kind: "user" } }),
      assistant("Here is the answer"),
    ]);

    expect(events.filter((event) => event.type === "ContentPart")).toEqual([
      {
        type: "ContentPart",
        payload: { type: "text", text: "Here is the answer" },
        _sessionId: "session-1",
      },
    ]);
  });

  it("renders signed thinking inside the open turn", () => {
    const events = replay([
      user("Explain", { origin: { kind: "user" } }),
      assistant([{ type: "think", think: "Reviewing", encrypted: "signature" }]),
    ]);

    expect(events.filter((event) => event.type === "ContentPart")).toEqual([
      {
        type: "ContentPart",
        payload: { type: "think", think: "Reviewing", encrypted: "signature" },
        _sessionId: "session-1",
      },
    ]);
  });

  it("renders assistant media when a resumed answer contains media parts", () => {
    const events = replay([
      user("Show it", { origin: { kind: "user" } }),
      assistant([
        { type: "image_url", source: { kind: "url", url: "https://example.test/result.png" } },
        { type: "video_url", source: { kind: "url", url: "https://example.test/result.mp4" } },
      ]),
    ]);

    expect(events.filter((event) => event.type === "ContentPart")).toEqual([
      {
        type: "ContentPart",
        payload: { type: "image_url", image_url: { url: "https://example.test/result.png" } },
        _sessionId: "session-1",
      },
      {
        type: "ContentPart",
        payload: { type: "video_url", video_url: { url: "https://example.test/result.mp4" } },
        _sessionId: "session-1",
      },
    ]);
  });

  it("maps an assistant tool call to the released tool name", () => {
    const events = replay([
      user("Read it", { origin: { kind: "user" } }),
      assistant([], [
        { type: "function", id: "tool-1", name: "Read", arguments: '{"path":"README.md"}' },
      ]),
    ]);

    expect(events).toContainEqual({
      type: "ToolCall",
      payload: {
        type: "function",
        id: "tool-1",
        function: { name: "ReadFile", arguments: '{"path":"README.md"}' },
      },
      _sessionId: "session-1",
    });
  });

  it("renders a tool result in the open turn", () => {
    const events = replay([
      user("Run it", { origin: { kind: "user" } }),
      assistant([], [
        { type: "function", id: "tool-1", name: "Bash", arguments: '{"command":"pnpm test"}' },
        { type: "function", id: "tool-2", name: "Bash", arguments: '{"command":"pnpm build"}' },
      ]),
      tool("command failed", "tool-1"),
      tool("exit code 1", "tool-2", true),
    ]);

    expect(events).toContainEqual({
      type: "ToolResult",
      payload: {
        tool_call_id: "tool-1",
        return_value: {
          is_error: false,
          output: [{ type: "text", text: "command failed" }],
          message: "",
          display: [{ type: "shell", language: "bash", command: "pnpm test" }],
        },
      },
      _sessionId: "session-1",
    });
    expect(events).toContainEqual({
      type: "ToolResult",
      payload: {
        tool_call_id: "tool-2",
        return_value: {
          is_error: true,
          output: [{ type: "text", text: "exit code 1" }],
          message: "",
          display: [{ type: "shell", language: "bash", command: "pnpm build" }],
        },
      },
      _sessionId: "session-1",
    });
  });

  it("closes a completed compaction around its summary entry", () => {
    const events = replay([
      user("Continue", { origin: { kind: "user" } }),
      user("Summary prefix\nEarlier work", { source: "compaction", key: "summary" }),
    ]);

    expect(events.filter((event) => event.type.startsWith("Compaction"))).toEqual([
      { type: "CompactionBegin", payload: {}, _sessionId: "session-1" },
      { type: "CompactionEnd", payload: {}, _sessionId: "session-1" },
    ]);
  });

  it("separates consecutive user prompts into independently completed turns", () => {
    const events = replay([
      user("First", { origin: { kind: "user" } }),
      assistant("One"),
      user("Second", { origin: { kind: "user" } }),
      assistant("Two"),
    ]);

    expect(events.filter((event) => event.type !== "StatusUpdate").map((event) => event.type)).toEqual([
      "TurnBegin",
      "StepBegin",
      "ContentPart",
      "stream_complete",
      "TurnBegin",
      "StepBegin",
      "ContentPart",
      "stream_complete",
    ]);
  });

  it("does not expose an injected user message in resumed history", () => {
    const events = replay([
      user("<system>hidden reminder</system>", { source: "reminder", key: "plan" }),
      user("Visible prompt", { origin: { kind: "user" } }),
    ]);

    expect(events.filter((event) => event.type === "TurnBegin")).toEqual([
      {
        type: "TurnBegin",
        payload: { user_input: [{ type: "text", text: "Visible prompt" }] },
        _sessionId: "session-1",
      },
    ]);
  });

  it("restores a user-invoked skill as its original slash command", () => {
    const events = replay([
      user("<expanded skill prompt>", {
        origin: {
          kind: "skill_activation",
          activationId: "activation-1",
          skillName: "review",
          skillArgs: "focus on errors",
          trigger: "user-slash",
        },
      } as unknown as UserEntry["meta"]),
    ]);

    expect(events).toContainEqual({
      type: "TurnBegin",
      payload: { user_input: [{ type: "text", text: "/skill:review focus on errors" }] },
      _sessionId: "session-1",
    });
  });

  it("restores imported context as the original command and confirmation", () => {
    const events = replay([
      user(
        [
          { type: "text", text: "<system>The user imported prior context.</system>" },
          {
            type: "text",
            text: '<imported_context source="file &apos;notes.md&apos;">\nPrior decision.\n</imported_context>',
          },
        ],
        { origin: { kind: "user" } },
      ),
    ]);

    expect(events).toContainEqual({
      type: "TurnBegin",
      payload: { user_input: [{ type: "text", text: "/import notes.md" }] },
      _sessionId: "session-1",
    });
    expect(events).toContainEqual({
      type: "ContentPart",
      payload: { type: "text", text: "Imported context from file 'notes.md' (15 chars)." },
      _sessionId: "session-1",
    });
    expect(JSON.stringify(events)).not.toContain("Prior decision.");
  });

  it("does not count a model-invoked skill as a user-visible turn", () => {
    const events = replay([
      user("<expanded nested skill>", {
        origin: {
          kind: "skill_activation",
          activationId: "activation-model",
          skillName: "helper",
          trigger: "model-tool",
        },
      } as unknown as UserEntry["meta"]),
    ]);

    expect(events.filter((event) => event.type === "TurnBegin")).toEqual([]);
  });

  it("restores a user-invoked plugin command as its original slash command", () => {
    const events = replay([
      user("/review", {
        origin: {
          kind: "plugin_command",
          activationId: "activation-1",
          pluginId: "review-plugin",
          commandName: "review",
          trigger: "user-slash",
        },
      } as unknown as UserEntry["meta"]),
    ]);

    expect(events).toContainEqual({
      type: "TurnBegin",
      payload: { user_input: [{ type: "text", text: "/review-plugin:review" }] },
      _sessionId: "session-1",
    });
  });

  it("routes repeated runs of one subagent to their corresponding Agent calls", () => {
    const mainHistory: HistoryMessage[] = [
      user("First", { origin: { kind: "user" } }),
      assistant([], [{ type: "function", id: "agent-call-1", name: "Agent", arguments: "{}" }]),
      tool("agent_id: sub-1\nstatus: completed", "agent-call-1"),
      user("Second", { origin: { kind: "user" } }),
      assistant([], [{ type: "function", id: "agent-call-2", name: "Agent", arguments: "{}" }]),
      tool("agent_id: sub-1\nstatus: completed", "agent-call-2"),
    ];
    const childHistory: HistoryMessage[] = [
      user("child one", { origin: { kind: "subagent" } }),
      assistant("first child answer"),
      user("child two", { origin: { kind: "subagent" } }),
      assistant("second child answer"),
    ];

    const events = replaySessionToWebviewEvents(
      {
        agents: {
          main: { history: mainHistory },
          "sub-1": { history: childHistory },
        },
        roster: {
          main: {},
          "sub-1": { source: "spawn:main:coder" },
        },
        status: DEFAULT_STATUS,
      },
      "session-1",
    );

    expect(events).toContainEqual(expect.objectContaining({
      type: "SubagentEvent",
      payload: {
        parent_tool_call_id: "agent-call-1",
        event: { type: "ContentPart", payload: { type: "text", text: "first child answer" } },
      },
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "SubagentEvent",
      payload: {
        parent_tool_call_id: "agent-call-2",
        event: { type: "ContentPart", payload: { type: "text", text: "second child answer" } },
      },
    }));
  });
});
