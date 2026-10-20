import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { NO_FINISH, type FinishInfo } from '#/llm/finish-reason';
import {
  createMessageAccumulator,
  type AssistantMessage,
  type StreamedMessagePart,
} from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { emptyResponseError, isThinkingOnlyMessage } from '#/llm/empty-response';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

function accumulatedMessage(parts: readonly StreamedMessagePart[]): AssistantMessage {
  const accumulator = createMessageAccumulator();
  for (const part of parts) {
    accumulator.push(part);
  }
  return accumulator.finish();
}

describe('emptyResponseError', () => {
  it('reports an empty response when the stream produced nothing', () => {
    const message = accumulatedMessage([]);
    const error = emptyResponseError(message, model, NO_FINISH);
    expect(error).toMatchObject({
      kind: 'empty_response',
      finishReason: null,
      rawFinishReason: null,
    });
    expect(error?.message).toContain('empty response (no content, no tool calls)');
    expect(error?.message).toContain('Provider: test, model: test-model');

    const filtered = emptyResponseError(message, model, {
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });
    expect(filtered).toMatchObject({
      kind: 'empty_response',
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });
    expect(filtered?.message).toContain('filtered the response');
  });

  it('reports a think-only response but tolerates whitespace text', () => {
    const thinkOnly = accumulatedMessage([{ type: 'think', think: 'reasoning' }]);
    const error = emptyResponseError(thinkOnly, model, NO_FINISH);
    expect(error?.kind).toBe('empty_response');
    expect(error?.message).toContain('only thinking content');

    const whitespace = accumulatedMessage([{ type: 'text', text: '  \n' }]);
    expect(emptyResponseError(whitespace, model, NO_FINISH)).toBeNull();

    const thinkWithWhitespace = accumulatedMessage([
      { type: 'think', think: 'reasoning' },
      { type: 'text', text: ' ' },
    ]);
    expect(emptyResponseError(thinkWithWhitespace, model, NO_FINISH)?.message).toContain(
      'only thinking content',
    );
  });

  it('returns null when the stream produced text or tool calls', () => {
    expect(
      emptyResponseError(accumulatedMessage([{ type: 'text', text: 'hi' }]), model, NO_FINISH),
    ).toBeNull();
    expect(
      emptyResponseError(
        accumulatedMessage([
          { type: 'think', think: 'reasoning' },
          { type: 'text', text: 'hi' },
        ]),
        model,
        NO_FINISH,
      ),
    ).toBeNull();
    expect(
      emptyResponseError(
        accumulatedMessage([{ type: 'function', id: 'call_1', name: 'tool', arguments: '{}' }]),
        model,
        NO_FINISH,
      ),
    ).toBeNull();
  });

  it('keeps reporting a completed think-only response under the default policy', () => {
    const thinkOnly = accumulatedMessage([{ type: 'think', think: 'reasoning' }]);
    const completed: FinishInfo = { finishReason: 'completed', rawFinishReason: 'stop' };
    const error = emptyResponseError(thinkOnly, model, completed);
    expect(error?.kind).toBe('empty_response');
    expect(error?.message).toContain('only thinking content');
  });

  it('tolerates a completed think-only response when the policy allows it', () => {
    const thinkOnly = accumulatedMessage([{ type: 'think', think: 'reasoning' }]);
    const completed: FinishInfo = { finishReason: 'completed', rawFinishReason: 'stop' };
    expect(emptyResponseError(thinkOnly, model, completed, true)).toBeNull();
  });

  it('still reports think-only responses with abnormal or missing finish under the allow policy', () => {
    const thinkOnly = accumulatedMessage([{ type: 'think', think: 'reasoning' }]);
    const finishes: FinishInfo[] = [
      { finishReason: 'truncated', rawFinishReason: 'length' },
      { finishReason: 'filtered', rawFinishReason: 'content_filter' },
      { finishReason: 'paused', rawFinishReason: 'pause' },
      { finishReason: 'other', rawFinishReason: 'other' },
      NO_FINISH,
    ];
    for (const finish of finishes) {
      expect(emptyResponseError(thinkOnly, model, finish, true)?.kind).toBe('empty_response');
    }
  });

  it('returns null for thinking with text or tool calls under the allow policy', () => {
    const completed: FinishInfo = { finishReason: 'completed', rawFinishReason: 'stop' };
    expect(
      emptyResponseError(
        accumulatedMessage([
          { type: 'think', think: 'reasoning' },
          { type: 'text', text: 'hi' },
        ]),
        model,
        completed,
        true,
      ),
    ).toBeNull();
    expect(
      emptyResponseError(
        accumulatedMessage([
          { type: 'think', think: 'reasoning' },
          { type: 'function', id: 'call_1', name: 'tool', arguments: '{}' },
        ]),
        model,
        completed,
        true,
      ),
    ).toBeNull();
  });

  it('identifies thinking-only messages with the shared predicate', () => {
    expect(
      isThinkingOnlyMessage(accumulatedMessage([{ type: 'think', think: 'reasoning' }])),
    ).toBe(true);
    expect(
      isThinkingOnlyMessage(
        accumulatedMessage([
          { type: 'think', think: 'reasoning' },
          { type: 'text', text: ' ' },
        ]),
      ),
    ).toBe(true);
    expect(
      isThinkingOnlyMessage(
        accumulatedMessage([
          { type: 'think', think: 'reasoning' },
          { type: 'text', text: 'hi' },
        ]),
      ),
    ).toBe(false);
    expect(
      isThinkingOnlyMessage(
        accumulatedMessage([
          { type: 'think', think: 'reasoning' },
          { type: 'function', id: 'call_1', name: 'tool', arguments: '{}' },
        ]),
      ),
    ).toBe(false);
    expect(isThinkingOnlyMessage(accumulatedMessage([{ type: 'text', text: 'hi' }]))).toBe(false);
    expect(isThinkingOnlyMessage(accumulatedMessage([]))).toBe(false);
  });
});
