import { join } from 'node:path';

import {
  ConfigRef,
  DEFAULT_MODEL_CONFIG_SECTION,
  MAIN_AGENT_ID,
  ProviderCatalogRef,
  createConfig,
  createMemoryRefStore,
  createMemoryUploadCache,
  createOAuthCredentialProvider,
  createStaticCredentialProvider,
  CatalogModels,
  matchCatalogBinding,
  createHarness,
  type AppHandle,
  type CatalogModelBinding,
  type ConfigDiagnostic,
  type ConfigTarget,
  type FeatureSpec,
  type LlmCredentialProvider,
  type OpenSessionInput,
  type SessionRecord,
} from '@moonshot-ai/agent-core';
import {
  OAuthTokensRef,
  SessionExportRef,
  createAgentsMdReminder,
  createCompaction,
  createEdit,
  createExternalHooks,
  createKimi,
  createMcp,
  createMedia,
  createModelsDev,
  createNodeOsHost,
  createOs,
  createPermission,
  createProfiles,
  createSessionExport,
  createSessionInit,
  createShellCommand,
  createSkill,
  createSpawn,
  createSummarize,
  createToolSelect,
  features as presetFeatures,
  fsSessionSpace,
  isToolSelectEnabled,
  type ExportSessionInput,
  type ExportSessionResult,
  type Summarize,
} from '@moonshot-ai/harness-core';
import { createPlugin } from '@moonshot-ai/harness-core/features/plugin/index';
import {
  KIMI_CODE_PLATFORM,
  type KimiHostIdentity,
  type OAuthRefreshOutcome,
} from '@moonshot-ai/kimi-code-oauth';

import { KimiAuthFacade } from '#/auth';
import { createKimiAuthConfigAccessor, ensureConfigFile } from '#/config-accessor';
import { createTomlConfigPersist } from '#/config-persist';
import { ErrorCodes, KimiError } from '#/errors';
import { resolveGlobalLogPath } from '#/logging/index';
import { resolveKimiHome, sanitizeWorkDirKey } from '#/paths';
import { KimiSession } from '#/session';
import {
  noopTelemetryClient,
  type TelemetryClient,
  type TelemetryContextPatch,
  type TelemetryProperties,
} from '#/telemetry';
import { createWorkspaceTrustStore, type WorkspaceTrustStore } from '#/trust';

export interface KimiHarnessOptions {
  readonly identity?: string;
  readonly uiMode?: 'interactive' | 'print';
  readonly workDir: string;
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly version?: string;
  readonly userAgent?: string;
  readonly skillDirs?: readonly string[];
  readonly additionalDirs?: readonly string[];
  readonly telemetry?: TelemetryClient;
  readonly onOAuthRefresh?: (outcome: OAuthRefreshOutcome) => void;
}

export interface KimiConfigFacade {
  get<T = unknown>(name: string): T;
  set(name: string, value: unknown, target?: ConfigTarget): Promise<void>;
  replace(sections: Readonly<Record<string, unknown>>, target?: ConfigTarget): Promise<void>;
  reload(): Promise<void>;
  diagnostics(): readonly ConfigDiagnostic[];
}

export class KimiHarness {
  readonly homeDir: string;
  readonly workDir: string;
  readonly configPath: string;
  readonly app: AppHandle;
  readonly auth: KimiAuthFacade;
  readonly trust: WorkspaceTrustStore;
  readonly config: KimiConfigFacade;

  private readonly telemetry: TelemetryClient;
  private readonly activeSessions = new Map<string, KimiSession>();

  constructor(props: {
    readonly homeDir: string;
    readonly workDir: string;
    readonly configPath: string;
    readonly app: AppHandle;
    readonly auth: KimiAuthFacade;
    readonly trust: WorkspaceTrustStore;
    readonly telemetry: TelemetryClient;
  }) {
    this.homeDir = props.homeDir;
    this.workDir = props.workDir;
    this.configPath = props.configPath;
    this.app = props.app;
    this.auth = props.auth;
    this.trust = props.trust;
    this.telemetry = props.telemetry;
    const store = props.app.resolve(ConfigRef);
    if (store === undefined) throw new Error('config feature is not installed');
    this.config = {
      get: (name) => store.get(name),
      set: (name, value, target = 'user') => store.set(name, value, target),
      replace: (sections, target = 'user') => store.replace(sections, target),
      reload: () => store.reload(),
      diagnostics: () => store.diagnostics(),
    };
  }

