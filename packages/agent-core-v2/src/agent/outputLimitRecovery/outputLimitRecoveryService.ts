import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentLoopService, type AfterStepContext } from '#/agent/loop/loop';
import type { LlmOutputLimitRecoveryEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { Error2, ErrorCodes } from '#/errors';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';
import { isThinkOnlyMessage } from '#human/llm/empty-response';

import {
  IAgentOutputLimitRecoveryService,
  OUTPUT_LIMIT_RECOVERY_VARIANT,
} from './outputLimitRecovery';

const MAX_OUTPUT_LIMIT_RECOVERIES = 3;
const OUTPUT_LIMIT_RECOVERY_REMINDER = [
  'Output token limit hit while you were still reasoning, before this response produced any text or tool call.',
  'That reasoning was not kept and is not part of this conversation, so there is nothing to resume.',
  'Continue from the conversation above: reason much more briefly and produce your answer or next tool call well within the output limit.',
].join(' ');
const OUTPUT_LIMIT_EXHAUSTED_MESSAGE =
  'The model hit the output token limit while still reasoning on every attempt and produced no answer. Lower the thinking effort or raise the output token limit.';

export class AgentOutputLimitRecoveryService
  extends Disposable
  implements IAgentOutputLimitRecoveryService
{
  declare readonly _serviceBrand: undefined;

  private consecutiveRecoveries = 0;

  constructor(
    @IAgentLoopService private readonly loop: IAgentLoopService,
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
    if (ctx.firstStepOfTurn) this.consecutiveRecoveries = 0;
    if (
      ctx.finishReason !== 'truncated' ||
      ctx.message === undefined ||
      !isThinkOnlyMessage(ctx.message)
    ) {
      this.consecutiveRecoveries = 0;
      return;
    }
    const snapshot = this.loop.snapshot();
    if (snapshot.hasPendingRequests && snapshot.queue.length === 0) return;
    if (this.consecutiveRecoveries >= MAX_OUTPUT_LIMIT_RECOVERIES) {
      ctx.failTurn = new Error2(ErrorCodes.AGENT_MAX_TOKENS_EXCEEDED, OUTPUT_LIMIT_EXHAUSTED_MESSAGE);
      this.track(ctx, 'exhausted');
      return;
    }
    this.loop.notify({
      message: {
        role: 'user',
        content: [{ type: 'text', text: wrapSystemReminder(OUTPUT_LIMIT_RECOVERY_REMINDER) }],
        toolCalls: [],
        origin: {
          kind: 'injection',
          variant: OUTPUT_LIMIT_RECOVERY_VARIANT,
          ownerPromptId: snapshot.activePromptId,
        },
      },
      onConsume: () => {
        this.consecutiveRecoveries += 1;
        this.track(ctx, 'nudged');
      },
    });
  }

  private track(ctx: AfterStepContext, action: LlmOutputLimitRecoveryEvent['action']): void {
    const properties: LlmOutputLimitRecoveryEvent = {
      turn_id: ctx.turnId,
      step_no: ctx.step,
      action,
      attempt: this.consecutiveRecoveries,
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
