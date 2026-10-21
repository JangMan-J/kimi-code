import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService, type Turn } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { OUTPUT_LIMIT_RECOVERY_VARIANT } from '#/agent/outputLimitRecovery/outputLimitRecovery';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { ExecutableTool } from '#/tool/toolContract';
import type { ToolCall } from '#human/llm/message';

import { createTestAgent, type TestAgentContext } from '../../harness';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { submitPromptTurn } from '../loop/stubs';

describe('output-limit recovery', () => {
  let ctx: TestAgentContext;
  let loop: IAgentLoopService;
  let profile: IAgentProfileService;
  let records: TelemetryRecord[];

  beforeEach(async () => {
    records = [];
    ctx = createTestAgent({
      telemetry: recordingTelemetry(records),
    });
    await ctx.restorePersisted();
    loop = ctx.get(IAgentLoopService);
    profile = ctx.get(IAgentProfileService);
    profile.update({ activeToolNames: [] });
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  function recoveryInjections(): ContextMessage[] {
    return ctx.context
      .get()
      .filter(
        (message) =>
          message.origin?.kind === 'injection' &&
          message.origin.variant === OUTPUT_LIMIT_RECOVERY_VARIANT,
      );
  }

  function textOf(message: ContextMessage | undefined): string {
    return (message?.content ?? [])
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
  }

  function truncatedText(text: string, traceId?: string) {
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text }],
      finishReason: 'truncated',
      rawFinishReason: 'length',
      traceId,
    });
  }

  it('continues partial visible output with the reminder and preserved history', async () => {
    truncatedText('partial answer');
    ctx.mockNextResponse({ type: 'text', text: 'completed answer' });

    const { turn } = submitTurn(loop, 'Hello');
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    await expect(turn.result).resolves.toEqual({ type: 'completed', steps: 2, truncated: false });
    const history = ctx.llmCalls[1]!.history;
    expect(history.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(history.at(-2)?.content).toMatchObject([{ type: 'text', text: 'partial answer' }]);
    expect(textOf(history.at(-1) as ContextMessage | undefined)).toBe(
      '<system-reminder>\n' +
        'Your previous response was cut off by the output token limit. Continue exactly where it stopped, without repeating or summarizing what you already wrote. If much work remains, split it into smaller pieces.' +
        '\n</system-reminder>',
    );
    expect(recoveryInjections()).toHaveLength(1);
  });

  it('leaves think-only truncation to the empty-response retry', async () => {
    ctx.mockNextProviderResponse({
      parts: [{ type: 'think', think: 'unfinished thought' }],
      finishReason: 'truncated',
      rawFinishReason: 'length',
    });
    ctx.mockNextResponse({ type: 'text', text: 'completed answer' });

    const { turn } = submitTurn(loop, 'Hello');
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    await expect(turn.result).resolves.toEqual({ type: 'completed', steps: 2, truncated: false });
    expect(ctx.llmCalls[1]!.history.map((message) => message.role)).toEqual(['user']);
    expect(recoveryInjections()).toEqual([]);
    expect(records.filter((record) => record.event === 'llm_output_limit_recovery')).toEqual([]);
  });

  it('ends the turn as truncated after three continuations without leaking content', async () => {
    for (let index = 1; index <= 4; index++) {
      truncatedText(`secret partial ${index}`, `trace-output-${index}`);
    }

    const { turn } = submitTurn(loop, 'Hello');
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(4);
    await expect(turn.result).resolves.toEqual({ type: 'completed', steps: 4, truncated: true });
    expect(recoveryInjections()).toHaveLength(3);
    const events = records.filter((record) => record.event === 'llm_output_limit_recovery');
    expect(events.map((event) => event.properties?.['action'])).toEqual([
      'nudged',
      'nudged',
      'nudged',
      'exhausted',
    ]);
    expect(events.map((event) => event.properties?.['attempt'])).toEqual([1, 2, 3, 3]);
    expect(events.map((event) => event.properties?.['step_no'])).toEqual([1, 2, 3, 4]);
    expect(events[0]?.properties).toMatchObject({
      turn_id: 0,
      model: 'mock-model',
      provider_type: 'kimi',
      protocol: 'openai',
      trace_id: 'trace-output-1',
    });
    expect(events[3]?.properties).toMatchObject({ trace_id: 'trace-output-4' });
    for (const event of events) {
      expect(JSON.stringify(event.properties)).not.toContain('secret partial');
    }
  });

  it('allows continuation steps past maxSteps', async () => {
    const local = createTestAgent({
      initialConfig: {
        loopControl: { maxStepsPerTurn: 1 },
      },
    });
    try {
      await local.restorePersisted();
      const localLoop = local.get(IAgentLoopService);
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'partial answer' }],
        finishReason: 'truncated',
        rawFinishReason: 'length',
      });
      local.mockNextResponse({ type: 'text', text: 'completed answer' });

      const { turn } = submitTurn(localLoop, 'Hello');
      await local.untilTurnEnd();

      expect(local.llmCalls).toHaveLength(2);
      await expect(turn.result).resolves.toEqual({ type: 'completed', steps: 2, truncated: false });
    } finally {
      await local.dispose();
    }
  });

  it('resets the continuation count after a step that is not truncated', async () => {
    const lookupCall = registerLookupTool(ctx);
    truncatedText('first partial');
    truncatedText('second partial');
    ctx.mockNextResponse({ type: 'text', text: 'calling a tool' }, lookupCall);
    truncatedText('third partial');
    truncatedText('fourth partial');
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const { turn } = submitTurn(loop, 'Look up mars');
    await ctx.untilApproval(true);
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(6);
    await expect(turn.result).resolves.toEqual({ type: 'completed', steps: 6, truncated: false });
    expect(recoveryInjections()).toHaveLength(4);
  });

  it('lets cancellation take precedence over the queued continuation', async () => {
    loop.hooks.onDidFinishStep.register('test-cancel-turn', async (_hookCtx, next) => {
      loop.cancel();
      await next();
    });
    truncatedText('partial answer');
    ctx.mockNextResponse({ type: 'text', text: 'should not run' });

    const { turn } = submitTurn(loop, 'Hello');
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    const result = await turn.result;
    expect(result.type).toBe('cancelled');
    expect(recoveryInjections()).toEqual([]);
  });
});

function registerLookupTool(agent: TestAgentContext): ToolCall {
  const lookupCall: ToolCall = {
    type: 'function',
    id: 'call_lookup',
    name: 'Lookup',
    arguments: '{"query":"mars"}',
  };
  const lookupTool: ExecutableTool<{ query: string }> = {
    name: 'Lookup',
    description: 'Look up a short test value.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    resolveExecution: () => ({
      approvalRule: 'Lookup',
      execute: async () => ({ output: 'lookup-result' }),
    }),
  };
  agent.get(IAgentProfileService).update({ activeToolNames: ['Lookup'] });
  agent.get(IAgentToolRegistryService).register(lookupTool);
  return lookupCall;
}

function submitTurn(loop: IAgentLoopService, text: string): { readonly turn: Turn } {
  return submitPromptTurn(loop, {
    message: { role: 'user', content: [{ type: 'text', text }] },
    meta: { origin: { kind: 'user' } },
  });
}
