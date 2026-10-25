/**
 * Scenario: /provider post-add default-model selection, and the
 * `/provider refresh [providerId]` subcommand.
 * Responsibilities: the picked effort is gated for persistence by the model's
 * effective default, and a session-only pick is still applied to the runtime
 * after the config refresh (which only reactivates from persisted values);
 * refresh scopes to one provider when given, reports added/removed/failed,
 * and routes a retired default into the model-migration flow.
 * Wiring: real setDefaultModel / handleProviderCommand with the
 * harness/authFlow boundaries stubbed by a small host rig.
 * Run: pnpm -C apps/kimi-code exec vitest run test/tui/commands/provider.test.ts
 */
import type { ModelAlias, RefreshProviderModelsResponse } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';
import { ProviderManagerComponent } from '#/tui/components/dialogs/provider-manager';
import { handleProviderCommand, setDefaultModel } from '#/tui/commands/provider';
import { handleWireCommand } from '#/tui/commands/wire';

function makeHost(
  options: {
    refreshReachedLiveSession?: boolean;
    activateReachedLiveSession?: boolean;
  } = {},
) {
  const appState = {
    availableModels: {
      // Declares no efforts; the Anthropic profile inference supplies
      // [low, medium, high, xhigh, max] with the default resolved to 'high'.
      opus: {
        provider: 'compatible',
        model: 'claude-opus-4-7',
        maxContextSize: 200_000,
      } as unknown as ModelAlias,
    },
    availableProviders: {
      compatible: { type: 'anthropic' },
    },
  };
  const host = {
    state: { appState },
    waitForSessionAssembly: vi.fn(async () => {}),
    harness: {
      setConfig: vi.fn(async () => ({})),
    },
    authFlow: {
      refreshConfigAfterLogin: vi.fn(async () => options.refreshReachedLiveSession === true),
      activateModelAfterLogin: vi.fn(async () => options.activateReachedLiveSession === true),
    },
    track: vi.fn(),
    showStatus: vi.fn(),
  } as unknown as SlashCommandHost & {
    harness: { setConfig: ReturnType<typeof vi.fn> };
    authFlow: {
      refreshConfigAfterLogin: ReturnType<typeof vi.fn>;
      activateModelAfterLogin: ReturnType<typeof vi.fn>;
    };
    waitForSessionAssembly: ReturnType<typeof vi.fn>;
    track: ReturnType<typeof vi.fn>;
  };
  return { host };
}

