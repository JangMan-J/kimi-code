/**
 * Process-wide region cache for the CLI/TUI.
 *
 * Region decides which deployment (mainland-China .com / international .ai)
 * the client's off-session endpoints point at: CDN (updates, plugins, tips),
 * site links, telemetry. The OAuth login flow itself does NOT read this — it
 * takes explicit hosts; this cache is for everything derived afterwards.
 *
 * Resolution lives in `@moonshot-ai/kimi-code-oauth` (see `resolveKimiRegion`);
 * this module only adds the one thing that package deliberately does not own:
 * reading the persisted login's oauth ref (credential key + `oauthHost`) out
 * of config.toml, synchronously, via the SDK's safe config reader. First call
 * wins; `refreshKimiRegion` re-resolves after login/logout rewrote the oauth
 * ref.
 */

import { loadRuntimeConfigSafe, resolveConfigPath } from '@moonshot-ai/kimi-code-sdk';
import {
  ensureKimiRegionMarker,
  KIMI_CODE_OAUTH_KEY,
  KIMI_REGION_PROFILES,
  type KimiRegion,
  type KimiRegionProfile,
  type KimiRegionResolution,
} from '@moonshot-ai/kimi-code-oauth';

// Same value as DEFAULT_OAUTH_PROVIDER_NAME in '#/constant/app' — inlined here
// to keep the import one-directional (constant/app derives URLs from this
// module, so this module must not import back from it).
const MANAGED_KIMI_CODE_PROVIDER_KEY = 'managed:kimi-code';

/** Platform-selector value for the global OAuth login entry. */
export const KIMI_CODE_GLOBAL_PLATFORM_VALUE = 'kimi-code-global';

let cached: KimiRegionResolution | undefined;

export interface PersistedKimiOAuthRef {
  readonly key: string;
  readonly oauthHost?: string;
}

/** The oauth ref persisted by a previous login, if any. */
export function persistedKimiOAuthRef(): PersistedKimiOAuthRef | undefined {
  const result = loadRuntimeConfigSafe(resolveConfigPath({}));
  // `providers` is always present on a real config load; the `?.` guards
  // hosts/tests that hand us a partial config shape.
  const oauth = result.config.providers?.[MANAGED_KIMI_CODE_PROVIDER_KEY]?.oauth;
  if (oauth === undefined) return undefined;
  return { key: oauth.key, oauthHost: oauth.oauthHost };
}

/** Region for a no-flag `kimi login` / `kimi acp --login`: a fresh install
    follows the resolved region (env/marker/default); the default slot (only
    ever a mainland-cn login) re-pins the profile explicitly; a scoped slot —
    a global login, or a custom env persisted with only KIMI_CODE_BASE_URL and
    no oauthHost — keeps its configured hosts (`undefined`). */
export function regionForBareLogin(ref: PersistedKimiOAuthRef | undefined): KimiRegion | undefined {
  if (ref === undefined) return currentKimiRegion();
  return ref.key === KIMI_CODE_OAUTH_KEY ? 'mainland-cn' : undefined;
}

export function currentKimiRegionResolution(): KimiRegionResolution {
  if (cached === undefined) {
    cached = resolveKimiRegionFresh();
  }
  return cached;
}

/**
 * Re-resolves without the process cache. Long-running hosts whose login
 * state can change behind the cache's back (the `kimi web` server OAuth API
 * never calls `refreshKimiRegion`) must use this so endpoint and context
 * refreshes actually follow a login/logout.
 */
export function resolveKimiRegionFresh(): KimiRegionResolution {
  const persisted = persistedKimiOAuthRef();
  // `ensureKimiRegionMarker` resolves the same chain as `resolveKimiRegion`
  // and, for a logged-out install with no marker, additionally judges the
  // region from local device signals once and persists the verdict as the
  // marker — so every consumer here (CDN, site links, telemetry) shares
  // that cached judgment from the second call on.
  return ensureKimiRegionMarker({
    configuredOAuthHost: persisted?.oauthHost,
    configuredOAuthKey: persisted?.key,
    readMarker: process.env['KIMI_CODE_REGION_MARKER'] !== 'off',
  });
}

export function currentKimiRegion(): KimiRegion {
  return currentKimiRegionResolution().region;
}

export function currentKimiProfile(): KimiRegionProfile {
  return KIMI_REGION_PROFILES[currentKimiRegion()];
}

/** Profile companion of {@link resolveKimiRegionFresh} for cache-less hosts. */
export function freshKimiProfile(): KimiRegionProfile {
  return KIMI_REGION_PROFILES[resolveKimiRegionFresh().region];
}

/** Drop the cache and re-resolve. Call after login/logout rewrote config. */
export function refreshKimiRegion(): KimiRegion {
  cached = undefined;
  return currentKimiRegion();
}

/**
 * Test-only cache reset: drops the cached resolution WITHOUT re-resolving.
 * Cleanup that restores the real environment must use this instead of
 * {@link refreshKimiRegion} — an eager re-resolve can persist a first-run
 * marker into the developer's real Kimi home.
 */
export function resetKimiRegionCache(): void {
  cached = undefined;
}