import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
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
  'Your previous response hit the output token limit while still reasoning, before any answer or tool call was produced.',
  'Keep the remaining reasoning brief, then answer or call a tool directly.',
  'If the task is large, split it into smaller steps.',
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
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
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
    if (this.turnId !== ctx.turnId) {
      this.turnId = ctx.turnId;
      this.consecutiveTruncations = 0;
    }
    if (ctx.finishReason !== 'truncated' || !this.endedWhileReasoning()) {
      this.consecutiveTruncations = 0;
      return;
    }
    if (this.loop.snapshot().hasPendingRequests) return;
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

  private endedWhileReasoning(): boolean {
    const message = this.context.get().findLast((entry) => entry.role === 'assistant');
    return (
      message !== undefined &&
      message.toolCalls.length === 0 &&
      message.content.some((part) => part.type === 'think') &&
      !message.content.some((part) => part.type === 'text' && part.text.trim().length > 0)
    );
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