describe('setDefaultModel', () => {
  it('applies an above-default pick to the runtime when the gate keeps it session-only', async () => {
    const { host } = makeHost();

    await setDefaultModel(host, 'opus', 'xhigh');

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      defaultModel: 'opus',
      thinking: { enabled: true },
    });
    expect(host.authFlow.activateModelAfterLogin).toHaveBeenCalledWith('opus', 'xhigh');
    // The application must come after the refresh, or the persisted value
    // reactivated by refreshConfigAfterLogin would clobber the pick.
    expect(
      host.authFlow.activateModelAfterLogin.mock.invocationCallOrder[0]!,
    ).toBeGreaterThan(host.authFlow.refreshConfigAfterLogin.mock.invocationCallOrder[0]!);
    // Without a session the engine never sees the pick, so the TUI stays the
    // sole model_switch producer.
    expect(host.track).toHaveBeenCalledWith('model_switch', { model: 'opus' });
  });

  it('does not re-apply the effort when the pick persists', async () => {
    const { host } = makeHost();

    await setDefaultModel(host, 'opus', 'high');

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      defaultModel: 'opus',
      thinking: { enabled: true, effort: 'high' },
    });
    expect(host.authFlow.activateModelAfterLogin).not.toHaveBeenCalled();
  });

  it('does not re-apply a boolean on pick', async () => {
    const { host } = makeHost();

    await setDefaultModel(host, 'opus', 'on');

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      defaultModel: 'opus',
      thinking: { enabled: true },
    });
    expect(host.authFlow.activateModelAfterLogin).not.toHaveBeenCalled();
  });

  it('leaves model_switch to the engine when activation changed the bound alias', async () => {
    const { host } = makeHost({ refreshReachedLiveSession: true });

    await setDefaultModel(host, 'opus', 'high');

    // refreshConfigAfterLogin routed through session.setModel with a changed
    // alias, which the engine already tracks — a TUI-side event would
    // double-count the switch.
    expect(host.track).not.toHaveBeenCalled();
  });

  it('leaves model_switch to the engine when a lazy session came live mid-flow and rebounded', async () => {
    // Session-less at entry, but the first prompt's lazy creation completes
    // while setConfig / the refresh are pending, so the session-only re-apply
    // lands on the now-live session and actually switches its alias (engine
    // emits).
    const { host } = makeHost({ activateReachedLiveSession: true });

    await setDefaultModel(host, 'opus', 'xhigh');

    expect(host.authFlow.activateModelAfterLogin).toHaveBeenCalledWith('opus', 'xhigh');
    expect(host.track).not.toHaveBeenCalled();
  });

  it('emits model_switch when a v1-created session only rebinds the same alias', async () => {
    // v1 session-less + session-only effort: the refresh creates the session
    // with the picked model (creation emits nothing), then the re-apply
    // reaches that live session but its setModel is an alias no-op (no engine
    // event either) — the TUI must stay the producer for the pick.
    const { host } = makeHost({
      refreshReachedLiveSession: false,
      activateReachedLiveSession: false,
    });

    await setDefaultModel(host, 'opus', 'xhigh');

    expect(host.authFlow.activateModelAfterLogin).toHaveBeenCalledWith('opus', 'xhigh');
    expect(host.track).toHaveBeenCalledWith('model_switch', { model: 'opus' });
  });

  it('waits for an in-flight lazy creation before activating (v2)', async () => {
    const { host } = makeHost();

    await setDefaultModel(host, 'opus', 'high');

    expect(host.waitForSessionAssembly).toHaveBeenCalled();
    expect(
      host.waitForSessionAssembly.mock.invocationCallOrder[0]!,
    ).toBeLessThan(host.harness.setConfig.mock.invocationCallOrder[0]!);
  });

  it('skips the follow-up activation and forwards the picked effort when the gate owns the switch', async () => {
    const { host } = makeHost();
    host.authFlow.refreshConfigAfterLogin = vi.fn(async () => 'gated' as const);

    await setDefaultModel(host, 'opus', 'xhigh');

    expect(host.authFlow.refreshConfigAfterLogin).toHaveBeenCalledWith('xhigh');
    expect(host.authFlow.activateModelAfterLogin).not.toHaveBeenCalled();
    expect(host.track).not.toHaveBeenCalled();
  });
});

function makeRefreshHost(result: RefreshProviderModelsResponse | Error) {
  const spinner = { stop: vi.fn() };
  const host = {
    showProgressSpinner: vi.fn(() => spinner),
    showStatus: vi.fn(),
    showError: vi.fn(),
    authFlow: {
      refreshProviderModels: vi.fn(async () => {
        if (result instanceof Error) throw result;
        return result;
      }),
    },
    modelMigration: { retire: vi.fn(async () => {}) },
  } as unknown as SlashCommandHost & {
    showProgressSpinner: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    authFlow: { refreshProviderModels: ReturnType<typeof vi.fn> };
    modelMigration: { retire: ReturnType<typeof vi.fn> };
  };
  return { host, spinner };
}

