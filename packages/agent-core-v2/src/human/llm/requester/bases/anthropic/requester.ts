import type Anthropic from '@anthropic-ai/sdk';

import type { ProtocolBase } from '#/llm/protocol/base';
import type { ProviderConnection } from '#/llm/protocol/connection';
import type {
  LlmClientContext,
  LlmErrorClassifier,
  LlmRequester,
} from '#/llm/requester/requester';
import { createRunRequester } from '#/llm/requester/run';

import { getAnthropicModelCapability } from './capability';
import { anthropicProtocol } from './protocol';
import type { AnthropicTrait } from './trait';

export interface AnthropicRequesterOptions {
  readonly connection?: ProviderConnection;
  readonly classifyError?: LlmErrorClassifier;
  readonly clientFactory?: (request: LlmClientContext) => Anthropic;
  readonly betaApi?: boolean;
}

export function createAnthropicRequester(options?: AnthropicRequesterOptions): LlmRequester {
  return createRunRequester(anthropicProtocol, {
    connection: options?.connection,
    classifyError: options?.classifyError,
    clientFactory: options?.clientFactory,
    options: (config) => ({
      betaApi: options?.betaApi === true || config.model.betaApi === true ? true : undefined,
      extras: config.extraParams?.anthropic,
    }),
  });
}

export function createAnthropicBase(options?: {
  betaApi?: boolean;
}): ProtocolBase<AnthropicTrait> {
  return {
    capability: getAnthropicModelCapability,
    createRequester: (requesterOptions) =>
      createAnthropicRequester({ ...options, ...requesterOptions }),
  };
}

export const anthropicBase: ProtocolBase<AnthropicTrait> = createAnthropicBase();

export const anthropicBetaBase: ProtocolBase<AnthropicTrait> = createAnthropicBase({
  betaApi: true,
});
