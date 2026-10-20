import { type ToolCall } from '#human/llm/message';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService, type Turn } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { THINKING_ONLY_RECOVERY_VARIANT } from '#/agent/thinkingOnlyRecovery/thinkingOnlyRecovery';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { ExecutableTool } from '#/tool/toolContract';

import { createTestAgent, type TestAgentContext } from '../../harness';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { submitPromptTurn } from '../loop/stubs';

describe('thinking-only recovery', () => {
  let ctx: TestAgentContext;
  let loop: IAgentLoopService;
  let profile: IAgentProfileService;

  beforeEach(async () => {
    ctx = createTestAgent();
    await ctx.restorePersisted();
    loop = ctx.get(IAgentLoopService);
    profile = ctx.get(IAgentProfileService);
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
          message.origin.variant === THINKING_ONLY_RECOVERY_VARIANT,
      );
  }

  function textOf(message: ContextMessage | undefined): string {
    return (message?.content ?? [])
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
  }

  function registerLookupTool(agent: TestAgentContext): ToolCall {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    };
    const lookupTool: ExecutableTool<{ query: string }> = {
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
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

  it('nudges once after a thinking-only step and continues with the reminder in history', async () => {
    profile.update({ activeToolNames: [] });
    ctx.mockNextResponse({ type: 'think', think: 'reasoning only' });
    ctx.mockNextResponse({ type: 'text', text: 'visible answer' });

    const { turn } = submitTurn(loop, 'Hello');
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    await expect(turn.result).resolves.toEqual({
      type: 'completed',
      steps: 2,
      truncated: false,
    });

    const history = ctx.llmCalls[1]!.history;
    expect(history.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    const assistant = history.at(-2);
    expect(assistant?.content).toMatchObject([{ type: 'think', think: 'reasoning only' }]);
    const reminder = history.at(-1);
    const reminderText = textOf(reminder as ContextMessage | undefined);
    expect(reminderText).toBe(
      '<system-reminder>\n' +
        'Your previous response had no visible output. Continue and produce a user-visible response.' +
        '\n</system-reminder>',
    );
    expect(reminderText.toLowerCase()).not.toContain('tool');

    expect(recoveryInjections()).toHaveLength(1);
    expect(recoveryInjections()[0]?.origin).toMatchObject({
      kind: 'injection',
      variant: THINKING_ONLY_RECOVERY_VARIANT,
    });
  });

  it('stops after a second thinking-only response and completes the turn', async () => {
    profile.update({ activeToolNames: [] });
    ctx.mockNextResponse({ type: 'think', think: 'first thought' });
    ctx.mockNextResponse({ type: 'think', think: 'second thought' });

    const { turn } = submitTurn(loop, 'Hello');
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    await expect(turn.result).resolves.toEqual({
      type: 'completed',
      steps: 2,
      truncated: false,
    });

    const messages = ctx.context.get();
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(messages[1]?.content).toMatchObject([{ type: 'think', think: 'first thought' }]);
    expect(messages[3]?.content).toMatchObject([{ type: 'think', think: 'second thought' }]);
    expect(recoveryInjections()).toHaveLength(1);
  });

  it('nudges once per user turn across independent turns', async () => {
    profile.update({ activeToolNames: [] });
    ctx.mockNextResponse({ type: 'think', think: 'turn one thought' });
    ctx.mockNextResponse({ type: 'text', text: 'turn one answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first' }] });
    await ctx.untilTurnEnd();

    ctx.mockNextResponse({ type: 'think', think: 'turn two thought' });
    ctx.mockNextResponse({ type: 'text', text: 'turn two answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(4);
    for (const index of [1, 3]) {
      const last = ctx.llmCalls[index]!.history.at(-1);
      expect(last?.role).toBe('user');
      expect(textOf(last as ContextMessage | undefined)).toContain(
        'Continue and produce a user-visible response.',
      );
    }
    expect(recoveryInjections()).toHaveLength(2);
  });

  it('does not nudge when the first response pairs thinking with a tool call', async () => {
    const lookupCall = registerLookupTool(ctx);
    ctx.mockNextResponse({ type: 'think', think: 'checking' }, lookupCall);
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const { turn } = submitTurn(loop, 'Look up moon');
    await ctx.untilApproval(true);
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    await expect(turn.result).resolves.toEqual({
      type: 'completed',
      steps: 2,
      truncated: false,
    });
    expect(recoveryInjections()).toEqual([]);
  });

  it('keeps the filtered failure path for a thinking-only response without nudging', async () => {
    profile.update({ activeToolNames: [] });
    ctx.mockNextProviderResponse({
      parts: [{ type: 'think', think: 'blocked thought' }],
      finishReason: 'filtered',
    });

    const { turn } = submitTurn(loop, 'Hello');
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    const result = await turn.result;
    expect(result.type).toBe('failed');
    expect(recoveryInjections()).toEqual([]);
  });

  it('allows exactly one recovery step past maxSteps after a thinking-only response', async () => {
    const local = createTestAgent({ initialConfig: { loopControl: { maxStepsPerTurn: 1 } } });
    try {
      await local.restorePersisted();
      const localLoop = local.get(IAgentLoopService);
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      local.mockNextResponse({ type: 'think', think: 'reasoning only' });
      local.mockNextResponse({ type: 'text', text: 'visible answer' });

      const { turn } = submitTurn(localLoop, 'Hello');
      await local.untilTurnEnd();

      expect(local.llmCalls).toHaveLength(2);
      await expect(turn.result).resolves.toEqual({
        type: 'completed',
        steps: 2,
        truncated: false,
      });
    } finally {
      await local.dispose();
    }
  });

  it('keeps the step limit in force after the recovery step', async () => {
    const local = createTestAgent({ initialConfig: { loopControl: { maxStepsPerTurn: 1 } } });
    try {
      await local.restorePersisted();
      const localLoop = local.get(IAgentLoopService);
      const lookupCall = registerLookupTool(local);
      local.mockNextResponse({ type: 'think', think: 'reasoning only' });
      local.mockNextResponse({ type: 'text', text: 'calling a tool' }, lookupCall);
      local.mockNextResponse({ type: 'text', text: 'should not run' });

      const { turn } = submitTurn(localLoop, 'Hello');
      await local.untilApproval(true);
      await local.untilTurnEnd();

      expect(local.llmCalls).toHaveLength(2);
      const result = await turn.result;
      expect(result.type).toBe('failed');
      if (result.type === 'failed') {
        expect((result.error as { code?: unknown })?.code).toBe('loop.max_steps_exceeded');
      }
    } finally {
      await local.dispose();
    }
  });

  it('lets cancellation take precedence over the queued recovery', async () => {
    profile.update({ activeToolNames: [] });
    loop.hooks.onDidFinishStep.register('test-cancel-turn', async (_hookCtx, next) => {
      loop.cancel();
      await next();
    });
    ctx.mockNextResponse({ type: 'think', think: 'reasoning only' });
    ctx.mockNextResponse({ type: 'text', text: 'should not run' });

    const { turn } = submitTurn(loop, 'Hello');
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    const result = await turn.result;
    expect(result.type).toBe('cancelled');
    expect(recoveryInjections()).toEqual([]);
  });
});

describe('thinking-only recovery telemetry', () => {
  it('reports nudged then nudge_exhausted with turn, step, model and trace fields', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      const localLoop = local.get(IAgentLoopService);
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      local.mockNextProviderResponse({
        parts: [{ type: 'think', think: 'secret thought one' }],
        traceId: 'trace-think-1',
      });
      local.mockNextProviderResponse({
        parts: [{ type: 'think', think: 'secret thought two' }],
        traceId: 'trace-think-2',
      });

      const { turn } = submitTurn(localLoop, 'Hello');
      await local.untilTurnEnd();

      expect(local.llmCalls).toHaveLength(2);
      await expect(turn.result).resolves.toMatchObject({ type: 'completed' });
      const events = records.filter((record) => record.event === 'llm_thinking_only_response');
      expect(events).toHaveLength(2);
      expect(events[0]?.properties).toMatchObject({
        turn_id: 0,
        step_no: 1,
        action: 'nudged',
        agent_id: 'main',
        model: 'mock-model',
        provider_type: 'kimi',
        protocol: 'openai',
        trace_id: 'trace-think-1',
      });
      expect(events[1]?.properties).toMatchObject({
        turn_id: 0,
        step_no: 2,
        action: 'nudge_exhausted',
        model: 'mock-model',
        trace_id: 'trace-think-2',
      });
      for (const event of events) {
        expect(JSON.stringify(event.properties)).not.toContain('secret thought');
      }
    } finally {
      await local.dispose();
    }
  });
});

function submitTurn(loop: IAgentLoopService, text: string): { readonly turn: Turn } {
  return submitPromptTurn(loop, {
    message: { role: 'user', content: [{ type: 'text', text }] },
    meta: { origin: { kind: 'user' } },
  });
}
