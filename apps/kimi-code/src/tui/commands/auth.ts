import {
  capabilitiesForModel,
  fetchOpenPlatformModels,
  filterModelsByPrefix,
  getOpenPlatformById,
  OAuthAccessDeniedError,
  OpenPlatformApiError,
  type KimiRegion,
  type ManagedKimiCodeModelInfo,
  type OpenPlatformDefinition,
} from '@moonshot-ai/kimi-code-oauth';
import { log } from '@moonshot-ai/kimi-code-sdk';

import type { ChoiceOption } from '../components/dialogs/choice-picker';
import { DEFAULT_OAUTH_PROVIDER_NAME, PRODUCT_NAME } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/errors';
import {
  KIMI_CODE_GLOBAL_PLATFORM_VALUE,
  refreshKimiRegion,
} from '#/utils/region';
import { removeProviderFromConfig } from '#/utils/provider-config';
import type { LoginProgressSpinnerHandle } from '../types';
import {
  promptApiKey,
  promptLogoutProviderSelection,
  promptModelSelectionForOpenPlatform,
  promptPlatformSelection,
} from './prompts';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Auth: login / logout
// ---------------------------------------------------------------------------

export async function handleLoginCommand(host: SlashCommandHost): Promise<void> {
  const platformId = await promptPlatformSelection(host);
  if (platformId === undefined) return;

  if (platformId === 'kimi-code' || platformId === KIMI_CODE_GLOBAL_PLATFORM_VALUE) {
    const region: KimiRegion = platformId === KIMI_CODE_GLOBAL_PLATFORM_VALUE ? 'global' : 'mainland-cn';
    await handleKimiCodeOAuthLogin(host, region);
    return;
  }

  const platform = getOpenPlatformById(platformId);
  if (platform === undefined) return;
  await handleOpenPlatformLogin(host, platform);
}

async function handleKimiCodeOAuthLogin(
  host: SlashCommandHost,
  region: KimiRegion,
): Promise<void> {
  const status = await host.harness.auth.status(DEFAULT_OAUTH_PROVIDER_NAME);
  const alreadyLoggedIn = status.providers.some(
    (provider) => provider.providerName === DEFAULT_OAUTH_PROVIDER_NAME && provider.hasToken,
  );

  let spinner: LoginProgressSpinnerHandle | undefined;
  const controller = new AbortController();
  const cancelLogin = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancelLogin;
  try {
    // The facade maps region → profile hosts (env overrides keep priority);
    // 'mainland-cn' is passed explicitly too so switching back overrides a
    // persisted global login.
    await host.harness.auth.login(DEFAULT_OAUTH_PROVIDER_NAME, {
      signal: controller.signal,
      region,
      onDeviceCode: (data) => {
        spinner = host.showLoginAuthorizationPrompt(data);
      },
    });
    refreshKimiRegion();
    spinner?.stop({ ok: true, label: 'Logged in.' });
    spinner = undefined;
    try {
      await host.authFlow.refreshConfigAfterLogin();
    } catch (refreshError) {
      const message = formatErrorMessage(refreshError);
      host.showError(`Authentication successful, but failed to refresh config: ${message}`);
      return;
    }
    host.track('login', {
      provider: DEFAULT_OAUTH_PROVIDER_NAME,
      method: 'oauth',
      already_logged_in: alreadyLoggedIn,
    });
    if (alreadyLoggedIn) {
      host.showStatus('Already logged in. Model configuration refreshed.', 'success');
    }
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const denied = error instanceof OAuthAccessDeniedError;
    spinner?.stop({
      ok: false,
      label: cancelled || denied ? 'Login cancelled.' : 'Login failed.',
    });
    spinner = undefined;
    if (cancelled) return;
    const message = formatErrorMessage(error);
    if (denied) {
      host.showError(`Login cancelled: ${message}`);
      return;
    }
    log.warn('login failed', {
      providerName: DEFAULT_OAUTH_PROVIDER_NAME,
      alreadyLoggedIn,
      sessionId: host.session?.id,
      error,
    });
    host.showError(`Login failed: ${message}`);
  } finally {
    if (host.cancelInFlight === cancelLogin) {
      host.cancelInFlight = undefined;
    }
  }
}

