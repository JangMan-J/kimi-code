import { randomUUID } from 'node:crypto';
import { release } from 'node:os';

import {
  ensureKimiRegionMarker,
  KIMI_CODE_PROVIDER_NAME,
  kimiRegionProfile,
  type KimiRegionResolution,
} from '@moonshot-ai/kimi-code-oauth';

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { PROVIDERS_SECTION } from '#/app/kosongConfig/configSection';
import type { ProviderConfig } from '#/llm-adapter/provider/provider';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import type { ITelemetryAppender, TelemetryAppenderRecord } from './telemetry';
import type { TelemetryProperties } from './context';
import {
  type CloudContext,
  type CloudPrimitive,
  type CloudProperties,
  CloudTransport,
  type EnrichedCloudEvent,
  isCloudPrimitive,
} from './cloudTransport';
import { resolveCoreVersion } from './coreVersion';
import { cleanTelemetryProperties } from './privacy';

export interface CloudAppenderOAuthRef {
  readonly key?: string;
  readonly oauthHost?: string;
}

export interface CloudAppenderOptions {
  readonly storage: IFileSystemStorageService;
  readonly bootstrap: IBootstrapService;
  readonly deviceId: string;
  readonly sessionId?: string;
  readonly appName: string;
  readonly uiMode?: string;
  readonly model?: string;
  readonly buildSha?: string;
  readonly terminal?: string;
  readonly locale?: string;
  readonly getAccessToken?: () => string | null | Promise<string | null>;
  readonly endpoint?: string;
  readonly configuredOAuthHost?: string;
  readonly configuredOAuthKey?: string;
  readonly getConfiguredOAuthRef?: () => CloudAppenderOAuthRef | undefined;
  readonly flushThreshold?: number;
  readonly flushIntervalMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly retryBackoffsMs?: readonly number[];
  readonly requestTimeoutMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

export interface CloudAppenderHostOptions {
  readonly deviceId: string;
  readonly appName: string;
  readonly uiMode?: string;
  readonly model?: string;
  readonly buildSha?: string;
  readonly sessionId?: string;
  readonly getAccessToken?: () => string | null | Promise<string | null>;
}

export function createCloudAppender(
  accessor: ServicesAccessor,
  host: CloudAppenderHostOptions,
): CloudAppender {
  return new CloudAppender({
    storage: accessor.get(IFileSystemStorageService),
    bootstrap: accessor.get(IBootstrapService),
    getConfiguredOAuthRef: () =>
      accessor
        .get(IConfigService)
        .inspect<Record<string, ProviderConfig>>(PROVIDERS_SECTION)
        .userValue?.[KIMI_CODE_PROVIDER_NAME]?.oauth,
    ...host,
  });
}

const DEFAULT_FLUSH_THRESHOLD = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const REGION_CONTEXT_REFRESH_INTERVAL_MS = 1_000;

export class CloudAppender implements ITelemetryAppender {
  private readonly transport: CloudTransport;
  private readonly context: CloudContext;
  private readonly flushThreshold: number;
  private readonly flushIntervalMs: number;
  private readonly resolveRegion: (() => KimiRegionResolution) | undefined;
  private readonly now: () => number;
  private deviceId: string;
  private sessionId: string | null;
  private buffer: EnrichedCloudEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private lastRegionRefreshAt = 0;
  private firstEventAccepted = false;

  constructor(options: CloudAppenderOptions) {
    this.deviceId = options.deviceId;
    this.sessionId = options.sessionId ?? null;
    this.flushThreshold = options.flushThreshold ?? DEFAULT_FLUSH_THRESHOLD;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    const readMarker =
      (options.bootstrap.getEnv('KIMI_CODE_REGION_MARKER') ??
        process.env['KIMI_CODE_REGION_MARKER']) !== 'off';
    const env = telemetryEnv(options.bootstrap);
    this.resolveRegion =
      options.endpoint === undefined
        ? () =>
            ensureKimiRegionMarker({
              env,
              homeDir: options.bootstrap.homeDir,
              readMarker,
              configuredOAuthHost:
                options.getConfiguredOAuthRef?.()?.oauthHost ?? options.configuredOAuthHost,
              configuredOAuthKey:
                options.getConfiguredOAuthRef?.()?.key ?? options.configuredOAuthKey,
            })
        : undefined;
    this.context = buildContext(options);
    this.now = options.now ?? Date.now;
    this.refreshRegionContext();
    this.lastRegionRefreshAt = this.now();
    this.transport = new CloudTransport({
      storage: options.storage,
      deviceId: options.deviceId,
      endpoint: options.endpoint,
      resolveEndpoint:
        this.resolveRegion !== undefined
          ? () => kimiRegionProfile(this.resolution().region).telemetryEndpoint
          : undefined,
      homeDir: options.bootstrap.homeDir,
      readMarker,
      configuredOAuthHost: options.configuredOAuthHost,
      configuredOAuthKey: options.configuredOAuthKey,
      env,
      getAccessToken: options.getAccessToken,
      fetchImpl: options.fetchImpl,
      retryBackoffsMs: options.retryBackoffsMs,
      requestTimeoutMs: options.requestTimeoutMs,
      sleep: options.sleep,
      now: options.now,
    });
  }

