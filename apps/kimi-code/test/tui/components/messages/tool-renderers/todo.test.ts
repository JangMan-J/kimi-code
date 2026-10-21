import { describe, expect, it } from 'vitest';

import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import {
  formatHiddenCounts,
  selectVisibleTodos,
  type TodoItem,
} from '#/tui/components/messages/tool-renderers/todo';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

const T = (title: string, status: TodoItem['status']): TodoItem => ({ title, status });

function todoCard(todos: readonly TodoItem[] | undefined, isError = false): ToolCallComponent {
  return new ToolCallComponent(
    { id: 'call_todo', name: 'TodoList', args: todos === undefined ? {} : { todos } },
    { tool_call_id: 'call_todo', output: 'Todo list updated', is_error: isError },
  );
}

function cardLines(card: ToolCallComponent): string[] {
  return card
    .render(80)
    .map((line) => strip(line).trimEnd())
    .filter((line) => line.length > 0);
}

describe('TodoList card', () => {
  it('shows every item of a short list and has nothing to expand', () => {
    const card = todoCard([T('Read the code', 'done'), T('Fix it', 'in_progress'), T('Test', 'pending')]);
    expect(cardLines(card).slice(1)).toEqual(['  ✓ Read the code', '  ● Fix it', '  ○ Test']);
    expect(card.hasHiddenContent()).toBe(false);
  });

  it('shows two items plus a summary of the rest when collapsed, and every item when expanded', () => {
    const card = todoCard([
      T('d1', 'done'),
      T('ip', 'in_progress'),
      T('p1', 'pending'),
      T('p2', 'pending'),
      T('p3', 'pending'),
    ]);
    expect(cardLines(card).slice(1)).toEqual([
      '  ✓ d1',
      '  ● ip',
      '  … +3 more (3 pending) · ctrl+o to expand',
    ]);
    expect(card.hasHiddenContent()).toBe(true);

    card.setExpanded(true);
    expect(cardLines(card).slice(1)).toEqual(['  ✓ d1', '  ● ip', '  ○ p1', '  ○ p2', '  ○ p3']);
  });

  it('keeps only the headline for a read-only call and for a failed call', () => {
    expect(cardLines(todoCard(undefined))).toHaveLength(1);
    expect(cardLines(todoCard([T('a', 'pending')], true)).join('\n')).not.toContain('○ a');
  });
});

describe('selectVisibleTodos', () => {
  it('keeps a list of up to three items whole', () => {
    const todos = [T('a', 'done'), T('b', 'in_progress'), T('c', 'pending')];
    expect(selectVisibleTodos(todos)).toEqual({
      rows: todos,
      hidden: 0,
      hiddenCounts: { done: 0, in_progress: 0, pending: 0 },
    });
  });

  it('pairs the in-progress item with the latest done item', () => {
    const todos = [T('d1', 'done'), T('d2', 'done'), T('ip', 'in_progress'), T('p1', 'pending')];
    const { rows, hidden, hiddenCounts } = selectVisibleTodos(todos);
    expect(rows.map((r) => r.title)).toEqual(['d2', 'ip']);
    expect(hidden).toBe(2);
    expect(hiddenCounts).toEqual({ done: 1, in_progress: 0, pending: 1 });
  });

  it('fills with the earliest pending items when nothing is done', () => {
    const todos = [T('ip', 'in_progress'), T('p1', 'pending'), T('p2', 'pending'), T('p3', 'pending')];
    expect(selectVisibleTodos(todos).rows.map((r) => r.title)).toEqual(['ip', 'p1']);
  });

  it('shows the latest done and the earliest pending item without an in-progress item', () => {
    const todos = [T('p0', 'pending'), T('d0', 'done'), T('p1', 'pending'), T('d1', 'done')];
    expect(selectVisibleTodos(todos).rows.map((r) => r.title)).toEqual(['p0', 'd1']);
  });

  it('shows the last two items of an all-done list', () => {
    const todos = Array.from({ length: 5 }, (_, i) => T(`d${String(i)}`, 'done'));
    expect(selectVisibleTodos(todos).rows.map((r) => r.title)).toEqual(['d3', 'd4']);
  });

  it('caps in-progress items at two, keeping the earliest', () => {
    const todos = Array.from({ length: 5 }, (_, i) => T(`ip${String(i)}`, 'in_progress'));
    const { rows, hiddenCounts } = selectVisibleTodos(todos);
    expect(rows.map((r) => r.title)).toEqual(['ip0', 'ip1']);
    expect(hiddenCounts).toEqual({ done: 0, in_progress: 3, pending: 0 });
  });
});

describe('formatHiddenCounts', () => {
  it('formats all three statuses in done / in progress / pending order', () => {
    expect(formatHiddenCounts({ done: 2, in_progress: 1, pending: 3 })).toBe(
      '2 done · 1 in progress · 3 pending',
    );
  });

  it('omits zero-count statuses', () => {
    expect(formatHiddenCounts({ done: 5, in_progress: 0, pending: 0 })).toBe('5 done');
    expect(formatHiddenCounts({ done: 0, in_progress: 0, pending: 0 })).toBe('');
  });
});
