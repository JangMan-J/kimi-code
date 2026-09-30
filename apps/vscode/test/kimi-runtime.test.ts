/**
 * Scenario: the VS Code host owns per-workDir Kimi harnesses and routes Webviews to shared sessions.
 * Responsibilities: create/resume/switch, per-session settings, multi-view ownership, detach, and disposal.
 * Wiring: KimiRuntime and SessionRuntime are real; fake per-workDir harnesses form the engine boundary.
 * Run: pnpm exec vitest run --config apps/vscode/vitest.config.ts test/kimi-runtime.test.ts
 */

import { describe, expect, it, vi } from "vitest";

import { Events } from "../shared/bridge";
import { KimiRuntime, type OpenSessionOptions } from "../src/runtime/kimi-runtime";
import {
  createFakeEngineSession,
  type FakeEngineSession,
} from "./fake-engine-session";

interface FakeHarnessSession {
  readonly engine: FakeEngineSession;
  metadata: Record<string, unknown> | undefined;
}

interface FakeHarness {
  readonly workDir: string;
  readonly sessions: Map<string, FakeHarnessSession>;
  readonly createInputs: Array<{ readonly metadata?: Record<string, unknown> }>;
  readonly resumeInputs: string[];
  readonly deleteSessionIds: string[];
  readonly closeCount: () => number;
  addSession(id: string, metadata?: Record<string, unknown>): FakeHarnessSession;
  harness: unknown;
}

function createFakeHarness(workDir: string): FakeHarness {
  const sessions = new Map<string, FakeHarnessSession>();
  const createInputs: Array<{ readonly metadata?: Record<string, unknown> }> = [];
  const resumeInputs: string[] = [];
  const deleteSessionIds: string[] = [];
  let creates = 0;
  let closes = 0;

  const addSession = (id: string, metadata?: Record<string, unknown>): FakeHarnessSession => {
    const entry: FakeHarnessSession = { engine: createFakeEngineSession(id), metadata };
    sessions.set(id, entry);
    return entry;
  };

  const harness = {
    workDir,
    homeDir: "/tmp/kimi-runtime-home",
    async createSession(input?: { sessionId?: string; metadata?: Record<string, unknown> }) {
      creates += 1;
      createInputs.push({ metadata: input?.metadata });
      return addSession(input?.sessionId ?? `created-${creates}`, input?.metadata).engine.session;
    },
    async resumeSession(id: string) {
      resumeInputs.push(id);
      const entry = sessions.get(id);
      if (entry === undefined) throw new Error(`Unknown session: ${id}`);
      return entry.engine.session;
    },
    async forkSession(id: string) {
      const entry = sessions.get(id);
      if (entry === undefined) throw new Error(`Unknown session: ${id}`);
      const fork = addSession(`${id}-fork`, entry.metadata);
      return fork.engine.session;
    },
    async listSessions() {
      return [...sessions.entries()].map(([id, entry]) => ({
        id,
        metadata: entry.metadata,
      }));
    },
    async deleteSession(id: string) {
      deleteSessionIds.push(id);
      sessions.delete(id);
    },
    async close() {
      closes += 1;
    },
    app: {
      space: {
        get: async (id: string) => {
          const entry = sessions.get(id);
          if (entry === undefined) return undefined;
          return { id, metadata: entry.metadata };
        },
      },
      updateSession: async (id: string, patch: { metadata?: Record<string, unknown> }) => {
        const entry = sessions.get(id);
        if (entry === undefined) throw new Error(`Unknown session: ${id}`);
        entry.metadata = patch.metadata;
        return { id, metadata: entry.metadata };
      },
    },
    config: {
      get: () => undefined,
      set: vi.fn(async () => undefined),
      reload: vi.fn(async () => undefined),
    },
  };

  return {
    workDir,
    sessions,
    createInputs,
    resumeInputs,
    deleteSessionIds,
    closeCount: () => closes,
    addSession,
    harness,
  };
}

