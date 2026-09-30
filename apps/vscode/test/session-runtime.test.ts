/**
 * Scenario: one VS Code session runtime adapts a v3 Kimi session for one or more Webviews.
 * Responsibilities: prompt conversion, event/terminal delivery, reverse RPC, cancellation, and baseline capture.
 * Wiring: SessionRuntime and the v3 event source are real; a fake engine session forms the boundary.
 * Run: pnpm exec vitest run --config apps/vscode/vitest.config.ts apps/vscode/test/session-runtime.test.ts
 */

import { CompactionRef } from "@moonshot-ai/harness-core";
import { describe, expect, it, vi } from "vitest";

import { Events } from "../shared/bridge";
import type { LegacyApprovalFlags } from "../src/runtime/legacy-approval";
import { SessionRuntime } from "../src/runtime/session-runtime";
import { createFakeEngineSession, type FakeEngineSession } from "./fake-engine-session";

interface BroadcastRecord {
  readonly event: string;
  readonly data: unknown;
  readonly webviewId?: string;
}

interface BaselineRecord {
  readonly session: { readonly id: string; readonly workDir: string; readonly metadata?: Readonly<Record<string, unknown>> };
  readonly filePath: string;
  readonly webviewIds: readonly string[];
}

const DEFAULT_LEGACY_APPROVAL: LegacyApprovalFlags = { yolo: false, afk: false };

function createRuntime(
  legacyApproval = DEFAULT_LEGACY_APPROVAL,
  options: {
    readonly updateMetadata?: (
      id: string,
      patch: Record<string, unknown>,
    ) => Promise<Readonly<Record<string, unknown>> | undefined>;
  } = {},
) {
  const engine = createFakeEngineSession("session-1");
  const broadcasts: BroadcastRecord[] = [];
  const baselines: BaselineRecord[] = [];
  const metadataUpdates: Record<string, unknown>[] = [];
  const compaction = {
    compact: vi.fn(async (_instruction?: string) => ({ branchId: "branch-2" })),
    cancel: vi.fn(),
    status: vi.fn(() => "idle"),
  };
  engine.main.facades.set(CompactionRef, compaction);
  const runtime = new SessionRuntime({
    session: engine.session,
    workDir: "/workspace",
    legacyApproval,
    broadcast: (event, data, webviewId) => broadcasts.push({ event, data, webviewId }),
    captureBaseline: (session, filePath, webviewIds) => {
      baselines.push({ session, filePath, webviewIds });
    },
    updateMetadata:
      options.updateMetadata ??
      (async (_id, patch) => {
        metadataUpdates.push(patch);
        return { ...patch };
      }),
    recreateSession: async () => engine.session,
    log: () => undefined,
  });
  runtime.setSessionRecord({ id: "session-1", metadata: { source: "vscode-test" } });
  runtime.subscribe("view-1");
  return { runtime, engine, broadcasts, baselines, metadataUpdates, compaction };
}

function streamData(records: readonly BroadcastRecord[]): unknown[] {
  return records.filter((record) => record.event === Events.StreamEvent).map((record) => record.data);
}

function turnStarted(engine: FakeEngineSession): void {
  engine.emitAgent({ type: "turn.started", turnId: 7, branchId: "branch-1" });
}

function turnDone(
  engine: FakeEngineSession,
  outcome: "done" | "aborted" | { readonly failure: unknown },
): void {
  engine.emitAgent({
    type: "turn.done",
    turnId: 7,
    branchId: "branch-1",
    messages: [],
    outcome:
      outcome === "done"
        ? { type: "done" }
        : outcome === "aborted"
          ? { type: "aborted" }
          : { type: "failed", failure: outcome.failure },
  });
}

