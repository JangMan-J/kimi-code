import { stat } from "node:fs/promises";
import { join } from "node:path";

import { ProviderCatalogRef, UndoRef, type SessionRecord } from "@moonshot-ai/agent-core";
import {
  McpRef,
  SkillCatalogRef,
  type McpFacade,
  type SkillSummary,
} from "@moonshot-ai/harness-core";
import {
  KimiAuthFacade,
  createKimiConfigStore,
  createKimiHarness,
  createWorkspaceTrustStore,
  resolveKimiHome,
  sanitizeWorkDirKey,
  type KimiHarness,
  type KimiSession,
} from "@moonshot-ai/kimi-code-sdk";

import type { RuntimeBroadcast } from "./session-runtime";
import {
  corePermissionForLegacyApproval,
  legacyApprovalMetadata,
  readLegacyApprovalFlags,
  readMigratedLegacyApprovalFlags,
  withGlobalYoloMode,
  type LegacyApprovalFlags,
} from "./legacy-approval";
import { SessionRuntime } from "./session-runtime";
import { areSameFsPath } from "../utils/fs-path";

export interface EngineSessionSummary {
  readonly id: string;
  readonly workDir: string;
  readonly updatedAt: number;
  readonly title?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface EngineModelEntry {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly capabilities: string[];
  readonly adaptive_thinking?: boolean;
  readonly support_efforts?: string[];
  readonly default_effort?: string;
}

export interface EngineModelList {
  readonly defaultModel: string | null;
  readonly defaultThinking: boolean;
  readonly defaultThinkingEffort?: string;
  readonly thinking?: { readonly enabled?: boolean; readonly effort?: string };
  readonly models: EngineModelEntry[];
}

export interface EngineConfigPatch {
  readonly defaultModel: string;
  readonly thinking: { readonly enabled: boolean; readonly effort?: string };
}

export interface KimiRuntimeOptions {
  readonly version: string;
  readonly broadcast: RuntimeBroadcast;
  readonly captureBaseline: (
    session: { readonly id: string; readonly workDir: string; readonly metadata?: Readonly<Record<string, unknown>> },
    filePath: string,
    webviewIds: readonly string[],
  ) => void;
  readonly log: (message: string, error?: unknown) => void;
  readonly homeDir?: string;
  readonly knownWorkDirs?: () => readonly string[];
  readonly createHarness?: (workDir: string) => Promise<KimiHarness>;
}

export interface OpenSessionOptions {
  readonly webviewId: string;
  readonly workDir: string;
  readonly sessionId?: string;
  readonly model: string;
  readonly effort: string;
  readonly yoloMode: boolean;
}

export class KimiRuntime {
  readonly homeDir: string;

  private readonly version: string;
  private readonly broadcast: RuntimeBroadcast;
  private readonly captureBaseline: KimiRuntimeOptions["captureBaseline"];
  private readonly log: KimiRuntimeOptions["log"];
  private readonly knownWorkDirs: () => readonly string[];
  private readonly createHarness: (workDir: string) => Promise<KimiHarness>;
  private readonly harnesses = new Map<string, Promise<KimiHarness>>();
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly sessionByView = new Map<string, string>();
  private readonly viewChains = new Map<string, Promise<void>>();
  private authFacade: KimiAuthFacade | undefined;
  private closed = false;

  constructor(options: KimiRuntimeOptions) {
    this.version = options.version;
    this.broadcast = options.broadcast;
    this.captureBaseline = options.captureBaseline;
    this.log = options.log;
    this.homeDir = resolveKimiHome(options.homeDir);
    this.knownWorkDirs = options.knownWorkDirs ?? (() => []);
    this.createHarness =
      options.createHarness ??
      ((workDir) => {
        createWorkspaceTrustStore(this.homeDir).trust(workDir);
        return createKimiHarness({
          homeDir: this.homeDir,
          workDir,
          identity: "kimi-code-vscode",
          version: this.version,
          userAgent: `kimi-code-vscode/${this.version}`,
        });
      });
  }

  get auth(): KimiAuthFacade {
    this.authFacade ??= new KimiAuthFacade({
      homeDir: this.homeDir,
      configPath: join(this.homeDir, "config.toml"),
      identity: {
        productName: "kimi-code-vscode",
        version: this.version,
        platform: "kimi_code_vscode",
      },
    });
    return this.authFacade;
  }