function openOptions(overrides: Partial<OpenSessionOptions> = {}): OpenSessionOptions {
  return {
    webviewId: "view-1",
    workDir: "/workspace",
    model: "kimi-test",
    effort: "off",
    yoloMode: false,
    ...overrides,
  };
}

function createRuntime() {
  const harnesses = new Map<string, FakeHarness>();
  const workDirs: string[] = [];
  const factory = async (workDir: string): Promise<never> => {
    let fake = harnesses.get(workDir);
    if (fake === undefined) {
      fake = createFakeHarness(workDir);
      harnesses.set(workDir, fake);
      workDirs.push(workDir);
    }
    return fake.harness as never;
  };
  const runtime = new KimiRuntime({
    version: "0.6.0",
    broadcast: () => undefined,
    captureBaseline: () => undefined,
    log: () => undefined,
    createHarness: factory,
  });
  const harnessFor = (workDir: string): FakeHarness => {
    const fake = harnesses.get(workDir);
    if (fake === undefined) throw new Error(`No fake harness for ${workDir}`);
    return fake;
  };
  const seed = async (workDir: string): Promise<FakeHarness> => {
    await factory(workDir);
    return harnesses.get(workDir)!;
  };
  return { runtime, harnesses, harnessFor, seed, workDirs };
}

function createRecordingRuntime() {
  const broadcasts: Array<{ event: string; data: unknown; webviewId?: string }> = [];
  const harnesses = new Map<string, FakeHarness>();
  const factory = async (workDir: string): Promise<never> => {
    let fake = harnesses.get(workDir);
    if (fake === undefined) {
      fake = createFakeHarness(workDir);
      harnesses.set(workDir, fake);
    }
    return fake.harness as never;
  };
  const runtime = new KimiRuntime({
    version: "test",
    broadcast: (event, data, webviewId) => {
      broadcasts.push({ event, data, webviewId });
    },
    captureBaseline: () => undefined,
    log: () => undefined,
    createHarness: factory,
  });
  const seed = async (workDir: string): Promise<FakeHarness> => {
    await factory(workDir);
    return harnesses.get(workDir)!;
  };
  return { runtime, broadcasts, seed };
}

