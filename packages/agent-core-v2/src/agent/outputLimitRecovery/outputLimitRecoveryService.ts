import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentLoopService, type AfterStepContext } from '#/agent/loop/loop';
import type { LlmOutputLimitRecoveryEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';

import {
  IAgentOutputLimitRecoveryService,
  OUTPUT_LIMIT_RECOVERY_VARIANT,
} from './outputLimitRecovery';

const MAX_OUTPUT_LIMIT_RECOVERIES = 3;
const OUTPUT_LIMIT_RECOVERY_REMINDER = [
  'Your previous response was cut off by the output token limit.',
  'Continue exactly where it stopped, without repeating or summarizing what you already wrote.',
  'If much work remains, split it into smaller pieces.',
].join(' ');

export class AgentOutputLimitRecoveryService
  extends Disposable
  implements IAgentOutputLimitRecoveryService
{
  declare readonly _serviceBrand: undefined;

  private turnId: number | undefined;
  private consecutiveTruncations = 0;

  constructor(
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    this._register(
      loop.hooks.onDidFinishStep.register('outputLimitRecovery', async (ctx, next) => {
        this.recover(ctx);
        await next();
      }),
    );
  }

  private recover(ctx: AfterStepContext): void {
    if (ctx.finishReason !== 'truncated') {
      this.consecutiveTruncations = 0;
      return;
    }
    if (this.turnId !== ctx.turnId) {
      this.turnId = ctx.turnId;
      this.consecutiveTruncations = 0;
    }
    if (this.consecutiveTruncations >= MAX_OUTPUT_LIMIT_RECOVERIES) {
      this.track(ctx, 'exhausted');
      return;
    }
    this.consecutiveTruncations += 1;
    this.loop.notify({
      message: {
        role: 'user',
        content: [{ type: 'text', text: wrapSystemReminder(OUTPUT_LIMIT_RECOVERY_REMINDER) }],
        toolCalls: [],
        origin: {
          kind: 'injection',
          variant: OUTPUT_LIMIT_RECOVERY_VARIANT,
          ownerPromptId: this.loop.snapshot().activePromptId,
        },
      },
      bypassMaxSteps: true,
    });
    this.track(ctx, 'nudged');
  }

  private track(ctx: AfterStepContext, action: LlmOutputLimitRecoveryEvent['action']): void {
    const properties: LlmOutputLimitRecoveryEvent = {
      turn_id: ctx.turnId,
      step_no: ctx.step,
      action,
      attempt: this.consecutiveTruncations,
      model: this.llmRequester.lastTurnRequest()?.modelAlias,
    };
    this.telemetry.track2('llm_output_limit_recovery', properties);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentOutputLimitRecoveryService,
  AgentOutputLimitRecoveryService,
  ScopeActivation.OnScopeCreated,
  'outputLimitRecovery',
);