  getSessionForView(webviewId: string): SessionRuntime | undefined {
    const id = this.sessionByView.get(webviewId);
    return id === undefined ? undefined : this.sessions.get(id);
  }

  getSession(id: string): SessionRuntime | undefined {
    return this.sessions.get(id);
  }

  private harnessFor(workDir: string): Promise<KimiHarness> {
    const key = normalizeWorkDirKey(workDir);
    let harness = this.harnesses.get(key);
    if (harness === undefined) {
      harness = this.createHarness(workDir);
      this.harnesses.set(key, harness);
      harness.catch(() => {
        if (this.harnesses.get(key) === harness) this.harnesses.delete(key);
      });
    }
    return harness;
  }

  private async existingHarness(workDir?: string | null): Promise<KimiHarness | undefined> {
    if (workDir !== undefined && workDir !== null) {
      return this.harnessFor(workDir);
    }
    const existing = this.harnesses.values().next().value;
    if (existing !== undefined) return existing;
    const candidate = this.knownWorkDirs()[0];
    return candidate === undefined ? undefined : this.harnessFor(candidate);
  }

  async getModels(): Promise<EngineModelList> {
    const harness = await this.existingHarness();
    if (harness === undefined) return modelsFromConfigFile(join(this.homeDir, "config.toml"));
    await harness.config.reload().catch(() => undefined);
    const catalog = harness.app.resolve(ProviderCatalogRef);
    if (catalog === undefined) return modelsFromConfigFile(join(this.homeDir, "config.toml"));
    const models: EngineModelEntry[] = [];
    for (const providerId of catalog.providers()) {
      const info = catalog.providerInfo(providerId);
      for (const model of catalog.models(providerId)) {
        models.push({
          id: `${info?.aliasScope ?? providerId}/${model.id}`,
          name: model.displayName ?? model.name,
          provider: providerId,
          capabilities: capabilityList(model.capability),
          adaptive_thinking: model.thinking?.adaptiveThinking,
          support_efforts:
            model.thinking?.supportEfforts === undefined ? undefined : [...model.thinking.supportEfforts],
          default_effort: model.thinking?.defaultEffort,
        });
      }
    }
    models.sort((left, right) => left.name.localeCompare(right.name));
    const thinking = harness.config.get<{ enabled?: boolean; effort?: string }>("thinking");
    return {
      defaultModel: harness.config.get<string>("defaultModel") ?? models[0]?.id ?? null,
      defaultThinking: thinking?.enabled !== false,
      defaultThinkingEffort: thinking?.effort,
      thinking,
      models,
    };
  }

  async setConfig(patch: EngineConfigPatch): Promise<void> {
    const writes: Array<Promise<void>> = [];
    let wroteLive = false;
    for (const pending of this.harnesses.values()) {
      const harness = await pending.catch(() => undefined);
      if (harness === undefined) continue;
      wroteLive = true;
      writes.push(
        (async () => {
          await harness.config.set("defaultModel", patch.defaultModel, "user");
          await harness.config.set("thinking", patch.thinking, "user");
        })(),
      );
    }
    if (wroteLive) {
      await Promise.all(writes);
      return;
    }
    const store = createKimiConfigStore(join(this.homeDir, "config.toml"));
    await store.replace(
      { defaultModel: patch.defaultModel, thinking: patch.thinking },
      "user",
    );
  }

  async reloadConfig(): Promise<void> {
    for (const pending of this.harnesses.values()) {
      const harness = await pending.catch(() => undefined);
      await harness?.config.reload().catch(() => undefined);
    }
  }

  async listSessions(workDir?: string | null): Promise<EngineSessionSummary[]> {
    const candidates: readonly string[] =
      workDir === undefined || workDir === null ? this.knownWorkDirs() : [workDir];
    const summaries: EngineSessionSummary[] = [];
    for (const candidate of candidates) {
      if (!(await this.hasSessionDir(candidate))) continue;
      const harness = await this.harnessFor(candidate);
      const records = await harness.listSessions();
      for (const record of records) {
        summaries.push(await this.toEngineSummary(harness, candidate, record));
      }
    }
    return summaries;
  }

  async findSession(workDir: string, id: string): Promise<EngineSessionSummary | undefined> {
    const active = this.sessions.get(id);
    if (active !== undefined) {
      return {
        id: active.id,
        workDir: active.workDir,
        updatedAt: 0,
        metadata: active.summary.metadata,
      };
    }
    const summaries = await this.listSessions(workDir);
    return summaries.find((summary) => summary.id === id);
  }

