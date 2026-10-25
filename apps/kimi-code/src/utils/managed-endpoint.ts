/**
 * Managed Kimi Code endpoint and wire-dialect helpers shared by the
 * `kimi provider endpoint|protocol` CLI subcommands and the `/provider` /
 * `/wire` TUI toggles.
 *
 * Both switches edit the `managed:kimi-code` provider record only; the
 * credential (`oauth`) is never touched, so neither one needs a new login.
 */

import {
  KIMI_CODE_PROVIDER_NAME,
  KIMI_REGION_PROFILES,
  MANAGED_KIMI_WIRE_PROTOCOLS,
  parseManagedKimiWireProtocol,
  type KimiRegion,
  type ManagedKimiWireProtocol,
} from '@moonshot-ai/kimi-code-oauth';
import type { KimiConfig } from '@moonshot-ai/kimi-code-sdk';

export type ManagedProviderRecord = KimiConfig['providers'][string];
export type ManagedServiceRecord = NonNullable<NonNullable<KimiConfig['services']>['moonshotSearch']>;

const WIRE_PROTOCOL_ROUTES: Readonly<Record<ManagedKimiWireProtocol, string>> = {
  chat: '/chat/completions',
  responses: '/responses',
  messages: '/messages',
};

/**
 * The two managed Kimi Code API endpoints, keyed by the short names users
 * type. Both serve the same account and the same models.
 */
export const MANAGED_ENDPOINTS: Readonly<
  Record<'com' | 'ai', { region: KimiRegion; baseUrl: string }>
> = {
  com: { region: 'mainland-cn', baseUrl: KIMI_REGION_PROFILES['mainland-cn'].baseUrl },
  ai: { region: 'global', baseUrl: KIMI_REGION_PROFILES.global.baseUrl },
};

export type ManagedEndpointName = keyof typeof MANAGED_ENDPOINTS;

export const MANAGED_ENDPOINT_NAMES = Object.keys(MANAGED_ENDPOINTS) as ManagedEndpointName[];

export function managedEndpointName(baseUrl: string | undefined): ManagedEndpointName | undefined {
  if (baseUrl === undefined) return undefined;
  const normalized = baseUrl.replace(/\/+$/, '');
  return MANAGED_ENDPOINT_NAMES.find((name) => MANAGED_ENDPOINTS[name].baseUrl === normalized);
}

export function compareEnumArg<T extends string>(
  value: string,
  allowed: readonly T[],
): T | undefined {
  const normalized = value.trim().toLowerCase();
  return allowed.find((candidate) => candidate === normalized);
}

/** The declared wire dialect, defaulting to `chat` (the provider-type default). */
export function currentWireProtocol(provider: ManagedProviderRecord): ManagedKimiWireProtocol {
  return parseManagedKimiWireProtocol(provider.wireProtocol) ?? 'chat';
}

export function managedProvider(config: KimiConfig): ManagedProviderRecord | undefined {
  return config.providers[KIMI_CODE_PROVIDER_NAME];
}

export function describeManagedEndpoint(provider: ManagedProviderRecord): string {
  const name = managedEndpointName(provider.baseUrl);
  const endpoint =
    name === undefined ? `custom (${provider.baseUrl ?? 'unset'})` : `${name} (${provider.baseUrl ?? ''})`;
  const wireProtocol = currentWireProtocol(provider);
  return (
    `Kimi Code endpoint: ${endpoint}\n` +
    `Wire protocol:      ${wireProtocol} (POST ${WIRE_PROTOCOL_ROUTES[wireProtocol]})\n`
  );
}

export function wireProtocolRoute(wireProtocol: ManagedKimiWireProtocol): string {
  return WIRE_PROTOCOL_ROUTES[wireProtocol];
}

export function wireProtocolNames(): readonly ManagedKimiWireProtocol[] {
  return MANAGED_KIMI_WIRE_PROTOCOLS;
}

/**
 * Config patch for a provider-record change: the whole providers map (the
 * write path replaces sections wholesale) plus the managed search/fetch
 * services retargeted at the record's new base URL.
 */
export function managedProviderConfigPatch(
  config: KimiConfig,
  provider: ManagedProviderRecord,
): Pick<KimiConfig, 'providers' | 'services'> {
  return {
    providers: { ...config.providers, [KIMI_CODE_PROVIDER_NAME]: provider },
    services: retargetManagedServices(config.services, provider),
  };
}

function retargetManagedServices(
  services: KimiConfig['services'],
  provider: ManagedProviderRecord,
): NonNullable<KimiConfig['services']> {
  const baseUrl = provider.baseUrl?.replace(/\/+$/, '');
  if (baseUrl === undefined) return services ?? {};
  return {
    ...services,
    moonshotSearch: retargetManagedService(services?.moonshotSearch, baseUrl, '/search', provider),
    moonshotFetch: retargetManagedService(services?.moonshotFetch, baseUrl, '/fetch', provider),
  };
}

// Only a service already pointing at a managed endpoint follows the switch; a
// hand-configured search/fetch endpoint is left alone.
function retargetManagedService(
  service: ManagedServiceRecord | undefined,
  baseUrl: string,
  suffix: string,
  provider: ManagedProviderRecord,
): ManagedServiceRecord {
  const target = `${baseUrl}${suffix}`;
  if (service === undefined) {
    return { baseUrl: target, apiKey: '', ...(provider.oauth === undefined ? {} : { oauth: provider.oauth }) };
  }
  const current = (service.baseUrl ?? '').replace(/\/+$/, '');
  const origin = current.endsWith(suffix) ? current.slice(0, -suffix.length) : current;
  return managedEndpointName(origin) === undefined ? service : { ...service, baseUrl: target };
}