  get sessions(): ReadonlyMap<string, KimiSession> {
    return this.activeSessions;
  }

  track(event: string, properties?: TelemetryProperties): void {
    this.telemetry.track(event, properties);
  }

  setTelemetryContext(patch: TelemetryContextPatch): void {
    this.telemetry.setContext?.(patch);
  }

  async createSession(input: OpenSessionInput = {}): Promise<KimiSession> {
    return this.openSession(input);
  }

  async resumeSession(id: string): Promise<KimiSession> {
    return this.openSession({ sessionId: id });
  }

  async forkSession(fromId: string): Promise<KimiSession> {
    return this.openSession({ from: fromId });
  }

  private async openSession(input: OpenSessionInput): Promise<KimiSession> {
    if (input.sessionId !== undefined && input.from === undefined) {
      const active = this.activeSessions.get(input.sessionId);
      if (active !== undefined) return active;
    }
    const handle = await this.app.open(input);
    const known = this.activeSessions.get(handle.sessionId);
    if (known !== undefined) return known;
    const main = handle.get(MAIN_AGENT_ID) ?? (await handle.create({ agentId: MAIN_AGENT_ID }));
    const session = new KimiSession(handle.sessionId, handle, main, async (id) => {
      this.activeSessions.delete(id);
      await this.app.close(id);
    });
    this.activeSessions.set(session.id, session);
    return session;
  }

  async listSessions(): Promise<readonly SessionRecord[]> {
    return this.app.space.list();
  }

  async deleteSession(id: string): Promise<void> {
    this.activeSessions.delete(id);
    await this.app.delete(id);
  }

  async renameSession(id: string, title: string): Promise<void> {
    if (title.trim().length === 0) {
      throw new KimiError(ErrorCodes.SESSION_TITLE_EMPTY, 'Session title is empty.');
    }
    await this.app.updateSession(id, { title });
  }

  async exportSession(
    id: string,
    opts: Omit<ExportSessionInput, 'sessionId'> = {},
  ): Promise<ExportSessionResult> {
    const sessionExport = this.app.resolve(SessionExportRef);
    if (sessionExport === undefined) throw new Error('sessionExport feature is not installed');
    return sessionExport.export({ ...opts, sessionId: id });
  }

  async ensureConfigFile(): Promise<void> {
    await ensureConfigFile(this.configPath);
  }

  async close(): Promise<void> {
    this.activeSessions.clear();
    await this.app.disposeAsync();
  }
}

