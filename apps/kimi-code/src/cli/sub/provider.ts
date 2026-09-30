import { ModelDefaultsRef } from '@moonshot-ai/agent-core';
import { ModelsDevRef, type ModelsDevFace } from '@moonshot-ai/harness-core';
import type { KimiConfigFacade } from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';

import { modelSection, providerSection, removeProviderFromConfig } from '#/utils/provider-config';

import { withSubHarness } from './harness';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface ProviderDeps {
  readonly config: KimiConfigFacade;
  readonly modelsDev: Pick<ModelsDevFace, 'getProvider' | 'importProvider' | 'importRegistry'>;
  readonly setDefaultModel: (alias: string) => Promise<void>;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
}

export async function handleProviderList(
  deps: ProviderDeps,
  opts: { readonly json: boolean },
): Promise<void> {
  const providers = providerSection(deps.config);
  const models = modelSection(deps.config);
  if (opts.json) {
    deps.stdout.write(`${JSON.stringify({ providers, models }, null, 2)}\n`);
    return;
  }
  const ids = Object.keys(providers).toSorted();
  if (ids.length === 0) {
    deps.stdout.write('No providers configured. Run `kimi login` or `kimi provider add`.\n');
    return;
  }
  const counts = new Map<string, number>();
  for (const key of Object.keys(models)) {
    const providerId = key.split('/')[0];
    if (providerId !== undefined) {
      counts.set(providerId, (counts.get(providerId) ?? 0) + 1);
    }
  }
  for (const id of ids) {
    deps.stdout.write(`${id}  models=${String(counts.get(id) ?? 0)}\n`);
  }
  const defaultModel = deps.config.get<string | undefined>('defaultModel');
  if (defaultModel !== undefined) {
    deps.stdout.write(`\nDefault model: ${defaultModel}\n`);
  }
}

export async function handleProviderAdd(
  deps: ProviderDeps,
  catalogId: string,
  opts: { readonly apiKey?: string; readonly baseUrl?: string },
): Promise<void> {
  const apiKey = resolveApiKey(opts.apiKey, deps.env);
  let item;
  try {
    item = await deps.modelsDev.getProvider(catalogId);
  } catch (error) {
    deps.stderr.write(
      `Provider "${catalogId}" was not found in the catalog: ${errorMessage(error)}\n`,
    );
    deps.exit(1);
  }
  if (item.rejected) {
    deps.stderr.write(
      `Provider "${catalogId}" cannot be imported: ${item.reject_reason ?? 'unsupported'}.\n`,
    );
    deps.exit(1);
  }
  if (item.needs_base_url && opts.baseUrl === undefined) {
    deps.stderr.write(
      `The catalog does not declare an endpoint for "${catalogId}". Pass --base-url <url>.\n`,
    );
    deps.exit(1);
  }
  try {
    const result = await deps.modelsDev.importProvider({
      catalogId,
      apiKey: apiKey !== undefined && apiKey.length > 0 ? apiKey : undefined,
      baseUrl: opts.baseUrl,
    });
    deps.stdout.write(
      `Imported ${item.name} (${result.provider.id}) with ${String(result.models_imported)} model${result.models_imported === 1 ? '' : 's'}. Pick a model via /model or kimi provider set-default.\n`,
    );
    if (item.guessed) {
      deps.stdout.write(
        `Note: protocol guessed as "openai" for ${catalogId}; edit "type" in config.toml if requests fail.\n`,
      );
    }
  } catch (error) {
    deps.stderr.write(`Failed to import provider: ${errorMessage(error)}\n`);
    deps.exit(1);
  }
}

export async function handleProviderAddRegistry(
  deps: ProviderDeps,
  url: string,
  opts: { readonly apiKey?: string },
): Promise<void> {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    deps.stderr.write('Registry URL is required.\n');
    deps.exit(1);
  }
  const apiKey = resolveApiKey(opts.apiKey, deps.env);
  try {
    const result = await deps.modelsDev.importRegistry({
      url: trimmed,
      apiKey: apiKey !== undefined && apiKey.length > 0 ? apiKey : undefined,
    });
    const count = result.providers.length;
    deps.stdout.write(
      `Imported ${String(count)} provider${count === 1 ? '' : 's'} (${String(result.models_imported)} model${result.models_imported === 1 ? '' : 's'}) from ${trimmed}:\n`,
    );
    for (const provider of result.providers) {
      deps.stdout.write(`  - ${provider.id}\n`);
    }
  } catch (error) {
    deps.stderr.write(`Failed to import registry: ${errorMessage(error)}\n`);
    deps.exit(1);
  }
}