  async resumeEngineSession(workDir: string, id: string): Promise<KimiSession> {
    const harness = await this.harnessFor(workDir);
    return harness.resumeSession(id);
  }

  async forkEngineSession(
    workDir: string,
    id: string,
    turnIndex: number,
  ): Promise<EngineSessionSummary> {
    const harness = await this.harnessFor(workDir);
    const fork = await harness.forkSession(id);
    try {
      const undo = fork.main.resolve(UndoRef);
      if (undo === undefined) throw new Error("undo feature is not installed");
      const availability = undo.availability();
      const remove = availability.maxTurns - (turnIndex + 1);
      if (remove > 0) await undo.undo(remove);
    } finally {
      await fork.close().catch((error: unknown) => {
        this.log("Unable to close a forked session", error);
      });
    }
    const record = await harness.app.space.get(fork.id);
    return {
      id: fork.id,
      workDir,
      updatedAt: Date.now(),
      title: record?.title,
      metadata: record?.metadata,
    };
  }

  async deleteEngineSession(workDir: string, id: string): Promise<void> {
    await this.closeSession(id);
    const harness = await this.harnessFor(workDir);
    await harness.deleteSession(id);
  }

  async mcp(workDir?: string | null): Promise<McpFacade> {
    const harness = await this.existingHarness(workDir);
    if (harness === undefined) throw new Error("Open a folder to manage MCP servers.");
    const mcp = harness.app.resolve(McpRef);
    if (mcp === undefined) throw new Error("MCP is not available for this folder.");
    return mcp;
  }

  async listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]> {
    const harness = await this.harnessFor(workDir);
    const catalog = harness.app.resolve(SkillCatalogRef);
    if (catalog === undefined) throw new Error("Skills are not available for this folder.");
    await catalog.ready;
    return catalog.list();
  }

  async openSession(options: OpenSessionOptions): Promise<SessionRuntime> {
    return this.serializeView(options.webviewId, () => this.openSessionInner(options));
  }

  private async openSessionInner(options: OpenSessionOptions): Promise<SessionRuntime> {
    this.ensureOpen();
    const current = this.getSessionForView(options.webviewId);
    const requestedId = options.sessionId ?? current?.id;

    if (
      current !== undefined &&
      requestedId === current.id &&
      areSameFsPath(current.workDir, options.workDir)
    ) {
      await current.applyPermissionMode(
        corePermissionForLegacyApproval(current.legacyApprovalFlags),
      );
      await current.announceStatus(options.webviewId);
      return current;
    }

    let runtime = requestedId === undefined ? undefined : this.sessions.get(requestedId);
    if (runtime !== undefined) {
      assertSameWorkDir(runtime.workDir, options.workDir);
      await runtime.applyPermissionMode(
        corePermissionForLegacyApproval(runtime.legacyApprovalFlags),
      );
      await this.detachViewInner(options.webviewId);
    } else {
      const harness = await this.harnessFor(options.workDir);
      const defaultApproval: LegacyApprovalFlags = { yolo: options.yoloMode, afk: false };
      const session =
        requestedId === undefined
          ? await harness.createSession({ metadata: legacyApprovalMetadata(defaultApproval) })
          : await harness.resumeSession(requestedId);
      try {
        const record = await harness.app.space.get(session.id);
        const storedApproval = readLegacyApprovalFlags(record?.metadata);
        const restoredApproval =
          storedApproval ?? (await this.readMigratedLegacyApproval(record)) ?? defaultApproval;
        const approval = withGlobalYoloMode(restoredApproval, options.yoloMode);
        runtime = this.wrapSession(harness, options.workDir, session, approval);
        runtime.setSessionRecord(record);
        if (storedApproval === undefined || flagsDiffer(storedApproval, approval)) {
          await runtime.updateMetadataFlags(legacyApprovalMetadata(approval));
        }
        await runtime.applyPermissionMode(corePermissionForLegacyApproval(approval));
        if (requestedId === undefined) {
          if (options.model.trim().length > 0) await runtime.setModel(options.model);
          await runtime.setThinking(normalizeEffort(options.effort));
        }
        await this.detachViewInner(options.webviewId);
      } catch (error) {
        this.sessions.delete(session.id);
        await session.close().catch((closeError: unknown) => {
          this.log("Failed to close a rejected session", closeError);
        });
        throw error;
      }
    }

    runtime.subscribe(options.webviewId);
    this.sessionByView.set(options.webviewId, runtime.id);
    await runtime.announceStatus(options.webviewId);
    return runtime;
  }