export async function createKimiHarness(options: KimiHarnessOptions): Promise<KimiHarness> {
  const homeDir = resolveKimiHome(options.homeDir);
  const configPath = options.configPath ?? join(homeDir, 'config.toml');
  const workDir = options.workDir;
  const sessionsRoot = join(homeDir, 'sessions-v3', sanitizeWorkDirKey(workDir));
  const host = createNodeOsHost();
  await host.environment.ready;
  const trust = createWorkspaceTrustStore(homeDir);
  const mediaStore = createMemoryRefStore();
  let app: AppHandle;
  const features: FeatureSpec[] = [
    ...presetFeatures.map((spec) => {
      if (spec.featureName === 'kimi') return createKimi({ oauth: { home: homeDir } });
      if (spec.featureName === 'permission') {
        return createPermission({ interactive: options.uiMode !== 'print', fs: host.fs });
      }
      return spec;
    }),
    createConfig({ persist: createTomlConfigPersist(configPath), env: process.env }),
    createProfiles({ workDir, host, home: homeDir }),
    createSpawn(),
    createEdit({ workDir, host }),
    createShellCommand({ workDir, host }),
    createOs({ workDir, host, additionalDirs: options.additionalDirs }),
    createAgentsMdReminder({ workDir, host, brandHome: homeDir }),
    createSkill({ workDir, fs: host.fs, home: homeDir, explicitDirs: options.skillDirs }),
    createSessionInit({ workDir, host, brandHome: homeDir }),
    createExternalHooks({ workDir, host }),
    createSessionExport({
      version: options.version ?? '0.0.0',
      sessionDir: (sessionId) => join(sessionsRoot, sessionId),
      globalLogPath: resolveGlobalLogPath(homeDir),
    }),
    createModelsDev({ userAgent: options.userAgent }),
    createMedia({
      workDir,
      store: mediaStore,
      cache: createMemoryUploadCache(),
      host,
    }),
    createMcp({ workDir, home: homeDir, host, mediaStore, trusted: trust.isTrusted(workDir) }),
    createToolSelect({
      loadable: () => [],
      enabled: () => {
        const binding = resolveDefaultBinding(app);
        return binding !== undefined && isToolSelectEnabled(binding.model.capability ?? {});
      },
    }),
    createCompaction({
      summarize: createCatalogSummarize(() => app),
      budget: {
        maxContextTokens: () => resolveDefaultBinding(app)?.model.maxContextSize ?? 262_144,
        triggerRatio: 0.85,
      },
    }),
    createPlugin({ homeDir, host }),
  ];
  app = createHarness({ space: fsSessionSpace(sessionsRoot), features });
  await app.ready();
  const identity: KimiHostIdentity | undefined =
    options.identity === undefined
      ? undefined
      : {
          productName: options.identity,
          version: options.version ?? '0.0.0',
          platform: KIMI_CODE_PLATFORM,
        };
  const configStore = app.resolve(ConfigRef);
  if (configStore === undefined) throw new Error('config feature is not installed');
  return new KimiHarness({
    homeDir,
    workDir,
    configPath,
    app,
    auth: new KimiAuthFacade({
      homeDir,
      configPath,
      config: createKimiAuthConfigAccessor(configStore, configPath),
      identity,
      onRefresh: options.onOAuthRefresh,
    }),
    trust,
    telemetry: options.telemetry ?? noopTelemetryClient,
  });
}

function resolveDefaultBinding(app: AppHandle): CatalogModelBinding | undefined {
  const config = app.resolve(ConfigRef);
  if (config === undefined) return undefined;
  const alias = config.get<string>(DEFAULT_MODEL_CONFIG_SECTION);
  if (typeof alias !== 'string' || alias.length === 0) return undefined;
  return matchCatalogBinding(alias, app.node.fold(CatalogModels));
}

function resolveSummarizeCredential(
  app: AppHandle,
  binding: CatalogModelBinding,
): LlmCredentialProvider | undefined {
  const config = app.resolve(ConfigRef);
  const catalog = app.resolve(ProviderCatalogRef);
  if (config === undefined || catalog === undefined) return undefined;
  const info = catalog.providerInfo(binding.providerId);
  if (info === undefined) return undefined;
  const envKey = info.env?.['apiKey'];
  const apiKey = info.apiKey ?? (envKey === undefined ? undefined : config.env(envKey));
  if (apiKey !== undefined && apiKey.length > 0) {
    return createStaticCredentialProvider(apiKey);
  }
  const ref = info.oauth;
  if (ref === undefined) return undefined;
  const tokens = app.resolve(OAuthTokensRef);
  if (tokens === undefined) return undefined;
  return createOAuthCredentialProvider(async (tokenOptions) => {
    const token = tokens.resolve(ref);
    if (token === undefined) return undefined;
    try {
      return await token.getAccessToken({ force: tokenOptions?.force });
    } catch {
      return undefined;
    }
  });
}

function createCatalogSummarize(getApp: () => AppHandle): Summarize {
  let cachedAlias: string | undefined;
  let cached: Summarize | undefined;
  return async (input) => {
    const app = getApp();
    const binding = resolveDefaultBinding(app);
    const alias = app.resolve(ConfigRef)?.get<string>(DEFAULT_MODEL_CONFIG_SECTION);
    if (binding === undefined || typeof alias !== 'string') {
      throw new KimiError(
        ErrorCodes.MODEL_NOT_CONFIGURED,
        'Compaction requires a default model; configure one in config.toml first.',
      );
    }
    if (cached === undefined || cachedAlias !== alias) {
      cached = createSummarize({
        model: { spec: binding.model },
        requester: binding.requester,
        endpoint: { credentials: resolveSummarizeCredential(app, binding) },
      });
      cachedAlias = alias;
    }
    return cached(input);
  };
}