export async function handleProviderRemove(deps: ProviderDeps, providerId: string): Promise<void> {
  const providers = providerSection(deps.config);
  if (providers[providerId] === undefined) {
    deps.stderr.write(`Provider "${providerId}" not found.\n`);
    deps.exit(1);
  }
  await removeProviderFromConfig(deps.config, providerId);
  deps.stdout.write(`Removed provider "${providerId}".\n`);
}

export async function handleProviderSetDefault(deps: ProviderDeps, alias: string): Promise<void> {
  try {
    await deps.setDefaultModel(alias);
    deps.stdout.write(`Default model set to ${alias}.\n`);
  } catch (error) {
    deps.stderr.write(`Failed to set default model: ${errorMessage(error)}\n`);
    deps.exit(1);
  }
}

export function registerProviderCommand(parent: Command, deps?: Partial<ProviderDeps>): void {
  const provider = parent.command('provider').description('Manage LLM providers non-interactively.');

  const run = (action: (resolved: ProviderDeps) => Promise<void>): Promise<void> =>
    withSubHarness(async (harness) => {
      const modelsDev = deps?.modelsDev ?? harness.app.resolve(ModelsDevRef);
      if (modelsDev === undefined) throw new Error('models-dev feature is not installed');
      const resolved: ProviderDeps = {
        config: deps?.config ?? harness.config,
        modelsDev,
        setDefaultModel:
          deps?.setDefaultModel ??
          (async (alias) => {
            const defaults = harness.app.resolve(ModelDefaultsRef);
            if (defaults === undefined) throw new Error('model-defaults feature is not installed');
            await defaults.setDefaultModel(alias);
          }),
        env: deps?.env ?? process.env,
        stdout: deps?.stdout ?? process.stdout,
        stderr: deps?.stderr ?? process.stderr,
        exit: deps?.exit ?? ((code: number) => process.exit(code)),
      };
      await action(resolved);
    });

  provider
    .command('list')
    .description('Show configured providers and their model counts.')
    .option('--json', 'Emit the raw providers/models config as JSON.', false)
    .action(async (options: { json?: boolean }) => {
      await run((resolved) => handleProviderList(resolved, { json: options.json === true }));
    });

  provider
    .command('add <catalogId>')
    .description('Import a known provider from the models.dev catalog by id.')
    .option('--api-key <key>', 'API key for the provider. Falls back to KIMI_REGISTRY_API_KEY.')
    .option('--base-url <url>', 'Override the catalog endpoint. Required when the catalog declares none.')
    .action(async (catalogId: string, options: { apiKey?: string; baseUrl?: string }) => {
      await run((resolved) =>
        handleProviderAdd(resolved, catalogId, {
          apiKey: options.apiKey,
          baseUrl: options.baseUrl,
        }),
      );
    });

  provider
    .command('add-registry <url>')
    .description('Import every provider listed in a custom registry (api.json).')
    .option(
      '--api-key <key>',
      'Registry API key. Falls back to KIMI_REGISTRY_API_KEY; omit both for public registries.',
    )
    .action(async (url: string, options: { apiKey?: string }) => {
      await run((resolved) => handleProviderAddRegistry(resolved, url, { apiKey: options.apiKey }));
    });

  provider
    .command('remove <providerId>')
    .description('Remove a provider and every model alias that referenced it.')
    .action(async (providerId: string) => {
      await run((resolved) => handleProviderRemove(resolved, providerId));
    });

  provider
    .command('set-default <alias>')
    .description('Set default_model to a configured provider/model alias.')
    .action(async (alias: string) => {
      await run((resolved) => handleProviderSetDefault(resolved, alias));
    });
}

function resolveApiKey(flag: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof flag === 'string' && flag.length > 0) return flag;
  const fromEnv = env['KIMI_REGISTRY_API_KEY'];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
