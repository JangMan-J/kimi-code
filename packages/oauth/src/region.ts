/**
 * Region profiles for the mainland-China (.com) and global (.ai)
 * Kimi Code deployments, plus the resolver that decides which region a
 * client belongs to.
 *
 * A region is a bundle of endpoints (OAuth host, managed API base URL, CDN,
 * site, Remote Control relay, and telemetry when that region's collector is
 * live). The OAuth client_id is shared across regions and stays in
 * `./constants`.
 *
 * Resolution order (first match wins):
 *   1. env override (`KIMI_CODE_OAUTH_HOST` / `KIMI_OAUTH_HOST`)
 *   2. persisted login (the `oauthHost` stored in config.toml's oauth ref)
 *   3. persisted default-slot login (the oauth ref's key equals
 *      `KIMI_CODE_OAUTH_KEY` — a mainland-China login persists no
 *      `oauthHost`, so the default slot's presence is an explicit-mainland-cn
 *      signal that outranks the marker)
 *   4. install-channel marker file (`<home>/region`, written by install
 *      scripts; consultable only before the first login)
 *   5. default 'mainland-cn'
 */

import { existsSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { DEFAULT_KIMI_CODE_OAUTH_HOST } from './constants';
import { DEFAULT_KIMI_CODE_BASE_URL } from './managed-usage';
import {
  kimiCodeEnvBaseUrl,
  kimiCodeEnvOAuthHost,
  KIMI_CODE_OAUTH_KEY,
  resolveKimiCodeOAuthRef,
} from './managed-kimi-code';
import {
  collectLocalRegionSignals,
  detectKimiRegionFromLocalSignals,
  type LocalRegionSignals,
} from './region-local';

export type KimiRegion = 'mainland-cn' | 'global';

/** Zod schema for the wire/domain contract; parses to {@link KimiRegion}. */
export const kimiRegionSchema = z.enum(['mainland-cn', 'global']);

export interface KimiRegionProfile {
  /** OAuth host the device flow talks to (authorize/token derive from it). */
  readonly oauthHost: string;
  /** Managed API base (`/coding/v1`): usages, userinfo, models, feedback... */
  readonly baseUrl: string;
  /** Update/install/plugin-marketplace root. */
  readonly cdnBase: string;
  /** Official site root (docs, console, signup, upgrade pages). */
  readonly siteBase: string;
  /**
   * Cloud telemetry collector. Absent when that collector is not live; callers
   * must skip the send instead of falling back to another region's host.
   */
  readonly telemetryEndpoint?: string;
  /** Remote Control relay origin (`kimi rc` / `/web` public URL). */
  readonly relayOrigin: string;
}

export const KIMI_REGION_PROFILES: Record<KimiRegion, KimiRegionProfile> = {
  'mainland-cn': {
    oauthHost: DEFAULT_KIMI_CODE_OAUTH_HOST,
    baseUrl: DEFAULT_KIMI_CODE_BASE_URL,
    cdnBase: 'https://code.kimi.com/kimi-code',
    siteBase: 'https://www.kimi.com',
    telemetryEndpoint: 'https://telemetry-logs.kimi.com/v1/event',
    relayOrigin: 'https://code-rc.kimi.com',
  },
  global: {
    oauthHost: 'https://auth.kimi.ai',
    baseUrl: 'https://api.kimi.ai/coding/v1',
    cdnBase: 'https://code.kimi.ai/kimi-code',
    siteBase: 'https://www.kimi.ai',
    relayOrigin: 'https://code-rc.kimi.ai',
  },
};

export function kimiRegionProfile(region: KimiRegion): KimiRegionProfile {
  return KIMI_REGION_PROFILES[region];
}

/**
 * Content-CDN URL builder (tips banner, WebBridge / Computer-Use binaries).
 * International mirror coverage of cdn.kimi.ai for these payloads is still
 * being confirmed, so both regions currently share the .com host — funnel
 * every content URL through here so flipping later touches one function.
 */
export function kimiCdnContentUrl(path: string): string {
  return `https://cdn.kimi.com/${path.replace(/^\/+/, '')}`;
}

/**
 * Login hosts for an explicit region choice, or `undefined` when an env
 * override (`KIMI_CODE_OAUTH_HOST` / `KIMI_OAUTH_HOST` / `KIMI_CODE_BASE_URL`)
 * is in play — env keeps full control of endpoints, so a region pick must not
 * smuggle profile hosts past it (requested hosts outrank env in
 * `resolveKimiCodeLoginAuth`).
 *
 * When returned, both hosts are always set — including for 'mainland-cn',
 * whose values equal the defaults. Passing them explicitly is what lets
 * "switch back to mainland China" override a previously persisted global
 * login in config.toml.
 */
export function kimiRegionLoginHosts(
  region: KimiRegion,
  env: NodeJS.ProcessEnv = process.env,
): { readonly oauthHost: string; readonly baseUrl: string } | undefined {
  if (kimiCodeEnvOAuthHost(env) !== undefined || kimiCodeEnvBaseUrl(env) !== undefined) {
    return undefined;
  }
  const profile = kimiRegionProfile(region);
  return { oauthHost: profile.oauthHost, baseUrl: profile.baseUrl };
}

/**
 * Marker file name under the Kimi home dir. Install scripts write a single
 * line (`mainland-cn` or `global`) here so a fresh client can default to the
 * region matching the channel it was installed from. It is only consulted
 * while the user has never logged in; a persisted login (config.toml) always
 * wins.
 */
export const KIMI_REGION_MARKER_FILENAME = 'region';

export interface ResolveKimiRegionOptions {
  /** Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** The `oauthHost` persisted in config.toml's oauth ref, if any. */
  readonly configuredOAuthHost?: string;
  /**
   * The credential key persisted in config.toml's oauth ref, if any. The
   * default slot ({@link KIMI_CODE_OAUTH_KEY}) only ever holds a
   * mainland-China login — mainland-cn persists no `oauthHost` — so its
   * presence is an explicit-mainland-cn signal that outranks the
   * install-channel marker.
   */
  readonly configuredOAuthKey?: string;
  /** Kimi home dir; defaults to `KIMI_CODE_HOME` or `~/.kimi-code`. */
  readonly homeDir?: string;
  /**
   * Set false to skip the install-channel marker (e.g. the desktop app's
   * embedded server, which is not installed through a channel script and
   * leaves the region choice entirely to the login UI).
   */
  readonly readMarker?: boolean;
}

function normalizeHost(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function regionForOAuthHost(oauthHost: string): KimiRegion | undefined {
  const normalized = normalizeHost(oauthHost);
  for (const region of Object.keys(KIMI_REGION_PROFILES) as KimiRegion[]) {
    if (normalizeHost(KIMI_REGION_PROFILES[region].oauthHost) === normalized) return region;
  }
  return undefined;
}

function readRegionMarker(homeDir: string): KimiRegion | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(homeDir, KIMI_REGION_MARKER_FILENAME), 'utf-8');
  } catch {
    return undefined;
  }
  const value = raw.trim();
  return value === 'mainland-cn' || value === 'global' ? value : undefined;
}

