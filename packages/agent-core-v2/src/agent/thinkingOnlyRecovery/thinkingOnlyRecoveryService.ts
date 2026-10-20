import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentLoopService, type AfterStepContext } from '#/agent/loop/loop';
import type { LlmThinkingOnlyResponseEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';
import { isThinkingOnlyMessage } from '#human/llm/message';

import {
  IAgentThinkingOnlyRecoveryService,
  THINKING_ONLY_RECOVERY_VARIANT,
} from './thinkingOnlyRecovery';

const THINKING_ONLY_RECOVERY_REMINDER =
  'Your previous response had no visible output. Continue and produce a user-visible response.';

export class AgentThinkingOnlyRecoveryService
  extends Disposable
  implements IAgentThinkingOnlyRecoveryService
{
  declare readonly _serviceBrand: undefined;

  private nudgedTurnId: number | undefined;

  constructor(
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    this._register(
      loop.hooks.onDidFinishStep.register('thinkingOnlyRecovery', async (ctx, next) => {
        this.recover(ctx);
        await next();
      }),
    );
  }

  private recover(ctx: AfterStepContext): void {
    if (ctx.finishReason !== 'completed') return;
    const message = this.context.get().findLast((entry) => entry.role === 'assistant');
    if (message === undefined || !isThinkingOnlyMessage(message)) return;
    const exhausted = this.nudgedTurnId === ctx.turnId;
    if (!exhausted) {
      this.nudgedTurnId = ctx.turnId;
      this.loop.notify({
        message: {
          role: 'user',
          content: [{ type: 'text', text: wrapSystemReminder(THINKING_ONLY_RECOVERY_REMINDER) }],
          toolCalls: [],
          origin: {
            kind: 'injection',
            variant: THINKING_ONLY_RECOVERY_VARIANT,
            ownerPromptId: this.loop.snapshot().activePromptId,
          },
        },
        bypassMaxSteps: true,
      });
    }
    const properties: LlmThinkingOnlyResponseEvent = {
      turn_id: ctx.turnId,
      step_no: ctx.step,
      action: exhausted ? 'nudge_exhausted' : 'nudged',
      model: this.llmRequester.lastTurnRequest()?.modelAlias,
    };
    this.telemetry.track2('llm_thinking_only_response', properties);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentThinkingOnlyRecoveryService,
  AgentThinkingOnlyRecoveryService,
  ScopeActivation.OnScopeCreated,
  'thinkingOnlyRecovery',
);