describe('handleProviderCommand refresh', () => {
  it('refreshes every provider and reports added, removed, and failed', async () => {
    const retired = { from: 'kimi/old', to: 'kimi/new', from_display_name: 'Old Model' };
    const { host, spinner } = makeRefreshHost({
      changed: [{ provider_id: 'kimi', provider_name: 'Kimi Code', added: 2, removed: 1 }],
      unchanged: ['other'],
      failed: [{ provider: 'broken', reason: 'HTTP 500' }],
      retired_default: retired,
    });

    await handleProviderCommand(host, 'refresh');

    expect(host.authFlow.refreshProviderModels).toHaveBeenCalledWith(undefined);
    expect(spinner.stop).toHaveBeenCalledWith({ ok: true, label: 'Refresh finished.' });
    expect(host.showStatus).toHaveBeenCalledWith('Kimi Code: +2 / -1 models.', 'warning');
    expect(host.showStatus).toHaveBeenCalledWith(
      'Skipped refreshing broken: HTTP 500',
      'warning',
    );
    expect(host.modelMigration.retire).toHaveBeenCalledWith(retired);
  });

  it('scopes the refresh to one provider when a providerId is given', async () => {
    const { host } = makeRefreshHost({ changed: [], unchanged: ['custom'], failed: [] });

    await handleProviderCommand(host, 'refresh custom');

    expect(host.authFlow.refreshProviderModels).toHaveBeenCalledWith({
      providerId: 'custom',
    });
  });

  it('reports a plain status when nothing was removed', async () => {
    const { host } = makeRefreshHost({
      changed: [{ provider_id: 'kimi', provider_name: 'Kimi Code', added: 1, removed: 0 }],
      unchanged: [],
      failed: [],
    });

    await handleProviderCommand(host, 'refresh');

    expect(host.showStatus).toHaveBeenCalledWith('Kimi Code: +1 model.', undefined);
    expect(host.modelMigration.retire).not.toHaveBeenCalled();
  });

  it('reports when every provider is already up to date', async () => {
    const { host } = makeRefreshHost({ changed: [], unchanged: ['a', 'b'], failed: [] });

    await handleProviderCommand(host, 'refresh');

    expect(host.showStatus).toHaveBeenCalledWith(
      'No model changes (2 providers up to date).',
    );
  });

  it('surfaces a thrown refresh without routing a retirement', async () => {
    const { host, spinner } = makeRefreshHost(new Error('provider missing does not exist'));

    await handleProviderCommand(host, 'refresh missing');

    expect(spinner.stop).toHaveBeenCalledWith({ ok: false, label: 'Refresh failed.' });
    expect(host.showError).toHaveBeenCalledWith(
      'Failed to refresh models: provider missing does not exist',
    );
    expect(host.modelMigration.retire).not.toHaveBeenCalled();
  });

  it('rejects unknown subcommands with a usage line instead of refreshing', async () => {
    const { host, spinner } = makeRefreshHost({ changed: [], unchanged: [], failed: [] });

    await handleProviderCommand(host, 'refres');

    expect(host.showError).toHaveBeenCalledWith(
      expect.stringContaining('Usage: /provider [en|cn|manage|refresh [providerId]]'),
    );
    expect(host.showProgressSpinner).not.toHaveBeenCalled();
    expect(host.authFlow.refreshProviderModels).not.toHaveBeenCalled();
    expect(spinner.stop).not.toHaveBeenCalled();
  });

  it('reports metadata-only updates without the model counters', async () => {
    const { host } = makeRefreshHost({
      changed: [{ provider_id: 'custom', provider_name: 'Custom Registry', added: 0, removed: 0 }],
      unchanged: [],
      failed: [],
    });

    await handleProviderCommand(host, 'refresh');

    expect(host.showStatus).toHaveBeenCalledWith('Custom Registry: model metadata updated.');
  });

  it('rejects surplus arguments after the provider id instead of refreshing', async () => {
    const { host, spinner } = makeRefreshHost({ changed: [], unchanged: [], failed: [] });

    await handleProviderCommand(host, 'refresh custom unexpected');

    expect(host.showError).toHaveBeenCalledWith('Usage: /provider refresh [providerId]');
    expect(host.authFlow.refreshProviderModels).not.toHaveBeenCalled();
    expect(spinner.stop).not.toHaveBeenCalled();
  });
});