// Mirrors `defaultKimiHome` in ./toolkit; keep the two in sync so the marker
// always lands next to the credentials dir it describes.
function defaultHomeDir(env: NodeJS.ProcessEnv): string {
  const override = env['KIMI_CODE_HOME'];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), '.kimi-code');
}

/** A repair lock untouched for longer than any real repair takes is stale. */
const REPAIR_LOCK_STALE_MS = 10_000;

type RepairLockOutcome = 'acquired' | 'holder-active' | 'unrecoverable';

function tryAcquireRepairLock(lockPath: string): boolean {
  try {
    writeFileSync(lockPath, `${process.pid}\n`, { encoding: 'utf-8', flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function acquireRepairLock(lockPath: string): RepairLockOutcome {
  if (tryAcquireRepairLock(lockPath)) return 'acquired';
  let stale: boolean;
  try {
    stale = Date.now() - statSync(lockPath).mtimeMs > REPAIR_LOCK_STALE_MS;
  } catch {
    // The lock vanished meanwhile — retry once.
    return tryAcquireRepairLock(lockPath) ? 'acquired' : 'holder-active';
  }
  if (!stale) return 'holder-active';
  try {
    unlinkSync(lockPath);
  } catch {
    // The stale lock cannot be cleared (e.g. a temporarily locked file on
    // Windows): waiting would stall every later refresh, so the caller falls
    // back to its own judgment without waiting.
    return 'unrecoverable';
  }
  return tryAcquireRepairLock(lockPath) ? 'acquired' : 'holder-active';
}

/** Sidecar carrying a first-run judgment's provenance; see {@link writeRegionJudgmentSidecar}. */
export const KIMI_REGION_JUDGMENT_FILENAME = 'region.json';

function judgmentSidecarIsInferred(homeDir: string): boolean {
  try {
    const parsed = JSON.parse(
      readFileSync(join(homeDir, KIMI_REGION_JUDGMENT_FILENAME), 'utf-8'),
    ) as { source?: unknown };
    return parsed.source === 'local-signals' || parsed.source === 'fallback';
  } catch {
    return false;
  }
}

/**
 * First-writer-wins marker persistence. Uses temp-file + hard-link for an
 * atomic no-overwrite create; on filesystems without hard links (exFAT/FAT,
 * restricted network mounts) falls back to an exclusive create, which keeps
 * the winner-takes-all property but reopens a small race window on those
 * filesystems only. Throws with code EEXIST when another process already won.
 */
function persistMarkerFirstWriterWins(homeDir: string, region: KimiRegion): void {
  const markerPath = join(homeDir, KIMI_REGION_MARKER_FILENAME);
  const tmpPath = join(homeDir, `${KIMI_REGION_MARKER_FILENAME}.${process.pid}.tmp`);
  let linked = false;
  try {
    writeFileSync(tmpPath, `${region}\n`, 'utf-8');
    linkSync(tmpPath, markerPath);
    linked = true;
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Nothing to clean up.
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS') throw error;
  }
  if (linked) {
    // The marker is already published; a cleanup failure must not downgrade
    // this to a failed persist (or worse, an apparent race winner).
    try {
      unlinkSync(tmpPath);
    } catch {
      // A leftover temp file is harmless.
    }
    return;
  }
  writeFileSync(markerPath, `${region}\n`, { encoding: 'utf-8', flag: 'wx' });
}

/**
 * Writes the first-run judgment's provenance sidecar. The marker itself
 * stays a bare region for compatibility, but the provenance must exist
 * somewhere durable — a later custom scoped login relies on it to tell an
 * inferred marker from an install-channel one, so the caller rolls the
 * marker back when this returns false.
 */
function tryWriteRegionJudgmentSidecar(
  homeDir: string,
  resolution: KimiRegionResolution,
): boolean {
  try {
    writeFileSync(
      join(homeDir, KIMI_REGION_JUDGMENT_FILENAME),
      `${JSON.stringify({
        region: resolution.region,
        source: resolution.source,
        detectedAt: new Date().toISOString(),
      })}\n`,
      'utf-8',
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * How a resolved region was decided. `env` / `login` / `marker` mirror the
 * persisted steps of the resolution chain; `local-signals` and `fallback`
 * are produced by {@link ensureKimiRegionMarker} after a first-run local
 * judgment (confident vs. fallen back); `default` means the chain reached
 * its final default with no judgment attempted (e.g. the marker is skipped).
 */
export type KimiRegionSource =
  | 'env'
  | 'login'
  | 'marker'
  | 'local-signals'
  | 'fallback'
  | 'default';

export interface KimiRegionResolution {
  readonly region: KimiRegion;
  readonly source: KimiRegionSource;
}

/**
 * Process-wide cache of a first-run local judgment, keyed by Kimi home dir.
 * It lets every consumer in the process share the verdict even when the
 * marker file could not be persisted (read-only home), so one process never
 * mixes global telemetry routing with mainland login/CDN routing. Entries
 * are only ever consulted at the chain's default step — env, login, and a
 * later-appearing marker file always outrank them.
 */
const inferredRegionCache = new Map<string, KimiRegionResolution>();

export function resolveKimiRegionDetailed(
  options: ResolveKimiRegionOptions = {},
): KimiRegionResolution {
  const env = options.env ?? process.env;
  // An env host that matches a profile pins the region. An unknown env host
  // means a custom/internal environment: the per-endpoint env overrides keep
  // doing their job regardless of region, so skip straight to the default
  // instead of letting a stale config/marker point CDN links somewhere odd.
  const envHost = env['KIMI_CODE_OAUTH_HOST'] ?? env['KIMI_OAUTH_HOST'];
  if (envHost !== undefined && envHost.length > 0) {
    return { region: regionForOAuthHost(envHost) ?? 'mainland-cn', source: 'env' };
  }
  const configured = options.configuredOAuthHost;
  if (configured !== undefined && configured.length > 0) {
    const configuredRegion = regionForOAuthHost(configured);
    if (configuredRegion !== undefined) return { region: configuredRegion, source: 'login' };
  }
  if (options.configuredOAuthKey === KIMI_CODE_OAUTH_KEY) {
    return { region: 'mainland-cn', source: 'login' };
  }
  if (options.readMarker !== false) {
    const homeDir = options.homeDir ?? defaultHomeDir(env);
    const markerRegion = readRegionMarker(homeDir);
    // Reaching here with a configured key means a custom scoped login (the
    // default slot returned above, an official host matched earlier): an
    // install-channel marker still applies, but a marker this client itself
    // inferred while logged out must not flip a custom environment — keep the
    // conservative default instead.
    const customScopedLogin = options.configuredOAuthKey !== undefined;
    if (
      markerRegion !== undefined &&
      !(customScopedLogin && judgmentSidecarIsInferred(homeDir))
    ) {
      return { region: markerRegion, source: 'marker' };
    }
    if (!customScopedLogin) {
      const inferred = inferredRegionCache.get(homeDir);
      if (inferred !== undefined) return inferred;
    }
  }
  return { region: 'mainland-cn', source: 'default' };
}

export function resolveKimiRegion(options: ResolveKimiRegionOptions = {}): KimiRegion {
  return resolveKimiRegionDetailed(options).region;
}

export interface EnsureKimiRegionMarkerOptions extends ResolveKimiRegionOptions {
  /** Signals to judge from; defaults to a fresh local read. Injectable for tests. */
  readonly signals?: LocalRegionSignals;
  /**
   * How long to wait for another process repairing a malformed marker before
   * falling back to this process's own judgment. Defaults to 2s; 0 disables
   * the wait (tests).
   */
  readonly lockWaitMs?: number;
}

/**
 * {@link resolveKimiRegionDetailed} plus first-run persistence: when the
 * whole chain would fall through to the default, judge the region from local
 * device signals and write the verdict to the marker file, so later starts
 * hit the marker step directly and the judgment stays stable over time (the
 * RFC's "decide once, cache, do not drift with IP" semantics for logged-out
 * clients). Steps that outrank the marker (env, persisted login) never
 * trigger a write; `readMarker: false` skips detection entirely and reports
 * `default`, leaving the region choice to the caller (the desktop embedded
 * server leaves it to the login UI).
 */
export function ensureKimiRegionMarker(
  options: EnsureKimiRegionMarkerOptions = {},
): KimiRegionResolution {
  const resolution = resolveKimiRegionDetailed(options);
  if (
    resolution.source !== 'default' ||
    options.readMarker === false ||
    // A persisted login of any kind — official, scoped, or a custom
    // environment whose host is not recognized — means this is not a
    // logged-out install: keep the conservative default instead of inferring
    // from unrelated device signals.
    options.configuredOAuthHost !== undefined ||
    options.configuredOAuthKey !== undefined
  ) {
    return resolution;
  }
  const detection = detectKimiRegionFromLocalSignals(
    options.signals ?? collectLocalRegionSignals(),
  );
  const inferred: KimiRegionResolution = {
    region: detection.region,
    source: detection.confident ? 'local-signals' : 'fallback',
  };
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? defaultHomeDir(env);
  inferredRegionCache.set(homeDir, inferred);
  let persistError: NodeJS.ErrnoException | undefined;
  try {
    // The home may not exist yet on a truly fresh `kimi login` — the marker
    // write is the whole point, so create it first (private, matching the
    // other home/config creation paths).
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    persistMarkerFirstWriterWins(homeDir, detection.region);
  } catch (error) {
    persistError = error as NodeJS.ErrnoException;
  }
  if (persistError === undefined) {
    if (!tryWriteRegionJudgmentSidecar(homeDir, inferred)) {
      // Provenance must travel with the marker — a later custom scoped login
      // reads it to tell an inferred marker from an install-channel one.
      // Roll the marker back and let the next start re-judge.
      try {
        unlinkSync(join(homeDir, KIMI_REGION_MARKER_FILENAME));
      } catch {
        // Best effort.
      }
    }
    return inferred;
  }
  {
    const error = persistError;
    if (error.code === 'EEXIST') {
      const winner = readRegionMarker(homeDir);
      if (winner !== undefined) {
        inferredRegionCache.delete(homeDir);
        return { region: winner, source: 'marker' };
      }
      // The existing file is malformed or empty — it carries no verdict, so
      // repair it with this judgment; otherwise every new process would keep
      // re-detecting (and could route a mainland user internationally).
      // Serialize the repair through a lock file so two processes fixing the
      // same malformed marker cannot both win with different verdicts.
      const lockPath = join(homeDir, `${KIMI_REGION_MARKER_FILENAME}.lock`);
      const lockOutcome = acquireRepairLock(lockPath);
      if (lockOutcome === 'acquired') {
        // Another repair may have completed between the first read and the
        // lock acquisition: re-read under the lock and yield to a verdict
        // that is already valid instead of overwriting it.
        const repaired = readRegionMarker(homeDir);
        if (repaired !== undefined) {
          inferredRegionCache.delete(homeDir);
          try {
            unlinkSync(lockPath);
          } catch {
            // A leftover lock degrades future repairs to in-memory verdicts.
          }
          return { region: repaired, source: 'marker' };
        }
        let repairedByUs = false;
        try {
          writeFileSync(
            join(homeDir, KIMI_REGION_MARKER_FILENAME),
            `${detection.region}\n`,
            'utf-8',
          );
          repairedByUs = true;
        } catch {
          // Still unwritable; the in-memory verdict stands for this process.
        }
        if (repairedByUs && !tryWriteRegionJudgmentSidecar(homeDir, inferred)) {
          try {
            unlinkSync(join(homeDir, KIMI_REGION_MARKER_FILENAME));
          } catch {
            // Best effort.
          }
        }
        try {
          unlinkSync(lockPath);
        } catch {
          // A stale lock degrades future repairs to per-process in-memory
          // verdicts, never to a wrong region.
        }
        return inferred;
      }
      if (lockOutcome === 'unrecoverable') {
        // The stale lock cannot be cleared: keep this process's cached
        // verdict (set above) instead of stalling every later refresh on a
        // wait that can never succeed.
        return inferred;
      }
      // Another process is (or was) repairing: wait briefly for its verdict
      // instead of returning an independently inferred one, so both processes
      // route the same way from the very first call. A stale lock or a failed
      // holder degrades to this process's judgment after the wait, never to a
      // wrong region.
      const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + (options.lockWaitMs ?? 2_000);
      let repaired = readRegionMarker(homeDir);
      while (repaired === undefined && existsSync(lockPath) && Date.now() < deadline) {
        Atomics.wait(waitBuffer, 0, 0, 25);
        repaired = readRegionMarker(homeDir);
      }
      // Drop the in-memory cache either way so the next call re-reads the
      // file the lock holder wrote and converges onto it.
      inferredRegionCache.delete(homeDir);
      if (repaired !== undefined) return { region: repaired, source: 'marker' };
      return inferred;
    }
    // An unwritable home dir must not break startup; the in-memory verdict
    // still stands for this process and the write is retried next start.
  }
  return inferred;
}

export interface KimiRemoteControlAuth {
  readonly region: KimiRegion;
  readonly oauthKey: string;
  readonly relayOrigin: string;
}

/**
 * One region judgment for Remote Control: credential slot + relay origin.
 *
 * `oauthKey` is the persisted login slot when `configuredOAuthKey` is set
 * (including custom `kimi-code-env-*` environments); otherwise the official
 * slot for the resolved region. `relayOrigin` follows the resolved region
 * profile, except that a custom-env login — a scoped slot outside the two
 * official ones, without a recognized `configuredOAuthHost` — keeps the
 * mainland relay: an install-channel marker must not flip a custom
 * environment to `.ai`.
 */
export function resolveKimiRemoteControlAuth(
  options: ResolveKimiRegionOptions = {},
): KimiRemoteControlAuth {
  const region = resolveKimiRegion(options);
  const profile = kimiRegionProfile(region);
  const configuredKey = options.configuredOAuthKey;
  const customSlot =
    configuredKey !== undefined &&
    configuredKey !== KIMI_CODE_OAUTH_KEY &&
    configuredKey !==
      resolveKimiCodeOAuthRef({
        oauthHost: KIMI_REGION_PROFILES.global.oauthHost,
        baseUrl: KIMI_REGION_PROFILES.global.baseUrl,
      }).key;
  const hostPinned =
    options.configuredOAuthHost !== undefined &&
    regionForOAuthHost(options.configuredOAuthHost) !== undefined;
  return {
    region,
    oauthKey:
      configuredKey ??
      resolveKimiCodeOAuthRef({
        oauthHost: profile.oauthHost,
        baseUrl: profile.baseUrl,
      }).key,
    relayOrigin:
      customSlot && !hostPinned
        ? KIMI_REGION_PROFILES['mainland-cn'].relayOrigin
        : profile.relayOrigin,
  };
}