  async attachResumedSession(
    webviewId: string,
    session: KimiSession,
    workDir: string,
    defaultYoloMode = false,
  ): Promise<SessionRuntime> {
    return this.serializeView(webviewId, () =>
      this.attachResumedSessionInner(webviewId, session, workDir, defaultYoloMode),
    );
  }

  private async attachResumedSessionInner(
    webviewId: string,
    session: KimiSession,
    workDir: string,
    defaultYoloMode: boolean,
  ): Promise<SessionRuntime> {
    const existing = this.sessions.get(session.id);
    if (existing !== undefined && this.sessionByView.get(webviewId) === session.id) {
      existing.subscribe(webviewId);
      await existing.announceStatus(webviewId);
      return existing;
    }
    await this.detachViewInner(webviewId);
    let runtime = existing ?? this.sessions.get(session.id);
    if (runtime === undefined) {
      const harness = await this.harnessFor(workDir);
      try {
        const record = await harness.app.space.get(session.id);
        const storedApproval = readLegacyApprovalFlags(record?.metadata);
        const restoredApproval =
          storedApproval ??
          (await this.readMigratedLegacyApproval(record)) ??
          { yolo: defaultYoloMode, afk: false };
        const approval = withGlobalYoloMode(restoredApproval, defaultYoloMode);
        runtime = this.wrapSession(harness, workDir, session, approval);
        runtime.setSessionRecord(record);
        if (storedApproval === undefined || flagsDiffer(storedApproval, approval)) {
          await runtime.updateMetadataFlags(legacyApprovalMetadata(approval));
        }
        await runtime.applyPermissionMode(corePermissionForLegacyApproval(approval));
      } catch (error) {
        this.sessions.delete(session.id);
        await session.close().catch((closeError: unknown) => {
          this.log("Failed to close a rejected session", closeError);
        });
        throw error;
      }
    }
    runtime.subscribe(webviewId);
    this.sessionByView.set(webviewId, runtime.id);
    await runtime.announceStatus(webviewId);
    return runtime;
  }

  async detachView(webviewId: string): Promise<void> {
    return this.serializeView(webviewId, () => this.detachViewInner(webviewId));
  }

  private async detachViewInner(webviewId: string): Promise<void> {
    const id = this.sessionByView.get(webviewId);
    if (id === undefined) return;
    this.sessionByView.delete(webviewId);
    const runtime = this.sessions.get(id);
    if (runtime === undefined) return;
    runtime.unsubscribeView(webviewId);
    if (runtime.subscribers.length === 0) {
      this.sessions.delete(id);
      await runtime.close();
    }
  }

  private serializeView<T>(webviewId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.viewChains.get(webviewId) ?? Promise.resolve();
    const run = prev.then(work, work);
    const next = run.then(
      () => undefined,
      () => undefined,
    );
    this.viewChains.set(webviewId, next);
    void next.finally(() => {
      if (this.viewChains.get(webviewId) === next) this.viewChains.delete(webviewId);
    });
    return run;
  }

  async closeSession(id: string): Promise<void> {
    const runtime = this.sessions.get(id);
    if (runtime === undefined) return;
    this.sessions.delete(id);
    for (const webviewId of runtime.subscribers) {
      this.sessionByView.delete(webviewId);
    }
    await runtime.close();
  }

