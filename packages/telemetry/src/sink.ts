import { arch, platform, release } from 'node:os';

import type {
  EnrichedTelemetryEvent,
  TelemetryContext,
  TelemetryEvent,
  TelemetryPrimitive,
  TelemetryTransport,
} from './types';

export interface EventSinkContextOptions {
  readonly appName: string;
  readonly version: string;
  readonly uiMode?: string;
  readonly model?: string;
  readonly buildSha?: string;
  readonly terminal?: string;
  readonly locale?: string;
  readonly region?: string;
  readonly regionSource?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface EventSinkContextRefresh {
  readonly region?: string;
  readonly regionSource?: string;
}

export interface EventSinkOptions {
  readonly transport: TelemetryTransport;
  readonly context: EventSinkContextOptions;
  readonly refreshContext?: () => EventSinkContextRefresh;
  readonly flushIntervalMs?: number;
  readonly flushThreshold?: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_FLUSH_THRESHOLD = 50;
const CONTEXT_REFRESH_INTERVAL_MS = 1_000;

export class EventSink {
  private readonly transport: TelemetryTransport;
  private readonly context: TelemetryContext;
  private readonly contextRefresher?: () => EventSinkContextRefresh;
  private readonly flushIntervalMs: number;
  private readonly flushThreshold: number;
  private buffer: EnrichedTelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private lastContextRefreshAt = 0;
  private firstEventAccepted = false;

  constructor(options: EventSinkOptions) {
    this.transport = options.transport;
    this.context = buildContext(options.context);
    this.contextRefresher = options.refreshContext;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.flushThreshold = options.flushThreshold ?? DEFAULT_FLUSH_THRESHOLD;
  }

  accept(event: TelemetryEvent): void {
    // The first event must carry the init-time context (e.g. a first-run
    // region judgment labeled local-signals/fallback) even when it arrives
    // after the refresh interval — refreshes only start afterwards.
    if (this.firstEventAccepted) {
      this.maybeRefreshContext();
    } else {
      this.firstEventAccepted = true;
      this.lastContextRefreshAt = Date.now();
    }
    const enriched: EnrichedTelemetryEvent = {
      ...event,
      context: { ...this.context },
    };
    this.buffer.push(enriched);
    if (this.buffer.length >= this.flushThreshold) {
      void this.flush().catch(() => {});
    }
  }

  private maybeRefreshContext(): void {
    if (this.contextRefresher === undefined) return;
    const now = Date.now();
    if (now - this.lastContextRefreshAt < CONTEXT_REFRESH_INTERVAL_MS) return;
    this.lastContextRefreshAt = now;
    const refresh = this.contextRefresher();
    setPrimitive(this.context, 'region', refresh.region);
    setPrimitive(this.context, 'region_source', refresh.regionSource);
  }

  setModel(model: string): void {
    setPrimitive(this.context, 'model', model);
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

  clearBuffer(): void {
    this.buffer = [];
  }

  async flush(signal?: AbortSignal): Promise<void> {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    await this.transport.send(events, signal);
  }

  flushSync(): void {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    try {
      this.transport.saveToDisk(events);
    } catch {
      // Telemetry must never make shutdown fail.
    }
  }
}

function buildContext(options: EventSinkContextOptions): TelemetryContext {
  const env = options.env ?? process.env;
  const context: TelemetryContext = {
    app_name: options.appName,
    version: options.version,
    runtime: 'node',
    platform: platform(),
    arch: arch(),
    node_version: process.versions.node,
    os_version: release(),
    ci: env['CI'] !== undefined,
    locale: options.locale ?? env['LANG'] ?? '',
    terminal: options.terminal ?? env['TERM_PROGRAM'] ?? '',
    ui_mode: options.uiMode ?? 'shell',
  };
  setPrimitive(context, 'model', options.model);
  setPrimitive(context, 'build_sha', options.buildSha);
  setPrimitive(context, 'region', options.region);
  setPrimitive(context, 'region_source', options.regionSource);
  return context;
}

function setPrimitive(
  target: TelemetryContext,
  key: string,
  value: TelemetryPrimitive | undefined,
): void {
  if (value === undefined) return;
  if (typeof value === 'string' && value.length === 0) return;
  target[key] = value;
}
