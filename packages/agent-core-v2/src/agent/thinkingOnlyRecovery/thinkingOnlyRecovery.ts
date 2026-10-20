import { createDecorator } from '#/_base/di/instantiation';

export const THINKING_ONLY_RECOVERY_VARIANT = 'thinking_only_recovery';

export interface IAgentThinkingOnlyRecoveryService {
  readonly _serviceBrand: undefined;
}

export const IAgentThinkingOnlyRecoveryService =
  createDecorator<IAgentThinkingOnlyRecoveryService>('agentThinkingOnlyRecoveryService');
