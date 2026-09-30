import { ModelDefaultsRef } from '@moonshot-ai/agent-core';
import { ModelsDevRef, type ModelsDevProviderItem } from '@moonshot-ai/harness-core';

import {
  providerSection,
  removeProviderFromConfig,
} from '#/utils/provider-config';

import { ApiKeyInputDialogComponent, type ApiKeyInputResult } from '../components/dialogs/api-key-input-dialog';
import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { ProviderManagerComponent, type ProviderManagerOptions } from '../components/dialogs/provider-manager';
import { formatErrorMessage } from '../utils/errors';
import { promptApiKey } from './prompts';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// /provider command
// ---------------------------------------------------------------------------

export async function handleProviderCommand(host: SlashCommandHost, rawArgs: string): Promise<void> {
  const args = rawArgs.trim().split(/\s+/).filter((part) => part.length > 0);
  const sub = args[0];

  try {
    if (sub === undefined) {
      showProviderManager(host);
      return;
    }
    if (sub === 'list') {
      await renderProviderList(host);
      return;
    }
    if (sub === 'add') {
      await addProviderFromCatalog(host, args[1]);
      return;
    }
    if (sub === 'add-registry') {
      await addProviderFromRegistry(host, args[1], args[2]);
      return;
    }
    if (sub === 'remove') {
      const id = args[1];
      if (id === undefined) {
        host.showError('Usage: /provider remove <id>');
        return;
      }
      await removeProviderFromConfig(host.harness.config, id);
      host.refreshAvailableModels();
      host.showStatus(`Removed provider: ${id}`);
      return;
    }
    if (sub === 'set-default') {
      const alias = args[1];
      if (alias === undefined) {
        host.showError('Usage: /provider set-default <provider/model>');
        return;
      }
      await setDefaultModel(host, alias);
      return;
    }
    host.showError(`Unknown /provider action: ${sub}. Run /provider to manage interactively.`);
  } catch (error) {
    host.showError(`/provider ${sub} failed: ${formatErrorMessage(error)}`);
  }
}

async function renderProviderList(host: SlashCommandHost): Promise<void> {
  const providers = providerSection(host.harness.config);
  const ids = Object.keys(providers).toSorted();
  if (ids.length === 0) {
    host.showStatus('No providers configured. Run /login or /provider add.');
    return;
  }
  const lines = ids.map((id) => {
    const cfg = providers[id];
    const baseUrl =
      typeof cfg === 'object' && cfg !== null && 'baseUrl' in cfg && typeof cfg.baseUrl === 'string'
        ? cfg.baseUrl
        : '';
    return `  ${id}${baseUrl.length > 0 ? ` — ${baseUrl}` : ''}`;
  });
  host.showStatus(['Configured providers:', ...lines].join('\n'));
}

function buildProviderManagerOptions(host: SlashCommandHost): ProviderManagerOptions {
  const activeProviderId =
    host.state.appState.availableModels[host.state.appState.model]?.provider;
  return {
    providers: providerSection(host.harness.config),
    activeProviderId,
    onAdd: () => {
      void handleProviderAdd(host).catch((error: unknown) => {
        host.showError(`Add provider failed: ${formatErrorMessage(error)}`);
      });
    },
    onDeleteSource: (providerIds) => {
      void (async () => {
        for (const providerId of providerIds) {
          try {
            await removeProviderFromConfig(host.harness.config, providerId);
          } catch (error) {
            host.showError(`Failed to delete provider ${providerId}: ${formatErrorMessage(error)}`);
          }
        }
        host.refreshAvailableModels();
        reopenProviderManager(host);
      })().catch((error: unknown) => {
        host.showError(`Remove provider failed: ${formatErrorMessage(error)}`);
      });
    },
    onClose: () => {
      host.restoreEditor();
    },
  };
}

function showProviderManager(host: SlashCommandHost): void {
  host.mountEditorReplacement(new ProviderManagerComponent(buildProviderManagerOptions(host)));
}

function reopenProviderManager(host: SlashCommandHost): void {
  host.mountEditorReplacement(new ProviderManagerComponent(buildProviderManagerOptions(host)));
}

async function handleProviderAdd(host: SlashCommandHost): Promise<void> {
  const source = await new Promise<'known' | 'custom' | undefined>((resolve) => {
    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title: 'Add provider',
        options: [
          { value: 'known', label: 'Known third-party provider (models.dev)' },
          { value: 'custom', label: 'Custom registry (api.json)' },
        ],
        onSelect: (value) => {
          host.restoreEditor();
          resolve(value === 'known' || value === 'custom' ? value : undefined);
        },
        onCancel: () => {
          host.restoreEditor();
          resolve(undefined);
        },
      }),
    );
  });
  if (source === undefined) {
    reopenProviderManager(host);
    return;
  }
  if (source === 'known') {
    await addProviderFromCatalog(host, undefined);
    return;
  }
  await addProviderFromRegistry(host, undefined);
}

function resolveModelsDev(host: SlashCommandHost) {
  try {
    return host.harness.app.resolve(ModelsDevRef);
  } catch {
    return undefined;
  }
}