describe("session runtime (adapts one v3 session for subscribed Webviews)", () => {
  it("announces the current context usage to a subscribed Webview", async () => {
    const { runtime, broadcasts } = createRuntime();

    await runtime.announceStatus("view-1");

    expect(streamData(broadcasts)).toContainEqual({
      type: "StatusUpdate",
      payload: {
        thinking_effort: "off",
        plan_mode: false,
        context_usage: 0,
      },
      _sessionId: "session-1",
    });
  });

  it("renders a host-only command without making it a forkable core turn", () => {
    const { runtime, broadcasts } = createRuntime();

    runtime.beginHostAction("/clear");
    runtime.emitHostText("The context has been cleared.");
    runtime.completeHostAction();

    expect(streamData(broadcasts)).toEqual([
      {
        type: "TurnBegin",
        payload: { user_input: "/clear", forkable: false },
        _sessionId: "session-1",
      },
      { type: "StepBegin", payload: { n: 1 }, _sessionId: "session-1" },
      {
        type: "ContentPart",
        payload: { type: "text", text: "The context has been cleared." },
        _sessionId: "session-1",
      },
      {
        type: "stream_complete",
        result: { status: "finished" },
        _sessionId: "session-1",
      },
    ]);
  });

  it("cancels a long-running host action and ignores its late completion", async () => {
    const { runtime, engine, broadcasts, compaction } = createRuntime();
    const actionId = runtime.beginHostAction("/init");

    await runtime.cancel();
    runtime.emitHostText("AGENTS.md has been generated.", actionId);
    runtime.completeHostAction("finished", actionId);

    expect(engine.main.abortCount).toBe(1);
    expect(compaction.cancel).toHaveBeenCalledOnce();
    expect(streamData(broadcasts)).toContainEqual({
      type: "stream_complete",
      result: { status: "cancelled" },
      _sessionId: "session-1",
    });
    expect(JSON.stringify(streamData(broadcasts))).not.toContain("has been generated");
  });

  it("does not let a cancelled action finish a newer host command", async () => {
    const { runtime, broadcasts } = createRuntime();
    const initAction = runtime.beginHostAction("/init");
    await runtime.cancel();
    const clearAction = runtime.beginHostAction("/clear");

    runtime.emitHostText("late init result", initAction);
    runtime.completeHostAction("finished", initAction);

    expect(runtime.isBusy).toBe(true);
    runtime.emitHostText("The context has been cleared.", clearAction);
    runtime.completeHostAction("finished", clearAction);
    expect(runtime.isBusy).toBe(false);
    expect(JSON.stringify(streamData(broadcasts))).not.toContain("late init result");
  });

  it("waits for the cancelled turn to settle before running an exclusive operation", async () => {
    const { runtime, engine } = createRuntime();
    const prompt = runtime.prompt("keep working");
    turnStarted(engine);
    let operationStarted = false;

    const operation = runtime.runExclusiveAfterCancelling(async () => {
      operationStarted = true;
      return "forked";
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(engine.main.abortCount).toBe(1);
    expect(operationStarted).toBe(false);
    expect(runtime.isBusy).toBe(true);

    turnDone(engine, "aborted");

    await expect(prompt).resolves.toEqual({ status: "cancelled" });
    await expect(operation).resolves.toBe("forked");
    expect(operationStarted).toBe(true);
    expect(runtime.isBusy).toBe(false);
  });

  it("keeps a public turn action attached to its original slash input", async () => {
    const { runtime, engine, broadcasts } = createRuntime();

    const result = runtime.runTurnAction("/skill:review carefully", async () => {
      turnStarted(engine);
      turnDone(engine, "done");
    });

    await expect(result).resolves.toEqual({ status: "finished" });
    expect(streamData(broadcasts)).toContainEqual({
      type: "TurnBegin",
      payload: { user_input: "/skill:review carefully" },
      _sessionId: "session-1",
    });
  });

  it("converts legacy media keys when a prompt crosses the engine boundary", async () => {
    const { runtime, engine } = createRuntime();
    const completion = runtime.prompt([
      { type: "text", text: "Describe these files" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AA", id: "image-1" } },
      { type: "video_url", video_url: { url: "file:///workspace/demo.mp4", id: "video-1" } },
      { type: "audio_url", audio_url: { url: "file:///workspace/demo.mp3" } },
    ]);

    turnStarted(engine);
    turnDone(engine, "done");
    await completion;

    expect(engine.main.submitted).toEqual([
      {
        message: {
          role: "user",
          content: [
            { type: "text", text: "Describe these files" },
            { type: "image_url", source: { kind: "inline", mimeType: "image/png", data: "AA" } },
            { type: "video_url", source: { kind: "url", url: "file:///workspace/demo.mp4" } },
            { type: "audio_url", source: { kind: "url", url: "file:///workspace/demo.mp3" } },
          ],
        },
        meta: expect.objectContaining({ origin: { kind: "user" }, tracked: true }),
      },
    ]);
  });

  it("broadcasts assistant text when the engine streams a text delta", () => {
    const { engine, broadcasts } = createRuntime();

    engine.emitAgent({
      type: "llm.streaming.part",
      part: { type: "text", text: "Implemented" },
    });

    expect(streamData(broadcasts)).toContainEqual({
      type: "ContentPart",
      payload: { type: "text", text: "Implemented" },
      _sessionId: "session-1",
    });
  });

  it("broadcasts model thinking when the engine streams a thinking delta", () => {
    const { engine, broadcasts } = createRuntime();

    engine.emitAgent({
      type: "llm.streaming.part",
      part: { type: "think", think: "Checking the edge case" },
    });

    expect(streamData(broadcasts)).toContainEqual({
      type: "ContentPart",
      payload: { type: "think", think: "Checking the edge case" },
      _sessionId: "session-1",
    });
  });

  it("broadcasts a legacy tool call when engine tools spawn", () => {
    const { engine, broadcasts } = createRuntime();

    engine.emitAgent({
      type: "turn.spawn_tools",
      toolCalls: [
        {
          type: "function",
          id: "tool-1",
          name: "Read",
          arguments: JSON.stringify({ path: "src/index.ts" }),
        },
      ],
    });

    expect(streamData(broadcasts)).toContainEqual({
      type: "ToolCall",
      payload: {
        type: "function",
        id: "tool-1",
        function: { name: "ReadFile", arguments: '{"path":"src/index.ts"}' },
      },
      _sessionId: "session-1",
    });
  });

  it.each([
    ["done", "finished"],
    ["aborted", "cancelled"],
  ] as const)(
    "emits one stream completion when a turn ends as %s",
    async (outcome, expectedStatus) => {
      const { runtime, engine, broadcasts } = createRuntime();
      const completion = runtime.prompt("hello");
      turnStarted(engine);

      turnDone(engine, outcome);
      turnDone(engine, outcome);

      await expect(completion).resolves.toEqual({ status: expectedStatus });
      expect(
        streamData(broadcasts).filter(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "stream_complete",
        ),
      ).toEqual([
        {
          type: "stream_complete",
          result: { status: expectedStatus },
          _sessionId: "session-1",
        },
      ]);
    },
  );

  it("emits one error when a failed turn terminal is repeated", async () => {
    const { runtime, engine, broadcasts } = createRuntime();
    const completion = runtime.prompt("hello");
    turnStarted(engine);

    turnDone(engine, { failure: { reason: "error", error: { kind: "status", message: "Provider rejected the request" } } });
    turnDone(engine, { failure: { reason: "error", error: { kind: "status", message: "Provider rejected the request" } } });

    await expect(completion).resolves.toEqual({ status: "failed" });
    expect(
      streamData(broadcasts).filter(
        (event) =>
          typeof event === "object" && event !== null && "type" in event && event.type === "error",
      ),
    ).toHaveLength(1);
  });

  it("maps an engine connection failure to the connection error code", async () => {
    const { runtime, engine, broadcasts } = createRuntime();
    const completion = runtime.prompt("hello");
    turnStarted(engine);

    turnDone(engine, {
      failure: { reason: "error", error: { kind: "connection", message: "fetch failed" } },
    });

    await expect(completion).resolves.toEqual({ status: "failed" });
    expect(streamData(broadcasts)).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "provider.connection_error",
        phase: "runtime",
        _sessionId: "session-1",
      }),
    );
  });

  it("suppresses the trailing engine error when a failed terminal already reported it", async () => {
    const { runtime, engine, broadcasts } = createRuntime();
    const completion = runtime.prompt("hello");
    turnStarted(engine);

    turnDone(engine, { failure: { reason: "error", error: { kind: "status", message: "Provider rejected the request" } } });
    engine.emitAgent({
      type: "agent.failed",
      error: { kind: "status", message: "Provider rejected the request" },
    });

    await completion;
    expect(
      streamData(broadcasts).filter(
        (event) =>
          typeof event === "object" && event !== null && "type" in event && event.type === "error",
      ),
    ).toHaveLength(1);
  });

  it("reports a preflight error when engine prompt submission throws before turn start", async () => {
    const { runtime, engine, broadcasts } = createRuntime();
    engine.main.submitError = new Error("Unable to initialize provider");

    await expect(runtime.prompt("hello")).resolves.toEqual({ status: "failed" });

    expect(streamData(broadcasts)).toContainEqual({
      type: "error",
      code: "internal",
      message: "Internal error occurred.",
      detail: "Unable to initialize provider",
      phase: "preflight",
      _sessionId: "session-1",
    });
  });

  it("requests engine cancellation when the active response is stopped", async () => {
    const { runtime, engine } = createRuntime();
    void runtime.prompt("hello");

    await runtime.cancel();

    expect(engine.main.abortCount).toBe(1);
  });

  it("still reaches the engine abort when the host lost track of active work", async () => {
    const { runtime, engine } = createRuntime();

    await runtime.cancel();

    expect(engine.main.abortCount).toBe(1);
  });

  it("converts legacy media keys when steering an active response", async () => {
    const { runtime, engine } = createRuntime();
    void runtime.prompt("hello");

    await runtime.steer([
      { type: "text", text: "Use this instead" },
      { type: "image_url", image_url: { url: "file:///workspace/new.png" } },
    ]);

    expect(engine.main.submitted.at(-1)?.message).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Use this instead" },
        { type: "image_url", source: { kind: "url", url: "file:///workspace/new.png" } },
      ],
    });
    expect(engine.main.steered).toHaveLength(1);
  });

  it("echoes a successful steer into the subscribed Webview", async () => {
    const { runtime, broadcasts } = createRuntime();
    runtime.subscribe("view-a");

    await runtime.steer("Use this instead");

    expect(streamData(broadcasts)).toContainEqual({
      type: "SteerInput",
      payload: { user_input: "Use this instead" },
      _sessionId: "session-1",
    });
  });

  it.each([
    ["approve", { decision: "approved" }],
    ["approve_for_session", { decision: "approved", scope: "session" }],
    ["reject", { decision: "rejected" }],
  ] as const)("resolves the engine approval when the Webview responds with %s", async (response, expected) => {
    const { runtime, engine, broadcasts } = createRuntime();
    const pending = engine.interactions.request({
      kind: "approval",
      payload: {
        id: "approval-1",
        sessionId: "session-1",
        agentId: "main",
        toolCallId: "tool-1",
        toolName: "Bash",
        action: "Approve Bash",
        display: { kind: "generic", summary: "Approve Bash", detail: { command: "pnpm test" } },
      },
      tags: { agentId: "main", toolCallId: "tool-1" },
    });
    await vi.waitFor(() => {
      const request = streamData(broadcasts).find(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "ApprovalRequest",
      ) as { payload: { id: string } } | undefined;
      expect(request).toBeDefined();
    });
    const request = streamData(broadcasts).find(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "ApprovalRequest",
    ) as { payload: { id: string } };

    expect(runtime.respondApproval(request.payload.id, response)).toBe(true);
    await expect(pending).resolves.toEqual(expected);
  });

  it("forwards engine approval requests to the Webview in legacy yolo mode", async () => {
    const { runtime, engine, broadcasts } = createRuntime({ yolo: true, afk: false });
    const pending = engine.interactions.request({
      kind: "approval",
      payload: {
        id: "approval-yolo",
        sessionId: "session-1",
        agentId: "main",
        toolCallId: "tool-yolo",
        toolName: "Bash",
        action: "Approve Bash",
        display: { kind: "generic", summary: "Approve Bash", detail: { command: "pnpm test" } },
      },
      tags: { agentId: "main", toolCallId: "tool-yolo" },
    });
    await vi.waitFor(() => {
      expect(
        streamData(broadcasts).some(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "ApprovalRequest",
        ),
      ).toBe(true);
    });
    const request = streamData(broadcasts).find(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "ApprovalRequest",
    ) as { payload: { id: string } };

    expect(runtime.respondApproval(request.payload.id, "approve")).toBe(true);
    await expect(pending).resolves.toEqual({ decision: "approved" });
  });

  it("restores engine permission when a legacy flag cannot be persisted", async () => {
    const { runtime, engine } = createRuntime(
      { yolo: false, afk: false },
      {
        updateMetadata: async () => {
          throw new Error("state is read-only");
        },
      },
    );

    await expect(runtime.toggleLegacyApproval("afk")).rejects.toThrow("state is read-only");

    expect(engine.permission.modes).toEqual(["auto", "manual"]);
    expect(runtime.legacyApprovalFlags).toEqual({ yolo: false, afk: false });
  });

  it("resolves an engine question when the Webview submits answers", async () => {
    const { runtime, engine, broadcasts } = createRuntime();
    const pending = engine.interactions.request({
      kind: "question",
      payload: {
        questions: [
          {
            question: "Choose a target",
            header: "Target",
            options: [{ label: "Tests", description: "Run focused tests" }],
            multi_select: false,
          },
        ],
      },
      tags: { agentId: "main", toolCallId: "question-1" },
    });
    await vi.waitFor(() => {
      expect(
        streamData(broadcasts).some(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "QuestionRequest",
        ),
      ).toBe(true);
    });
    const request = streamData(broadcasts).find(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "QuestionRequest",
    ) as { payload: { id: string; tool_call_id: string } };
    expect(request.payload.tool_call_id).toBe("question-1");

    expect(runtime.respondQuestion(request.payload.id, { "Choose a target": "Tests" })).toBe(true);
    await expect(pending).resolves.toEqual({ answers: { "Choose a target": "Tests" } });
  });

  it("keeps engine questions interactive in legacy yolo mode", async () => {
    const { runtime, engine, broadcasts } = createRuntime({ yolo: true, afk: false });
    const pending = engine.interactions.request({
      kind: "question",
      payload: {
        questions: [
          {
            question: "Continue?",
            header: "",
            options: [{ label: "Yes", description: "" }],
            multi_select: false,
          },
        ],
      },
      tags: { agentId: "main", toolCallId: "question-yolo" },
    });
    await vi.waitFor(() => {
      expect(
        streamData(broadcasts).some(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "QuestionRequest",
        ),
      ).toBe(true);
    });
    const request = streamData(broadcasts).find(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "QuestionRequest",
    ) as { payload: { id: string } };

    expect(runtime.respondQuestion(request.payload.id, { "Continue?": "Yes" })).toBe(true);
    await expect(pending).resolves.toEqual({ answers: { "Continue?": "Yes" } });
  });

  it("cancels a pending engine approval when the session closes", async () => {
    const { runtime, engine } = createRuntime();
    const pending = engine.interactions.request({
      kind: "approval",
      payload: {
        id: "approval-close",
        sessionId: "session-1",
        agentId: "main",
        toolCallId: "tool-1",
        toolName: "Bash",
        action: "Approve Bash",
        display: { kind: "generic", summary: "Approve Bash", detail: {} },
      },
      tags: { agentId: "main", toolCallId: "tool-1" },
    });

    await runtime.close();

    await expect(pending).resolves.toEqual({
      decision: "cancelled",
      feedback: "Session closed",
    });
  });

  it("cancels a pending engine question when the session closes", async () => {
    const { runtime, engine } = createRuntime();
    const pending = engine.interactions.request({
      kind: "question",
      payload: {
        questions: [
          {
            question: "Continue?",
            header: "",
            options: [{ label: "Yes", description: "" }],
            multi_select: false,
          },
        ],
      },
      tags: { agentId: "main", toolCallId: "question-close" },
    });

    await runtime.close();

    await expect(pending).resolves.toEqual({ cancelled: true, reason: "turn_ended" });
  });

  it("fans out one engine subscription to every Webview attached to the session", () => {
    const { runtime, engine, broadcasts } = createRuntime();
    runtime.subscribe("view-2");

    engine.emitAgent({
      type: "llm.streaming.part",
      part: { type: "text", text: "Shared update" },
    });

    expect(broadcasts.map((record) => record.webviewId)).toEqual(["view-1", "view-2"]);
  });

  it.each(["Write", "Edit"] as const)(
    "captures the original file when %s starts with a path",
    (name) => {
      const { engine, baselines } = createRuntime();

      engine.emitAgent({
        type: "turn.spawn_tools",
        toolCalls: [
          {
            type: "function",
            id: "tool-1",
            name,
            arguments: JSON.stringify({ path: "src/index.ts" }),
          },
        ],
      });

      expect(baselines).toEqual([
        {
          session: {
            id: "session-1",
            workDir: "/workspace",
            metadata: { source: "vscode-test" },
          },
          filePath: "src/index.ts",
          webviewIds: ["view-1"],
        },
      ]);
    },
  );

  it.each([
    ["Read", { path: "src/index.ts" }],
    ["Write", {}],
    ["Edit", { path: "" }],
  ] as const)("does not capture a baseline when %s receives non-write input %#", (name, args) => {
    const { engine, baselines } = createRuntime();

    engine.emitAgent({
      type: "turn.spawn_tools",
      toolCalls: [
        {
          type: "function",
          id: "tool-1",
          name,
          arguments: JSON.stringify(args),
        },
      ],
    });

    expect(baselines).toEqual([]);
  });
});
