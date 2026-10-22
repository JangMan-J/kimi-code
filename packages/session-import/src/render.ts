import type { ConversionIssue, ConversionStats, EffectiveHistory, HistoryStep, ImportMessage } from '#/types';

export const DEFAULT_IMPORT_RATIO = 0.8;

const TOOL_INPUT_LIMIT = 2000;
const TOOL_RESULT_LIMIT = 4000;
const EXCERPT_RESERVE = 64;
const SOURCE_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex' } as const;

export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 127) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

export function estimateMessages(messages: readonly ImportMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message.role)
    + message.content.reduce((count, part) => count + estimateTokens(part.text), 0), 0);
}

interface Unit {
  user: string;
  assistant: string;
  turns: number;
}

interface Excerpt {
  text: string;
  removed: number;
}

function message(role: ImportMessage['role'], text: string): ImportMessage {
  return { role, content: [{ type: 'text', text }] };
}

function imageReferences(text: string): Array<{ start: number; end: number }> {
  return [...text.matchAll(/\[Imported image reference: "(?:\\.|[^"\\])*"; [^\n]*?\]/g)]
    .map(match => ({ start: match.index, end: match.index + match[0].length }));
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit - 3;
  if (/[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--;
  for (const reference of imageReferences(text)) if (end > reference.start && end < reference.end) end = reference.start;
  return `${text.slice(0, end)}...`;
}

function suffixWithinBudget(text: string, budget: number): Excerpt | undefined {
  const references = imageReferences(text);
  let low = 1;
  let high = text.length;
  let best: Excerpt | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    let start = middle;
    for (const reference of references) {
      if (start > reference.start && start < reference.end) start = reference.end;
    }
    if (/[\uDC00-\uDFFF]/.test(text[start] ?? '')) start++;
    const candidate = `[Earlier source text omitted: ${start} characters. See the full history attachment.]\n${text.slice(start)}`;
    if (start < text.length && estimateTokens(candidate) <= budget) {
      best = { text: candidate, removed: start };
      high = middle - 1;
    } else if (start >= text.length) high = middle - 1;
    else low = middle + 1;
  }
  return best;
}

function fit(text: string, budget: number): Excerpt | undefined {
  return estimateTokens(text) <= budget ? { text, removed: 0 } : suffixWithinBudget(text, budget);
}

function inputFields(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function toolCall(step: HistoryStep): string {
  const input = inputFields(step.text);
  const fields = [['description', input?.['description']], ['command', input?.['command'] ?? input?.['cmd']], ['file', input?.['file_path'] ?? input?.['file']]] as const;
  const lines = fields.flatMap(([label, value]) => typeof value === 'string' ? [`${label}: ${clip(value, TOOL_INPUT_LIMIT)}`] : []);
  if (lines.length === 0 && step.text) lines.push(`input: ${clip(step.text, TOOL_INPUT_LIMIT)}`);
  return [`[external_agent_tool_call: ${step.name ?? 'unknown'}]`, ...lines, '[/external_agent_tool_call]'].join('\n');
}

function toolResult(step: HistoryStep): string {
  const item = step.metadata?.['item'];
  const details = item !== null && typeof item === 'object' ? item as { is_error?: unknown } : undefined;
  const error = (step.metadata?.['isError'] ?? step.metadata?.['is_error'] ?? details?.is_error) === true;
  return [`[external_agent_tool_result${error ? ': error' : ''}]`, ...step.text ? [clip(step.text, TOOL_RESULT_LIMIT)] : [], '[/external_agent_tool_result]'].join('\n');
}

function answer(steps: readonly HistoryStep[]): string {
  return steps.flatMap((step) => {
    if (step.beforeUser) return [];
    if (step.kind === 'assistant') return [step.text];
    if (step.kind === 'tool_call') return [toolCall(step)];
    if (step.kind === 'tool_result') return [toolResult(step)];
    return [];
  }).filter(text => text.trim()).join('\n\n');
}

function units(history: EffectiveHistory): Unit[] {
  const result: Unit[] = history.summary?.trim() ? [{ user: history.summary, assistant: '', turns: 0 }] : [];
  let unattached = 0;
  for (const turn of history.turns) {
    const reply = answer(turn.steps);
    const previous = result.at(-1);
    if (turn.user.trim()) {
      result.push({ user: turn.user, assistant: reply, turns: unattached + 1 });
      unattached = 0;
    } else if (previous) {
      previous.assistant = [previous.assistant, reply].filter(Boolean).join('\n\n');
      previous.turns++;
    } else unattached++;
  }
  return result;
}

function messagesOf(unit: Unit): ImportMessage[] {
  return [message('user', unit.user), ...unit.assistant ? [message('assistant', unit.assistant)] : []];
}

function shorten(unit: Unit, budget: number): { messages: ImportMessage[]; removed: number } | undefined {
  const userCost = estimateMessages([message('user', unit.user)]);
  const keepUser = userCost < budget;
  const reply = unit.assistant ? fit(unit.assistant, (keepUser ? budget - userCost : budget - EXCERPT_RESERVE) - estimateTokens('assistant')) : undefined;
  const replyCost = reply ? estimateMessages([message('assistant', reply.text)]) : 0;
  const user = keepUser ? { text: unit.user, removed: 0 } : suffixWithinBudget(unit.user, budget - replyCost - estimateTokens('user'));
  if (!user) return undefined;
  return {
    messages: [message('user', user.text), ...reply ? [message('assistant', reply.text)] : []],
    removed: user.removed + (reply ? reply.removed : unit.assistant.length),
  };
}

function notice(history: EffectiveHistory, historyPath: string, issues: readonly ConversionIssue[], includedTurns: number, omitted: boolean, shortened: boolean): ImportMessage {
  const title = history.title ? ` ${JSON.stringify(history.title)}` : '';
  const total = history.turns.length;
  const scope = omitted ? `the most recent ${includedTurns} of ${total}; earlier history is omitted here` : `${total} of ${total}`;
  return message('user', [
    '<EXTERNAL SESSION IMPORTED>',
    `The conversation above was imported from the ${SOURCE_NAMES[history.source]} session${title} (${history.sourceId}).`,
    `Included turns: ${scope}${shortened ? '; shortened to fit the context budget' : ''}.`,
    'Tool calls and results from that session appear as [external_agent_tool_call] and [external_agent_tool_result] notes. They record past actions, not tools available here. Thinking, source events and complete tool input and output are kept only in the full history.',
    `Full history: ${JSON.stringify(historyPath)}`,
    ...history.imageReferenceIndexPath ? [`Image reference index: ${JSON.stringify(history.imageReferenceIndexPath)}`] : [],
    ...issues.length > 0 ? ['Known source limitations:', ...issues.map(issue => `- ${issue.message} (${issue.code}${issue.count === undefined ? '' : `, ${issue.count}`})`)] : [],
    'Re-read workspace files before editing; they may have changed since the source session.',
  ].join('\n'));
}

export function renderHistory(
  history: EffectiveHistory,
  historyPath: string,
  tokenBudget: number,
  issues: readonly ConversionIssue[],
): { messages: ImportMessage[]; stats: ConversionStats; truncated: boolean } {
  const all = units(history);
  if (all.length === 0) throw Object.assign(new Error('The source session contains no conversation to import.'), { code: 'EMPTY_SOURCE_HISTORY' });
  const sourceTurns = history.turns.length;
  const reserve = estimateMessages([notice(history, historyPath, issues, sourceTurns, true, true)]);
  if (reserve > tokenBudget) throw Object.assign(new Error('The token budget cannot fit source attribution and history references.'), { code: 'INSUFFICIENT_TOKEN_BUDGET' });
  let remaining = tokenBudget - reserve;
  const selected: ImportMessage[][] = [];
  let includedTurns = 0;
  let truncatedCharacters = 0;
  for (let index = all.length - 1; index >= 0; index--) {
    const unit = all[index]!;
    const messages = messagesOf(unit);
    const cost = estimateMessages(messages);
    if (cost <= remaining) {
      selected.unshift(messages);
      remaining -= cost;
      includedTurns += unit.turns;
      continue;
    }
    const shortened = selected.length === 0 ? shorten(unit, remaining) : undefined;
    if (shortened) {
      selected.unshift(shortened.messages);
      includedTurns += unit.turns;
      truncatedCharacters = shortened.removed;
    }
    break;
  }
  if (selected.length === 0) throw Object.assign(new Error('The token budget cannot fit any source history. The complete history attachment is available.'), { code: 'INSUFFICIENT_TOKEN_BUDGET' });
  const omitted = selected.length < all.length;
  const messages = [...selected.flat(), notice(history, historyPath, issues, includedTurns, omitted, truncatedCharacters > 0)];
  const stats: ConversionStats = { tokenBudget, estimatedTokens: estimateMessages(messages), sourceTurns, includedTurns, omittedTurns: sourceTurns - includedTurns, truncatedCharacters };
  if (stats.estimatedTokens > tokenBudget) throw new Error('Rendered import exceeded its token budget.');
  return { messages, stats, truncated: omitted || truncatedCharacters > 0 };
}