  private resolution(): KimiRegionResolution {
    const resolve = this.resolveRegion;
    if (resolve === undefined) throw new Error('region resolution is not available');
    return resolve();
  }

  private refreshRegionContext(): void {
    if (this.resolveRegion === undefined) return;
    const resolution = this.resolveRegion();
    setPrimitive(this.context, 'region', resolution.region);
    setPrimitive(this.context, 'region_source', resolution.source);
  }

  private maybeRefreshRegionContext(): void {
    if (this.resolveRegion === undefined) return;
    const now = this.now();
    if (now - this.lastRegionRefreshAt < REGION_CONTEXT_REFRESH_INTERVAL_MS) return;
    this.lastRegionRefreshAt = now;
    this.refreshRegionContext();
  }

  track(record: TelemetryAppenderRecord): void {
    if (this.firstEventAccepted) {
      this.maybeRefreshRegionContext();
    } else {
      this.firstEventAccepted = true;
      this.lastRegionRefreshAt = this.now();
    }
    const ambientSessionId = record.context['session_id'];
    const enriched: EnrichedCloudEvent = {
      event_id: randomUUID().replaceAll('-', ''),
      device_id: this.deviceId,
      session_id:
        typeof ambientSessionId === 'string' ? ambientSessionId : this.sessionId,
      event: record.event,
      timestamp: Date.now() / 1000,
      properties: cleanTelemetryProperties(sanitizeProperties(record.properties)),
      context: this.envelopeContext(record.context),
    };
    this.buffer.push(enriched);
    if (this.buffer.length >= this.flushThreshold) {
      void this.flush().catch(() => {});
    }
  }

  private envelopeContext(ambient: TelemetryProperties): CloudContext {
    const context: CloudContext = { ...this.context };
    const ambientModel = ambient['model'];
    if (typeof ambientModel === 'string' && ambientModel.length > 0) {
      context['model'] = ambientModel;
    }
    return context;
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    this.refreshRegionContext();
    const events = this.buffer;
    this.buffer = [];
    await this.transport.send(events);
  }

  async shutdown(): Promise<void> {
    this.stopPeriodicFlush();
    await this.flush();
  }

  startPeriodicFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setInterval(() => {
      void this.flush().catch(() => {});
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  stopPeriodicFlush(): void {
    if (this.flushTimer === null) return;
    clearInterval(this.flushTimer);
    this.flushTimer = null;
  }

  async retryDiskEvents(): Promise<void> {
    await this.transport.retryDiskEvents();
  }
}

function sanitizeProperties(input?: TelemetryProperties): CloudProperties {
  const out: CloudProperties = {};
  if (input === undefined) return out;
  for (const [key, value] of Object.entries(input)) {
    if (isCloudPrimitive(value)) {
      out[key] = value;
    } else {
      onUnexpectedError(
        new Error(`telemetry property "${key}" is not a primitive and was dropped`),
      );
    }
  }
  return out;
}

function buildContext(options: CloudAppenderOptions): CloudContext {
  const { bootstrap } = options;
  const context: CloudContext = {
    app_name: options.appName,
    client_version: bootstrap.clientIdentity.version,
    version: bootstrap.clientIdentity.version,
    core_version: resolveCoreVersion(),
    runtime: 'node',
    platform: bootstrap.platform,
    arch: bootstrap.arch,
    node_version: process.versions.node,
    os_version: release(),
    ci: bootstrap.getEnv('CI') !== undefined,
    locale: options.locale ?? bootstrap.getEnv('LANG') ?? '',
    terminal: options.terminal ?? bootstrap.getEnv('TERM_PROGRAM') ?? '',
    ui_mode: options.uiMode ?? 'shell',
  };
  setPrimitive(context, 'model', options.model);
  setPrimitive(context, 'build_sha', options.buildSha);
  return context;
}

function setPrimitive(target: CloudContext, key: string, value: CloudPrimitive): void {
  if (value === undefined) return;
  if (typeof value === 'string' && value.length === 0) return;
  target[key] = value;
}

function telemetryEnv(bootstrap: IBootstrapService): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const oauthHost = bootstrap.getEnv('KIMI_CODE_OAUTH_HOST');
  if (oauthHost !== undefined) env['KIMI_CODE_OAUTH_HOST'] = oauthHost;
  const legacyHost = bootstrap.getEnv('KIMI_OAUTH_HOST');
  if (legacyHost !== undefined) env['KIMI_OAUTH_HOST'] = legacyHost;
  if (oauthHost === undefined && legacyHost !== undefined) {
    delete env['KIMI_CODE_OAUTH_HOST'];
  }
  const baseUrl = bootstrap.getEnv('KIMI_CODE_BASE_URL');
  if (baseUrl !== undefined) env['KIMI_CODE_BASE_URL'] = baseUrl;
  return env;
}