describe('/provider endpoint toggle and /wire', () => {
  const MANAGED = 'managed:kimi-code';

  function makeSwitchHost(baseUrl = 'https://api.kimi.ai/coding/v1', wireProtocol?: string) {
    const mounted: unknown[] = [];
    const config = {
      providers: {
        [MANAGED]: {
          type: 'kimi',
          baseUrl,
          apiKey: '',
          oauth: {
            storage: 'file',
            key: 'oauth/kimi-code-env-0e4f99c69cc27850',
            oauthHost: 'https://auth.kimi.ai',
          },
          ...(wireProtocol === undefined ? {} : { wireProtocol }),
        },
      },
      services: {
        moonshotSearch: { baseUrl: `${baseUrl}/search`, apiKey: '' },
        moonshotFetch: { baseUrl: 'https://search.example.test/fetch', apiKey: 'sk-custom' },
      },
    };
    const setConfig = vi.fn(async (_patch: unknown) => ({} as never));
    const refreshProviderModels = vi.fn(async () => ({
      changed: [],
      unchanged: [MANAGED],
      failed: [],
    }));
    const host = {
      state: {
        appState: {
          streamingPhase: 'idle',
          model: 'k3.1-pro',
          availableModels: {
            'k3.1-pro': { provider: 'managed:kimi-code', model: 'k3.1-pro', maxContextSize: 1 },
          },
          availableProviders: { 'managed:kimi-code': { type: 'kimi' } },
        },
      },
      harness: { getConfig: vi.fn(async () => structuredClone(config)), setConfig },
      authFlow: { refreshProviderModels },
      modelMigration: { retire: vi.fn(async () => {}) },
      mountEditorReplacement: vi.fn((panel: unknown) => {
        mounted.push(panel);
      }),
      restoreEditor: vi.fn(),
      showStatus: vi.fn(),
      showError: vi.fn(),
      showProgressSpinner: vi.fn(() => ({ stop: vi.fn(), setLabel: vi.fn() })),
      track: vi.fn(),
    } as unknown as SlashCommandHost & {
      harness: { setConfig: ReturnType<typeof vi.fn> };
      authFlow: { refreshProviderModels: ReturnType<typeof vi.fn> };
      mountEditorReplacement: ReturnType<typeof vi.fn>;
      showError: ReturnType<typeof vi.fn>;
      showStatus: ReturnType<typeof vi.fn>;
    };
    return { host, setConfig, refreshProviderModels, mounted };
  }

  it('mounts the EN/CN endpoint toggle when /provider has no argument', async () => {
    const { host, mounted, setConfig } = makeSwitchHost();

    await handleProviderCommand(host, '');

    expect(mounted).toHaveLength(1);
    expect(mounted[0]).toBeInstanceOf(ChoicePickerComponent);
    expect(setConfig).not.toHaveBeenCalled();
  });

  it('switches to the mainland endpoint via /provider cn and refreshes models', async () => {
    const { host, setConfig, refreshProviderModels } = makeSwitchHost();

    await handleProviderCommand(host, 'cn');

    expect(setConfig).toHaveBeenCalledTimes(1);
    const patch = setConfig.mock.calls[0]![0] as {
      providers: Record<string, { baseUrl?: string; oauth?: unknown }>;
      services: { moonshotSearch?: { baseUrl?: string }; moonshotFetch?: { baseUrl?: string } };
    };
    expect(patch.providers[MANAGED]?.baseUrl).toBe('https://api.kimi.com/coding/v1');
    expect(patch.providers[MANAGED]?.oauth).toEqual({
      storage: 'file',
      key: 'oauth/kimi-code-env-0e4f99c69cc27850',
      oauthHost: 'https://auth.kimi.ai',
    });
    expect(patch.services.moonshotSearch?.baseUrl).toBe('https://api.kimi.com/coding/v1/search');
    expect(patch.services.moonshotFetch?.baseUrl).toBe('https://search.example.test/fetch');
    expect(refreshProviderModels).toHaveBeenCalledWith({ providerId: MANAGED });
  });

  it('reports already-active endpoints without writing', async () => {
    const { host, setConfig } = makeSwitchHost('https://api.kimi.ai/coding/v1');

    await handleProviderCommand(host, 'en');

    expect(setConfig).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'Kimi Code endpoint is already EN · api.kimi.ai (global).',
    );
  });

  it('keeps the provider manager reachable through /provider manage', async () => {
    const { host, mounted } = makeSwitchHost();

    await handleProviderCommand(host, 'manage');

    expect(mounted).toHaveLength(1);
    expect(mounted[0]).toBeInstanceOf(ProviderManagerComponent);
  });

  it('mounts the wire toggle and applies a protocol from an argument', async () => {
    const { host, mounted, setConfig, refreshProviderModels } = makeSwitchHost();

    await handleWireCommand(host, '');
    expect(mounted[0]).toBeInstanceOf(ChoicePickerComponent);

    await handleWireCommand(host, 'responses');
    const patch = setConfig.mock.calls[0]![0] as {
      providers: Record<string, { wireProtocol?: string }>;
    };
    expect(patch.providers[MANAGED]?.wireProtocol).toBe('responses');
    expect(refreshProviderModels).toHaveBeenCalledWith({ providerId: MANAGED });
  });

  it('rejects an unknown wire protocol', async () => {
    const { host, setConfig } = makeSwitchHost();

    await handleWireCommand(host, 'grpc');

    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('Unknown wire protocol'));
    expect(setConfig).not.toHaveBeenCalled();
  });
});
