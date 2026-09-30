import {
  AgentModelRef,
  ModelDefaultsRef,
  type AgentHandle,
} from '@moonshot-ai/agent-core';
import type { KimiHarness, KimiSession } from '@moonshot-ai/kimi-code-sdk';

import {
  OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE,
} from '../constant/kimi-tui';
import { thinkingEffortFromConfig } from '../utils/thinking-config';
import type { AppState, KimiTUIOptions, ThinkingEffort } from '../types';
import type { TUIState } from '../tui-state';

export interface AuthFlowHost {
  session: KimiSession | undefined;
  readonly harness: KimiHarness;
  readonly options: KimiTUIOptions;
  readonly state: TUIState;
  mainAgent(): AgentHandle | undefined;

  setAppState(patch: Partial<AppState>): void;
  setStartupReady(): void;
  resetSessionRuntime(): void;
  appendStartupNotice(extra: string): void;
  hydrateLazyConfigDefaults(): void;
  refreshAvailableModels(): void;
}

export class AuthFlowController {
  constructor(private readonly host: AuthFlowHost) {}

  enterLoginRequiredStartupState(): void {
    this.host.resetSessionRuntime();
    this.host.setAppState({
      sessionId: '',
      model: '',
      thinkingEffort: 'off',
      contextTokens: 0,
      maxContextTokens: 0,
      contextUsage: 0,
      sessionTitle: null,
    });
    this.host.appendStartupNotice(OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE);
    this.host.setStartupReady();
  }

  /**
   * Apply a model pick to the runtime. Returns whether the activation
   * reached an already-live session. `false` when no live session existed
   * (session creation is deferred to the first prompt), so callers mirroring
   * the engine's telemetry must stay the producer for exactly those paths.
   */
  async activateModelAfterLogin(model: string, effort?: string): Promise<boolean> {
    const { host } = this;
    const main = host.mainAgent();
    if (main === undefined) {
      // Lazy session creation: configure the persisted defaults only; the
      // session is created on the first message and binds them then.
      await this.persistModelDefaults(model, effort);
      host.setAppState({ model });
      if (effort !== undefined) {
        host.setAppState({ thinkingEffort: effort as ThinkingEffort });
      }
      return false;
    }
    try {
      const agentModel = main.resolve(AgentModelRef);
      if (agentModel === undefined) throw new Error('provider-catalog agent model is not available');
      await agentModel.setModel(model);
      if (effort !== undefined) {
        await agentModel.setThinking(effort);
      }
    } finally {
      await this.persistModelDefaults(model, effort);
    }
    return true;
  }

  private async persistModelDefaults(model: string, effort?: string): Promise<void> {
    const defaults = this.host.harness.app.resolve(ModelDefaultsRef);
    if (defaults === undefined) return;
    try {
      await defaults.setDefaultModel(model);
      if (effort !== undefined) {
        await defaults.setDefaultThinking(effort);
      }
    } catch {
      // Persistence is best-effort: the live switch already happened.
    }
  }

  /**
   * Re-read config and reactivate the persisted model after login or a
   * config-refreshing command. Returns whatever the activation reports (see
   * {@link activateModelAfterLogin}); `false` when no activation ran.
   */
  async refreshConfigAfterLogin(): Promise<boolean> {
    const { host } = this;
    await host.harness.config.reload();
    host.refreshAvailableModels();
    const defaultModel =
      host.options.startup.model ??
      ((): string | undefined => {
        const value = host.harness.config.get<unknown>('defaultModel');
        return typeof value === 'string' && value.length > 0 ? value : undefined;
      })();
    if (defaultModel === undefined) {
      if (host.session === undefined) {
        host.hydrateLazyConfigDefaults();
      }
      return false;
    }
    const effort = thinkingEffortFromConfig(
      host.harness.config.get<{ enabled?: boolean; effort?: string } | undefined>('thinking'),
    );
    const activated = await this.activateModelAfterLogin(defaultModel, effort);
    if (host.session === undefined) {
      host.hydrateLazyConfigDefaults();
      return activated;
    }
    const selected = host.state.appState.availableModels[defaultModel];
    host.setAppState({
      model: defaultModel,
      ...(selected?.maxContextSize !== undefined
        ? { maxContextTokens: selected.maxContextSize }
        : {}),
    });
    return activated;
  }

  async refreshConfigAfterLogout(): Promise<void> {
    await this.host.harness.config.reload();
    this.host.refreshAvailableModels();
    if (this.host.session !== undefined) return;
    this.host.setAppState({
      model: '',
      thinkingEffort: 'off',
      maxContextTokens: 0,
      contextUsage: 0,
      contextTokens: 0,
    });
  }
}