async function addProviderFromCatalog(
  host: SlashCommandHost,
  catalogId: string | undefined,
): Promise<void> {
  const modelsDev = resolveModelsDev(host);
  if (modelsDev === undefined) {
    host.showError('models.dev import is not available in this build.');
    return;
  }

  let id = catalogId;
  if (id === undefined) {
    const spinner = host.showProgressSpinner('Fetching provider catalog from models.dev…');
    let items: readonly ModelsDevProviderItem[];
    try {
      items = await modelsDev.listProviders();
      spinner.stop({ ok: true, label: 'Catalog loaded.' });
    } catch (error) {
      spinner.stop({ ok: false, label: 'Failed to load catalog.' });
      host.showError(`Failed to fetch catalog: ${formatErrorMessage(error)}`);
      return;
    }
    id = await promptCatalogProviderSelection(host, items);
    if (id === undefined) return;
  }

  let item: ModelsDevProviderItem;
  try {
    item = await modelsDev.getProvider(id);
  } catch (error) {
    host.showError(`Provider "${id}" was not found in the catalog: ${formatErrorMessage(error)}`);
    return;
  }
  if (item.rejected) {
    host.showError(`Provider "${id}" cannot be imported: ${item.reject_reason ?? 'unsupported'}.`);
    return;
  }

  let baseUrl: string | undefined;
  if (item.needs_base_url) {
    baseUrl = await promptBaseUrl(host, item.name);
    if (baseUrl === undefined) return;
  }

  const apiKey = await promptApiKey(host, item.name, [
    item.env_key !== null
      ? `The catalog expects the key in $${item.env_key}; the entered key is saved to config.toml.`
      : 'Your key will be saved to ~/.kimi-code/config.toml',
  ]);
  if (apiKey === undefined) return;

  const spinner = host.showProgressSpinner(`Importing ${item.name}…`);
  try {
    const result = await modelsDev.importProvider({
      catalogId: id,
      apiKey: apiKey.length > 0 ? apiKey : undefined,
      baseUrl,
    });
    spinner.stop({ ok: true, label: `Imported ${result.models_imported} models.` });
  } catch (error) {
    spinner.stop({ ok: false, label: 'Import failed.' });
    host.showError(`Failed to import provider: ${formatErrorMessage(error)}`);
    return;
  }

  host.refreshAvailableModels();
  host.hydrateLazyConfigDefaults();
  host.track('connect', { provider: id, method: 'catalog' });
  host.showStatus(`Provider added: ${item.name}. Pick a model via /model.`, 'success');
  if (item.guessed) {
    host.showStatus(
      `Protocol guessed as "openai" for ${id} — edit "type" in config.toml if requests fail.`,
    );
  }
}

async function addProviderFromRegistry(
  host: SlashCommandHost,
  url: string | undefined,
  apiKey?: string,
): Promise<void> {
  const modelsDev = resolveModelsDev(host);
  if (modelsDev === undefined) {
    host.showError('Custom registry import is not available in this build.');
    return;
  }

  let registryUrl = url;
  if (registryUrl === undefined) {
    registryUrl = await promptRegistryUrl(host);
    if (registryUrl === undefined) return;
  }

  const spinner = host.showProgressSpinner(`Importing registry from ${registryUrl}…`);
  try {
    const result = await modelsDev.importRegistry({
      url: registryUrl,
      apiKey: apiKey !== undefined && apiKey.length > 0 ? apiKey : undefined,
    });
    spinner.stop({
      ok: true,
      label: `Imported ${result.providers.length} providers (${result.models_imported} models).`,
    });
  } catch (error) {
    spinner.stop({ ok: false, label: 'Import failed.' });
    host.showError(`Failed to import registry: ${formatErrorMessage(error)}`);
    return;
  }

  host.refreshAvailableModels();
  host.hydrateLazyConfigDefaults();
  host.showStatus('Registry imported. Pick a model via /model.', 'success');
}

async function setDefaultModel(host: SlashCommandHost, alias: string): Promise<void> {
  const defaults = host.harness.app.resolve(ModelDefaultsRef);
  if (defaults === undefined) {
    host.showError('Failed to set default model: model-defaults feature is not installed');
    return;
  }
  try {
    await defaults.setDefaultModel(alias);
  } catch (error) {
    host.showError(`Failed to set default model: ${formatErrorMessage(error)}`);
    return;
  }
  host.refreshAvailableModels();
  host.hydrateLazyConfigDefaults();
  host.showStatus(`Default model set to ${alias}.`, 'success');
}

function promptCatalogProviderSelection(
  host: SlashCommandHost,
  items: readonly ModelsDevProviderItem[],
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const options: ChoiceOption[] = items
      .filter((item) => !item.rejected)
      .map((item) => ({
        value: item.id,
        label: item.name,
        description: item.env_key !== null ? `$${item.env_key}` : undefined,
      }))
      .toSorted((a, b) => a.label.localeCompare(b.label));

    if (options.length === 0) {
      host.showError('Catalog has no providers with supported wire types.');
      resolve(undefined);
      return;
    }

    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title: 'Select a provider',
        options,
        searchable: true,
        onSelect: (value) => {
          host.restoreEditor();
          resolve(value);
        },
        onCancel: () => {
          host.restoreEditor();
          resolve(undefined);
        },
      }),
    );
  });
}

function promptRegistryUrl(host: SlashCommandHost): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dialog = new ApiKeyInputDialogComponent(
      'custom registry',
      ['Enter the registry api.json URL.'],
      (result: ApiKeyInputResult) => {
        host.restoreEditor();
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
      {
        title: 'Enter registry URL',
        mask: false,
        emptyHint: 'Registry URL cannot be empty.',
      },
    );
    host.mountEditorReplacement(dialog);
  });
}

function promptBaseUrl(host: SlashCommandHost, platformName: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dialog = new ApiKeyInputDialogComponent(
      platformName,
      ['The catalog declares no endpoint — enter its base URL.'],
      (result: ApiKeyInputResult) => {
        host.restoreEditor();
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
      {
        title: `Enter base URL for ${platformName}`,
        mask: false,
        emptyHint: 'Base URL cannot be empty.',
      },
    );
    host.mountEditorReplacement(dialog);
  });
}