async function handleOpenPlatformLogin(
  host: SlashCommandHost,
  platform: OpenPlatformDefinition,
): Promise<void> {
  const consoleHost = platform.consoleUrl?.replace(/^https?:\/\//, '') ?? '';
  const platformName = consoleHost.length > 0 ? `Kimi Platform (${consoleHost})` : 'Kimi Platform';
  const subtitleLines = [
    `${'base_url'.padEnd(12)}${platform.baseUrl}`,
    `${'saved to'.padEnd(12)}~/.kimi-code/config.toml`,
  ];
  const apiKey = await promptApiKey(host, platformName, subtitleLines);
  if (apiKey === undefined) return;

  const controller = new AbortController();
  const cancelLogin = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancelLogin;

  let models: ManagedKimiCodeModelInfo[];
  try {
    models = await fetchOpenPlatformModels(platform, apiKey, fetch, controller.signal);
    models = filterModelsByPrefix(models, platform);
  } catch (error) {
    if (controller.signal.aborted) return;
    const msg = formatErrorMessage(error);
    host.showError(`Failed to verify API key: ${msg}`);
    if (
      error instanceof OpenPlatformApiError &&
      error.status === 401
    ) {
      host.showStatus(
        'Hint: If your API key was obtained from Kimi Code, please select "Kimi Code" instead.',
      );
    }
    return;
  } finally {
    if (host.cancelInFlight === cancelLogin) {
      host.cancelInFlight = undefined;
    }
  }

  if (models.length === 0) {
    host.showError('No models available for this platform.');
    return;
  }

  const selection = await promptModelSelectionForOpenPlatform(host, models, platform);
  if (selection === undefined) return;

  const providers = {
    ...host.harness.config.get<Record<string, unknown>>('providers'),
  };
  const modelRecords = {
    ...host.harness.config.get<Record<string, unknown>>('models'),
  };
  for (const key of Object.keys(modelRecords)) {
    if (key.startsWith(`${platform.id}/`)) delete modelRecords[key];
  }
  providers[platform.id] = {
    type: 'kimi',
    baseUrl: platform.baseUrl,
    apiKey,
  };
  for (const model of models) {
    modelRecords[`${platform.id}/${model.id}`] = {
      provider: platform.id,
      model: model.id,
      maxContextSize: model.contextLength,
      capability: capabilityStruct(capabilitiesForModel(model)),
      displayName: model.displayName,
      supportEfforts: model.supportEfforts,
      defaultEffort: model.defaultEffort,
    };
  }
  const effort =
    selection.thinking !== 'off' && selection.thinking !== 'on'
      ? selection.thinking
      : undefined;
  await host.harness.config.replace({
    providers,
    models: modelRecords,
    defaultModel: `${platform.id}/${selection.model.id}`,
    thinking: { enabled: selection.thinking !== 'off', effort },
  });

  await host.authFlow.refreshConfigAfterLogin();
  host.track('login', { provider: platform.id, method: 'api_key' });
  host.showStatus(`Setup complete: ${platform.name} · ${selection.model.id}`);
}

function capabilityStruct(caps: readonly string[] | undefined): {
  image_in: boolean;
  video_in: boolean;
  audio_in: boolean;
  thinking: boolean;
  tool_use: boolean;
} {
  const set = new Set(caps ?? []);
  return {
    image_in: set.has('image_in'),
    video_in: set.has('video_in'),
    audio_in: set.has('audio_in'),
    thinking: set.has('thinking'),
    tool_use: true,
  };
}

export async function handleLogoutCommand(host: SlashCommandHost): Promise<void> {
  const oauthStatus = await host.harness.auth.status(DEFAULT_OAUTH_PROVIDER_NAME);
  const hasOAuthToken = oauthStatus.providers.some(
    (p) => p.providerName === DEFAULT_OAUTH_PROVIDER_NAME && p.hasToken,
  );
  const providers = host.harness.config.get<Record<string, { baseUrl?: unknown }>>('providers') ?? {};
  const hasManagedRemnant =
    hasOAuthToken || providers[DEFAULT_OAUTH_PROVIDER_NAME] !== undefined;
  const apiKeyProviderIds = Object.keys(providers)
    .filter((id) => id !== DEFAULT_OAUTH_PROVIDER_NAME)
    .toSorted();

  const options: ChoiceOption[] = [];
  if (hasManagedRemnant) {
    options.push({
      value: DEFAULT_OAUTH_PROVIDER_NAME,
      label: PRODUCT_NAME,
      description: 'OAuth login',
    });
  }
  for (const id of apiKeyProviderIds) {
    const baseUrl = providers[id]?.baseUrl;
    options.push({
      value: id,
      label: id,
      description: typeof baseUrl === 'string' && baseUrl.length > 0 ? baseUrl : undefined,
    });
  }

  if (options.length === 0) {
    host.showStatus('Nothing to logout.');
    return;
  }

  const currentModel = host.state.appState.model.trim();
  const currentProvider = host.state.appState.availableModels[currentModel]?.provider;

  const target = await promptLogoutProviderSelection(host, options, currentProvider);
  if (target === undefined) return;

  if (target === DEFAULT_OAUTH_PROVIDER_NAME) {
    await host.harness.auth.logout(DEFAULT_OAUTH_PROVIDER_NAME);
  } else {
    await removeProviderFromConfig(host.harness.config, target);
  }

  if (target === currentProvider) {
    await host.authFlow.refreshConfigAfterLogout();
  } else {
    await host.harness.config.reload();
    host.refreshAvailableModels();
  }
  refreshKimiRegion();

  host.track('logout', { provider: target });
  const label = target === DEFAULT_OAUTH_PROVIDER_NAME ? PRODUCT_NAME : target;
  host.showStatus(`Logged out from ${label}.`);
}