describe("Kimi runtime (owns per-workDir harnesses for Webviews)", () => {
  it("creates the harness lazily for the session's workDir", async () => {
    const { runtime, workDirs } = createRuntime();

    expect(workDirs).toEqual([]);
    await runtime.openSession(openOptions());

    expect(workDirs).toEqual(["/workspace"]);
    await runtime.dispose();
  });

  it("forwards the requested settings when creating a session", async () => {
    const { runtime, harnessFor } = createRuntime();

    const opened = await runtime.openSession(
      openOptions({ model: "kimi-k2", effort: "high", yoloMode: true }),
    );

    const harness = harnessFor("/workspace");
    expect(harness.createInputs).toEqual([
      { metadata: { vscode_legacy_approval: { yolo: true, afk: false } } },
    ]);
    const entry = harness.sessions.get(opened.id)!;
    expect(entry.engine.model.setModels).toEqual(["kimi-k2"]);
    expect(entry.engine.model.setThinkingEfforts).toEqual(["high"]);
    expect(entry.engine.permission.modes).toEqual(["yolo"]);
    expect(opened.subscribers).toEqual(["view-1"]);
  });

  it("serves slash and case variants of one Windows workDir through one harness", async () => {
    const { runtime, harnessFor } = createRuntime();

    await runtime.openSession(openOptions({ workDir: "C:\\Users\\Example User\\项目" }));
    await runtime.openSession(openOptions({
      webviewId: "view-2",
      workDir: "c:/users/example user/项目",
    }));

    const harness = harnessFor("C:\\Users\\Example User\\项目");
    expect(harness.createInputs).toHaveLength(2);
    await runtime.dispose();
  });

  it("uses off thinking when a new session receives an empty effort", async () => {
    const { runtime, harnessFor } = createRuntime();

    const opened = await runtime.openSession(openOptions({ effort: "   " }));

    const entry = harnessFor("/workspace").sessions.get(opened.id)!;
    expect(entry.engine.model.setThinkingEfforts).toEqual(["off"]);
  });

  it("resumes the requested session instead of creating a replacement", async () => {
    const { runtime, harnessFor } = createRuntime();
    const seeded = (await runtime.openSession(openOptions())).id;
    await runtime.detachView("view-1");

    const opened = await runtime.openSession(openOptions({ sessionId: seeded }));

    expect(opened.id).toBe(seeded);
    expect(harnessFor("/workspace").resumeInputs).toEqual([seeded]);
    expect(harnessFor("/workspace").createInputs).toHaveLength(1);
  });

  it("switches a Webview to the requested session", async () => {
    const { runtime, seed } = createRuntime();
    const harness = await seed("/workspace");
    await runtime.openSession(openOptions());
    harness.addSession("saved-2");

    const selected = await runtime.openSession(openOptions({ sessionId: "saved-2" }));

    expect(runtime.getSessionForView("view-1")?.id).toBe("saved-2");
    expect(selected.id).toBe("saved-2");
  });

  it("closes an unshared old session when its Webview switches away", async () => {
    const { runtime, seed } = createRuntime();
    const harness = await seed("/workspace");
    const old = await runtime.openSession(openOptions());
    const oldEntry = harness.sessions.get(old.id)!;
    harness.addSession("saved-2");

    await runtime.openSession(openOptions({ sessionId: "saved-2" }));

    expect(oldEntry.engine.closeCount()).toBe(1);
  });

  it("shares one engine subscription when two Webviews attach to the same session", async () => {
    const { runtime, harnessFor } = createRuntime();
    const first = await runtime.openSession(openOptions({ webviewId: "view-1" }));
    const entry = harnessFor("/workspace").sessions.get(first.id)!;

    const second = await runtime.openSession(
      openOptions({ webviewId: "view-2", sessionId: first.id }),
    );

    expect(second).toBe(first);
    expect(first.subscribers).toEqual(["view-1", "view-2"]);
    expect(entry.engine.main.listenerCount("turn.started")).toBe(1);
  });

  it("does not double-wrap the session when two opens race for it", async () => {
    const { runtime, seed } = createRecordingRuntime();
    const harness = await seed("/workspace");

    const [first, second] = await Promise.all([
      runtime.openSession(openOptions()),
      runtime.openSession(openOptions()),
    ]);

    expect(second).toBe(first);
    expect(harness.createInputs).toHaveLength(1);
    expect(first.subscribers).toEqual(["view-1"]);
  });

  it("does not double-wrap the session when two attaches race for it", async () => {
    const { runtime, broadcasts, seed } = createRecordingRuntime();
    const entry = (await seed("/workspace")).addSession("saved-1");

    const [first, second] = await Promise.all([
      runtime.attachResumedSession("view-1", entry.engine.session, "/workspace"),
      runtime.attachResumedSession("view-1", entry.engine.session, "/workspace"),
    ]);

    expect(second).toBe(first);
    expect(entry.engine.main.listenerCount("turn.started")).toBe(1);

    entry.engine.emitAgent({ type: "llm.streaming.part", part: { type: "text", text: "Hello" } });

    const parts = broadcasts.filter(
      ({ data }) => (data as { type?: string }).type === "ContentPart",
    );
    expect(parts).toHaveLength(1);
  });

  it("preserves the resumed session's model and thinking instead of reapplying defaults", async () => {
    const { runtime, seed } = createRuntime();
    const entry = (await seed("/workspace")).addSession("saved-1");
    entry.engine.model.current.value = { alias: "old-model", thinking: "max" };

    const opened = await runtime.openSession(
      openOptions({ sessionId: "saved-1", model: "new-model", effort: "medium" }),
    );

    expect(entry.engine.model.setModels).toEqual([]);
    expect(entry.engine.model.setThinkingEfforts).toEqual([]);
    expect(opened.getStatus()).toMatchObject({ model: "old-model", thinkingEffort: "max" });
  });

  it("announces the session's actual status to the attaching view so the display matches it", async () => {
    const { runtime, broadcasts, seed } = createRecordingRuntime();
    const entry = (await seed("/workspace")).addSession("saved-1");
    entry.engine.model.current.value = { alias: "kimi-test", thinking: "max" };
    entry.engine.plan.state.value = { active: true };

    await runtime.openSession(openOptions({ sessionId: "saved-1", effort: "medium" }));

    expect(broadcasts).toContainEqual({
      event: Events.StreamEvent,
      data: {
        type: "StatusUpdate",
        payload: {
          model: "kimi-test",
          thinking_effort: "max",
          plan_mode: true,
          context_usage: 0,
        },
        _sessionId: "saved-1",
      },
      webviewId: "view-1",
    });
  });

  it("uses the yolo setting as the initial value for an unmarked resumed session", async () => {
    const { runtime, harnessFor, seed } = createRuntime();
    (await seed("/workspace")).addSession("saved-1");

    await runtime.openSession(openOptions({ sessionId: "saved-1", yoloMode: true }));

    expect(harnessFor("/workspace").sessions.get("saved-1")?.metadata).toEqual({
      vscode_legacy_approval: { yolo: true, afk: false },
    });
  });

  it("lets the global yolo setting override a persisted off flag on resume", async () => {
    const { runtime, seed } = createRuntime();
    const entry = (await seed("/workspace")).addSession("saved-1", {
      vscode_legacy_approval: { yolo: false, afk: false },
    });

    const opened = await runtime.openSession(openOptions({ sessionId: "saved-1", yoloMode: true }));

    expect(entry.engine.permission.modes).toEqual(["yolo"]);
    expect(entry.metadata).toEqual({ vscode_legacy_approval: { yolo: true, afk: false } });
    expect(opened.legacyApprovalFlags).toEqual({ yolo: true, afk: false });
  });

  it("lets the global yolo setting disable a persisted session yolo flag on resume", async () => {
    const { runtime, seed } = createRuntime();
    const entry = (await seed("/workspace")).addSession("saved-1", {
      vscode_legacy_approval: { yolo: true, afk: false },
    });
    entry.engine.permission.state.value = { mode: "yolo" };

    const opened = await runtime.openSession(openOptions({ sessionId: "saved-1", yoloMode: false }));

    expect(entry.engine.permission.modes).toEqual(["manual"]);
    expect(entry.metadata).toEqual({ vscode_legacy_approval: { yolo: false, afk: false } });
    expect(opened.legacyApprovalFlags).toEqual({ yolo: false, afk: false });
  });

  it("keeps the persisted afk flag while applying the global yolo setting on resume", async () => {
    const { runtime, seed } = createRuntime();
    const entry = (await seed("/workspace")).addSession("saved-1", {
      vscode_legacy_approval: { yolo: false, afk: true },
    });

    const opened = await runtime.openSession(openOptions({ sessionId: "saved-1", yoloMode: true }));

    expect(entry.engine.permission.modes).toEqual(["auto"]);
    expect(opened.legacyApprovalFlags).toEqual({ yolo: true, afk: true });
  });

  it("changes the setting-backed yolo flag without clearing session afk", async () => {
    const { runtime, harnessFor } = createRuntime();
    const opened = await runtime.openSession(openOptions());
    await opened.toggleLegacyApproval("afk");

    await runtime.setYoloModeForActiveSessions(true);

    expect(opened.legacyApprovalFlags).toEqual({ yolo: true, afk: true });
    const entry = harnessFor("/workspace").sessions.get(opened.id)!;
    expect(entry.engine.permission.state.value.mode).toBe("auto");
  });

  it("keeps a shared session open when one of its Webviews detaches", async () => {
    const { runtime, harnessFor } = createRuntime();
    const opened = await runtime.openSession(openOptions({ webviewId: "view-1" }));
    await runtime.openSession(openOptions({ webviewId: "view-2", sessionId: opened.id }));
    const entry = harnessFor("/workspace").sessions.get(opened.id)!;

    await runtime.detachView("view-1");

    expect(entry.engine.closeCount()).toBe(0);
    expect(runtime.getSessionForView("view-2")?.id).toBe(opened.id);
  });

  it("closes an engine session when its last Webview detaches", async () => {
    const { runtime, harnessFor } = createRuntime();
    const opened = await runtime.openSession(openOptions());
    const entry = harnessFor("/workspace").sessions.get(opened.id)!;

    await runtime.detachView("view-1");

    expect(entry.engine.closeCount()).toBe(1);
    expect(runtime.getSession(opened.id)).toBeUndefined();
  });

  it("reattaches the same resumed session without replacing its subscriptions", async () => {
    const { runtime, seed } = createRuntime();
    const entry = (await seed("/workspace")).addSession("saved-1");
    const first = await runtime.attachResumedSession(
      "view-1",
      entry.engine.session,
      "/workspace",
    );

    const second = await runtime.attachResumedSession(
      "view-1",
      entry.engine.session,
      "/workspace",
    );

    expect(second).toBe(first);
    expect(entry.engine.main.listenerCount("turn.started")).toBe(1);
    expect(entry.engine.closeCount()).toBe(0);
  });

  it("removes every Webview mapping when a shared session is closed", async () => {
    const { runtime } = createRuntime();
    const opened = await runtime.openSession(openOptions({ webviewId: "view-1" }));
    await runtime.openSession(openOptions({ webviewId: "view-2", sessionId: opened.id }));

    await runtime.closeSession(opened.id);

    expect(runtime.getSessionForView("view-1")).toBeUndefined();
    expect(runtime.getSessionForView("view-2")).toBeUndefined();
  });

  it("delegates deletion after the active session has been closed", async () => {
    const { runtime, harnessFor } = createRuntime();
    const opened = await runtime.openSession(openOptions());
    const entry = harnessFor("/workspace").sessions.get(opened.id)!;

    await runtime.deleteEngineSession("/workspace", opened.id);

    expect(entry.engine.closeCount()).toBe(1);
    expect(harnessFor("/workspace").deleteSessionIds).toEqual([opened.id]);
  });

  it("closes every active session and harness when the host runtime is disposed", async () => {
    const { runtime, harnessFor, seed } = createRuntime();
    const first = await runtime.openSession(openOptions({ webviewId: "view-1" }));
    const secondEntry = (await seed("/workspace")).addSession("saved-2");
    await runtime.openSession(openOptions({ webviewId: "view-2", sessionId: "saved-2" }));

    await runtime.dispose();

    expect(harnessFor("/workspace").sessions.get(first.id)?.engine.closeCount()).toBe(1);
    expect(secondEntry.engine.closeCount()).toBe(1);
    expect(harnessFor("/workspace").closeCount()).toBe(1);
  });

  it("rejects a foreign active session without closing it", async () => {
    const { runtime } = createRuntime();
    const foreign = await runtime.openSession(openOptions({ webviewId: "view-9", workDir: "/other" }));

    await expect(
      runtime.openSession(openOptions({ sessionId: foreign.id })),
    ).rejects.toThrow("The selected session belongs to a different working directory.");

    expect(runtime.getSession(foreign.id)).toBeDefined();
    expect(foreign.isBusy).toBe(false);
    await runtime.detachView("view-9");
    expect(runtime.getSession(foreign.id)).toBeUndefined();
  });

  it("fails a reentrant prompt without disturbing the running turn", async () => {
    const { runtime, broadcasts, seed } = createRecordingRuntime();
    const harness = await seed("/workspace");
    const opened = await runtime.openSession(openOptions());
    const entry = harness.sessions.get(opened.id)!;

    const first = opened.prompt("first message");
    entry.engine.emitAgent({ type: "turn.started", turnId: 1, branchId: "b" });
    expect(opened.isBusy).toBe(true);

    await expect(opened.prompt("concurrent message")).resolves.toEqual({ status: "failed" });

    expect(opened.isBusy).toBe(true);
    const busyWarning = broadcasts.find(({ data }) => (data as { type?: string }).type === "error");
    expect(busyWarning?.data).toMatchObject({
      type: "error",
      phase: "runtime",
      detail: "A response is already being generated for this session.",
      terminal: false,
    });

    entry.engine.emitAgent({
      type: "turn.done",
      turnId: 1,
      branchId: "b",
      messages: [],
      outcome: { type: "done" },
    });
    await expect(first).resolves.toEqual({ status: "finished" });
    expect(opened.isBusy).toBe(false);
  });

  it("rejects a prompt during an exclusive operation with a terminal error", async () => {
    const { runtime, broadcasts } = createRecordingRuntime();
    const opened = await runtime.openSession(openOptions());

    let releaseExclusive!: () => void;
    const exclusive = opened.runExclusiveAfterCancelling(
      () => new Promise<void>((resolve) => {
        releaseExclusive = resolve;
      }),
    );
    expect(opened.isBusy).toBe(true);

    await expect(opened.prompt("during fork")).resolves.toEqual({ status: "failed" });
    const rejection = broadcasts.find(({ data }) => (data as { type?: string }).type === "error");
    expect(rejection?.data).toMatchObject({ type: "error", phase: "runtime" });
    expect((rejection?.data as Record<string, unknown>)["terminal"]).toBeUndefined();

    releaseExclusive();
    await exclusive;
    expect(opened.isBusy).toBe(false);
  });

  it("marks a mid-turn engine error as non-terminal until the turn ends", async () => {
    const { runtime, broadcasts, seed } = createRecordingRuntime();
    const harness = await seed("/workspace");
    const opened = await runtime.openSession(openOptions());
    const entry = harness.sessions.get(opened.id)!;

    const first = opened.prompt("first message");
    entry.engine.emitAgent({ type: "turn.started", turnId: 1, branchId: "b" });

    entry.engine.emitAgent({
      type: "agent.failed",
      error: { kind: "unknown", message: "records write failed: EACCES" },
    });

    expect(opened.isBusy).toBe(true);
    const warning = broadcasts.find(({ data }) => (data as { type?: string }).type === "error");
    expect(warning?.data).toMatchObject({
      type: "error",
      code: "internal",
      phase: "runtime",
      terminal: false,
    });

    entry.engine.emitAgent({
      type: "turn.done",
      turnId: 1,
      branchId: "b",
      messages: [],
      outcome: { type: "done" },
    });
    await expect(first).resolves.toEqual({ status: "finished" });
    expect(opened.isBusy).toBe(false);
  });

  it("keeps preflight failures terminal", async () => {
    const { runtime, broadcasts, seed } = createRecordingRuntime();
    const harness = await seed("/workspace");
    const opened = await runtime.openSession(openOptions());
    const entry = harness.sessions.get(opened.id)!;
    entry.engine.main.submitError = new Error("provider down");

    await expect(opened.prompt("hi")).resolves.toEqual({ status: "failed" });
    const failure = broadcasts.find(({ data }) => (data as { type?: string }).type === "error");
    expect(failure?.data).toMatchObject({ type: "error", phase: "preflight" });
    expect((failure?.data as Record<string, unknown>)["terminal"]).toBeUndefined();
    expect(opened.isBusy).toBe(false);
  });
});