  async setYoloModeForActiveSessions(enabled: boolean): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map((session) => session.setLegacyYoloMode(enabled)),
    );
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
    this.sessionByView.clear();
    const harnesses = [...this.harnesses.values()];
    this.harnesses.clear();
    await Promise.all(
      harnesses.map(async (pending) => {
        const harness = await pending.catch(() => undefined);
        await harness?.close();
      }),
    );
  }

  private wrapSession(
    harness: KimiHarness,
    workDir: string,
    session: KimiSession,
    legacyApproval: LegacyApprovalFlags,
  ): SessionRuntime {
    const runtime = new SessionRuntime({
      session,
      workDir,
      legacyApproval,
      broadcast: this.broadcast,
      captureBaseline: this.captureBaseline,
      updateMetadata: async (id, patch) => {
        const record = await harness.app.space.get(id);
        const metadata = { ...record?.metadata, ...patch };
        await harness.app.updateSession(id, { metadata });
        return metadata;
      },
      recreateSession: async (id, metadata) => {
        await harness.deleteSession(id);
        return harness.createSession({
          sessionId: id,
          ...(metadata === undefined ? {} : { metadata: { ...metadata } }),
        });
      },
      configDefaults: () => ({
        model: harness.config.get<string>("defaultModel"),
        thinking: harness.config.get<{ effort?: string }>("thinking")?.effort,
      }),
      log: this.log,
    });
    this.sessions.set(session.id, runtime);
    return runtime;
  }

  private async readMigratedLegacyApproval(
    record: SessionRecord | undefined,
  ): Promise<LegacyApprovalFlags | undefined> {
    try {
      return await readMigratedLegacyApprovalFlags(record?.metadata);
    } catch (error) {
      this.log("Unable to restore legacy session approval settings", error);
      return undefined;
    }
  }

  private sessionsRoot(workDir: string): string {
    return join(this.homeDir, "sessions-v3", sanitizeWorkDirKey(workDir));
  }

  private async hasSessionDir(workDir: string): Promise<boolean> {
    try {
      return (await stat(this.sessionsRoot(workDir))).isDirectory();
    } catch {
      return false;
    }
  }

  private async toEngineSummary(
    harness: KimiHarness,
    workDir: string,
    record: SessionRecord,
  ): Promise<EngineSessionSummary> {
    const mtime = await stat(join(this.sessionsRoot(workDir), record.id))
      .then((info) => info.mtimeMs)
      .catch(() => 0);
    return {
      id: record.id,
      workDir,
      updatedAt: mtime,
      title: record.title,
      metadata: record.metadata,
    };
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Kimi runtime is closed.");
  }
}

export function normalizeEffort(effort: string): string {
  const trimmed = effort.trim();
  return trimmed.length === 0 ? "off" : trimmed;
}

export function normalizeWorkDirKey(workDir: string): string {
  return workDir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function flagsDiffer(a: LegacyApprovalFlags, b: LegacyApprovalFlags): boolean {
  return a.yolo !== b.yolo || a.afk !== b.afk;
}

function assertSameWorkDir(sessionWorkDir: string, expectedWorkDir: string): void {
  if (!areSameFsPath(sessionWorkDir, expectedWorkDir)) {
    throw new Error("The selected session belongs to a different working directory.");
  }
}

function capabilityList(capability: {
  image_in?: boolean;
  video_in?: boolean;
  audio_in?: boolean;
  thinking?: boolean;
  tool_use?: boolean;
}): string[] {
  return [
    capability.image_in ? "image_in" : undefined,
    capability.video_in ? "video_in" : undefined,
    capability.audio_in ? "audio_in" : undefined,
    capability.thinking ? "thinking" : undefined,
    capability.tool_use ? "tool_use" : undefined,
  ].filter((entry): entry is string => entry !== undefined);
}

async function modelsFromConfigFile(configPath: string): Promise<EngineModelList> {
  const store = createKimiConfigStore(configPath);
  await store.reload();
  if (store.diagnostics().some((entry) => entry.severity === "error")) {
    return { defaultModel: null, defaultThinking: true, models: [] };
  }
  const modelsSection = store.get<Record<string, Record<string, unknown>>>("models") ?? {};
  const models: EngineModelEntry[] = Object.entries(modelsSection).map(([id, model]) => {
    const capability = model["capability"] as Parameters<typeof capabilityList>[0] | undefined;
    return {
      id,
      name: typeof model["displayName"] === "string" ? model["displayName"] : id,
      provider: typeof model["provider"] === "string" ? model["provider"] : "",
      capabilities: capability === undefined ? [] : capabilityList(capability),
      adaptive_thinking:
        typeof model["adaptiveThinking"] === "boolean" ? model["adaptiveThinking"] : undefined,
      support_efforts: Array.isArray(model["supportEfforts"])
        ? (model["supportEfforts"] as unknown[]).filter((item): item is string => typeof item === "string")
        : undefined,
      default_effort:
        typeof model["defaultEffort"] === "string" ? model["defaultEffort"] : undefined,
    };
  });
  const thinking = store.get<{ enabled?: boolean; effort?: string } | undefined>("thinking");
  return {
    defaultModel: store.get<string | undefined>("defaultModel") ?? models[0]?.id ?? null,
    defaultThinking: thinking?.enabled !== false,
    defaultThinkingEffort: thinking?.effort,
    thinking,
    models,
  };
}
