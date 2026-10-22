import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { convertSession, DEFAULT_IMPORT_RATIO, estimateMessages, estimateTokens } from '#/index';
import { renderHistory } from '#/render';
import type { EffectiveHistory } from '#/types';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(rows: unknown[]): Promise<{ sourcePath: string; attachmentDirectory: string }> {
  const root = await mkdtemp(join(tmpdir(), 'session-import-'));
  roots.push(root);
  const sourcePath = join(root, 'source.jsonl');
  await writeFile(sourcePath, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n'));
  return { sourcePath, attachmentDirectory: join(root, 'destination-session', 'attachments') };
}

const user = (text: string) => ({ type: 'user', uuid: 'u', parentUuid: null, sessionId: 'example-session', cwd: '/example/project', message: { role: 'user', content: text } });
const assistant = (text: string) => ({ type: 'assistant', uuid: 'a', parentUuid: 'u', message: { role: 'assistant', content: [{ type: 'text', text }], model: 'example-model' } });
const body = (messages: Array<{ content: Array<{ text: string }> }>) => messages.map(message => message.content.map(part => part.text).join('\n')).join('\n');
const history = (turns: EffectiveHistory['turns'], summary?: string): EffectiveHistory => ({
  source: 'claude-code', sourcePath: '/example/source.jsonl', sourceId: 'example', metadata: {}, turns, summary, stats: {}, imageReferences: [],
});

describe('session conversion', () => {
  it('uses 80% by default and preserves full effective history with metadata in an attachment', async () => {
    const paths = await fixture([user('Original request 中文🙂'), { ...assistant('Original answer'), customSourceField: 'metadata-only-sentinel' }]);
    const originalBytes = await readFile(paths.sourcePath);
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow: 32768 });
    expect(result.status).toBe('complete');
    if (result.status === 'unreliable') throw new Error(result.error.message);
    expect(DEFAULT_IMPORT_RATIO).toBe(0.8);
    expect(result.stats.tokenBudget).toBe(Math.floor(32768 * 0.8));
    expect(result.stats.estimatedTokens).toBe(estimateMessages(result.messages));
    const text = body(result.messages);
    expect(text).toContain('Original request 中文🙂');
    expect(text).toContain('Original answer');
    expect(text).not.toContain('metadata-only-sentinel');
    expect(text).toContain(result.historyPath);
    expect(result.historyPath.startsWith(paths.attachmentDirectory)).toBe(true);
    const lines = (await readFile(result.historyPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    expect(lines[0]).toMatchObject({ format: 'kimi-import-history', version: 1, source: 'claude-code', sourceId: 'example-session' });
    expect(lines[1]).toMatchObject({ type: 'turn', user: 'Original request 中文🙂' });
    expect(JSON.stringify(lines)).toContain('metadata-only-sentinel');
    expect(await readFile(paths.sourcePath)).toEqual(originalBytes);
    expect(result.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(result.messages[0]!.content).toEqual([{ type: 'text', text: 'Original request 中文🙂' }]);
    expect(result.messages[1]!.content).toEqual([{ type: 'text', text: 'Original answer' }]);
    expect(result.messages[2]!.content[0]!.text).toMatch(/^<EXTERNAL SESSION IMPORTED>\n/);
    expect(result.messages[2]!.content[0]!.text).toContain('Included turns: 1 of 1.');
  });

  it('honors an explicit token budget and keeps the uncropped text after the source is deleted', async () => {
    const original = 'BEGINNING\n' + 'large original text 中文 '.repeat(10000) + '\nORIGINAL_END';
    const paths = await fixture([user(original), assistant('Latest source reply')]);
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow: 32768, tokenBudget: 2000 });
    expect(result.status).toBe('partial');
    if (result.status === 'unreliable') throw new Error(result.error.message);
    expect(result.stats.estimatedTokens).toBeLessThanOrEqual(2000);
    expect(result.issues.some(issue => issue.code === 'CONTEXT_TRUNCATED' && issue.stage === 'context')).toBe(true);
    expect(body(result.messages)).toContain('Latest source reply');
    await rm(paths.sourcePath);
    const rows = (await readFile(result.historyPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    expect(rows[1].user).toBe(original);
  });

  it('renders each turn as ordinary user and assistant messages without thinking, events or source context', () => {
    const source = history([{ id: 'turn', user: 'Fix the build', steps: [
      { kind: 'source_context', text: 'CONTEXT_BEFORE_PROMPT', beforeUser: true },
      { kind: 'thinking', text: 'PRIVATE_THINKING' },
      { kind: 'assistant', text: 'Running the build.' },
      { kind: 'tool_call', name: 'Bash', text: JSON.stringify({ command: 'npm run build', description: 'Build the project' }) },
      { kind: 'tool_result', text: 'Build passed' },
      { kind: 'event', text: 'SOURCE_EVENT' },
      { kind: 'error', text: 'SOURCE_ERROR' },
      { kind: 'source_context', text: 'SOURCE_CONTEXT' },
      { kind: 'assistant', text: 'The build passes.' },
    ] }]);
    const result = renderHistory(source, '/example/history.jsonl', 8000, []);
    expect(result.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(result.messages[0]!.content[0]!.text).toBe('Fix the build');
    expect(result.messages[1]!.content[0]!.text).toBe([
      'Running the build.',
      '[external_agent_tool_call: Bash]\ndescription: Build the project\ncommand: npm run build\n[/external_agent_tool_call]',
      '[external_agent_tool_result]\nBuild passed\n[/external_agent_tool_result]',
      'The build passes.',
    ].join('\n\n'));
    for (const omitted of ['CONTEXT_BEFORE_PROMPT', 'PRIVATE_THINKING', 'SOURCE_EVENT', 'SOURCE_ERROR', 'SOURCE_CONTEXT']) expect(body(result.messages)).not.toContain(omitted);
    expect(result.truncated).toBe(false);
  });

  it('condenses tool calls and results into bounded notes', () => {
    const search = JSON.stringify({ pattern: 'x'.repeat(5000) });
    const source = history([{ id: 'turn', user: 'Inspect', steps: [
      { kind: 'tool_call', name: 'Grep', text: search },
      { kind: 'tool_call', name: 'Edit', text: JSON.stringify({ file_path: '/example/a.ts', old_string: 'OLD_TEXT', new_string: 'NEW_TEXT' }) },
      { kind: 'tool_call', name: 'exec_command', text: JSON.stringify({ cmd: 'npm test', workdir: '/example' }) },
      { kind: 'tool_call', name: 'apply_patch', text: '*** Begin Patch\n*** End Patch' },
      { kind: 'tool_result', text: 'r'.repeat(5000), metadata: { isError: true } },
      { kind: 'tool_result', text: '' },
    ] }]);
    const text = renderHistory(source, '/example/history.jsonl', 20000, []).messages[1]!.content[0]!.text;
    expect(text).toContain(`[external_agent_tool_call: Grep]\ninput: ${search.slice(0, 1997)}...\n[/external_agent_tool_call]`);
    expect(text).toContain('[external_agent_tool_call: Edit]\nfile: /example/a.ts\n[/external_agent_tool_call]');
    expect(text).not.toContain('OLD_TEXT');
    expect(text).toContain('[external_agent_tool_call: exec_command]\ncommand: npm test\n[/external_agent_tool_call]');
    expect(text).toContain('[external_agent_tool_call: apply_patch]\ninput: *** Begin Patch\n*** End Patch\n[/external_agent_tool_call]');
    expect(text).toContain(`[external_agent_tool_result: error]\n${'r'.repeat(3997)}...\n[/external_agent_tool_result]`);
    expect(text).toContain('[external_agent_tool_result]\n[/external_agent_tool_result]');
  });

  it('never clips a tool result inside an image reference', () => {
    const image = '[Imported image reference: "/example/image.png"; read this file to view the image]';
    const source = history([{ id: 'turn', user: 'Show it', steps: [{ kind: 'tool_result', text: 'x'.repeat(3980) + image }] }]);
    const text = renderHistory(source, '/example/history.jsonl', 20000, []).messages[1]!.content[0]!.text;
    expect(text).toContain(`${'x'.repeat(3980)}...\n[/external_agent_tool_result]`);
    expect(text).not.toContain('[Imported image reference:');
  });

  it('merges answers without a prompt into the previous turn and drops answers before the first prompt', () => {
    const source = history([
      { id: 'context', user: '', steps: [{ kind: 'assistant', text: 'LEADING_ANSWER' }] },
      { id: 'one', user: 'First request', steps: [{ kind: 'assistant', text: 'First answer' }] },
      { id: 'two', user: '', steps: [{ kind: 'assistant', text: 'Continued answer' }] },
      { id: 'three', user: 'Second request', steps: [] },
    ]);
    const result = renderHistory(source, '/example/history.jsonl', 8000, []);
    expect(result.messages.map(message => [message.role, message.content[0]!.text])).toEqual([
      ['user', 'First request'],
      ['assistant', 'First answer\n\nContinued answer'],
      ['user', 'Second request'],
      ['user', expect.stringContaining('<EXTERNAL SESSION IMPORTED>')],
    ]);
    expect(result.stats).toMatchObject({ sourceTurns: 4, includedTurns: 4, omittedTurns: 0 });
  });

  it('keeps recent whole turns and reports omission of the earlier ones', () => {
    const source = history(Array.from({ length: 12 }, (_, index) => ({ id: `turn-${index}`, user: `user-${index}`, steps: [
      { kind: 'assistant' as const, text: `reply-${index} ` + 'x'.repeat(3000) },
    ] })));
    const result = renderHistory(source, '/example/history.jsonl', 3000, []);
    const text = body(result.messages);
    expect(text).toContain('reply-11');
    expect(text).not.toContain('reply-0 ');
    expect(result.stats.omittedTurns).toBeGreaterThan(0);
    expect(result.stats.includedTurns + result.stats.omittedTurns).toBe(result.stats.sourceTurns);
    expect(result.messages[0]!.role).toBe('user');
    expect(text).toContain(`Included turns: the most recent ${result.stats.includedTurns} of 12; earlier history is omitted here.`);
    expect(result.truncated).toBe(true);
  });

  it('keeps the prompt and the latest activity when the newest turn alone exceeds the budget', () => {
    const source = history([
      { id: 'old', user: 'OLD_PROMPT', steps: [{ kind: 'assistant', text: 'OLD_ANSWER' }] },
      { id: 'new', user: 'NEW_PROMPT', steps: [{ kind: 'assistant', text: 'EARLY_PROGRESS ' + 'step '.repeat(5000) + 'FINAL_ANSWER' }] },
    ]);
    const result = renderHistory(source, '/example/history.jsonl', 2000, []);
    expect(result.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(result.messages[0]!.content[0]!.text).toBe('NEW_PROMPT');
    const answer = result.messages[1]!.content[0]!.text;
    expect(answer).toMatch(/^\[Earlier source text omitted: \d+ characters\. See the full history attachment\.\]\n/);
    expect(answer).toContain('FINAL_ANSWER');
    expect(answer).not.toContain('EARLY_PROGRESS');
    expect(body(result.messages)).not.toContain('OLD_PROMPT');
    expect(result.stats).toMatchObject({ includedTurns: 1, omittedTurns: 1 });
    expect(result.stats.truncatedCharacters).toBeGreaterThan(0);
    expect(result.stats.estimatedTokens).toBeLessThanOrEqual(2000);
    expect(result.truncated).toBe(true);
  });

  it('never truncates an image reference into a broken path and always keeps the index path', () => {
    const image = '[Imported image reference: "/example/' + 'image/'.repeat(200) + 'image.png"; read this file to view the image]';
    const source = history([{ id: 'turn', user: 'x'.repeat(3000) + image + 'END', steps: [] }]);
    source.imageReferenceIndexPath = '/example/attachments/images/index.json';
    const result = renderHistory(source, '/example/history.jsonl', 1200, []);
    const text = body(result.messages);
    expect(text.replaceAll(image, '')).not.toContain('[Imported image reference:');
    expect(text.replaceAll(image, '')).not.toContain('read this file to view the image]');
    expect(text).toContain(source.imageReferenceIndexPath);
    expect(result.stats.estimatedTokens).toBeLessThanOrEqual(1200);
  });

  it('preserves a source summary first when all history fits, without inventing an overview', () => {
    const source = history([{ id: 'turn', user: 'Current task', steps: [{ kind: 'assistant', text: 'Current answer' }] }], 'Original source summary');
    const result = renderHistory(source, '/example/history.jsonl', 8000, []);
    expect(result.messages.map(message => [message.role, message.content[0]!.text])).toEqual([
      ['user', 'Original source summary'],
      ['user', 'Current task'],
      ['assistant', 'Current answer'],
      ['user', expect.stringContaining('<EXTERNAL SESSION IMPORTED>')],
    ]);
    expect(body(result.messages)).not.toContain('Files changed:');
    expect(result.stats.omittedTurns).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('marks damaged and unfamiliar source records as partial with model-visible issues', async () => {
    const paths = await fixture(['{broken', user('task'), assistant('answer'), { type: 'future_record', uuid: 'future', parentUuid: 'a', value: 'preserved future record' }]);
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow: 32768 });
    expect(result.status).toBe('partial');
    if (result.status === 'unreliable') throw new Error(result.error.message);
    expect(result.issues.some(issue => issue.code === 'INVALID_SOURCE_RECORDS')).toBe(true);
    expect(result.issues.some(issue => issue.code === 'UNRECOGNIZED_SOURCE_CONTENT')).toBe(true);
    expect(body(result.messages)).toContain('INVALID_SOURCE_RECORDS');
  });

  it('marks unavailable encrypted compaction as a known loss rather than a fabricated summary', async () => {
    const paths = await fixture([
      { type: 'session_meta', payload: { id: 'example', cwd: '/example/project' } },
      { type: 'compacted', payload: { replacement_history: [{ type: 'compaction', encrypted_content: 'opaque-example' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue' }] } },
    ]);
    const result = await convertSession({ ...paths, source: 'codex', contextWindow: 32768 });
    expect(result.status).toBe('partial');
    if (result.status === 'unreliable') throw new Error(result.error.message);
    expect(result.issues.some(issue => issue.code === 'UNAVAILABLE_COMPACTION_SUMMARY')).toBe(true);
    expect(body(result.messages)).not.toContain('opaque-example');
    expect(body(result.messages)).toContain('A source compaction checkpoint has no available plaintext. (UNAVAILABLE_COMPACTION_SUMMARY, 1)');
  });

  it('titles an untitled session with the first worded prompt line after control wrappers', async () => {
    const paths = await fixture([user('<system-reminder>Context\n</system-reminder>\n\n-\n```\n  Fix the login flow  \nwith details'), assistant('Done')]);
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow: 32768 });
    expect(result).toMatchObject({ status: 'complete', title: 'Fix the login flow' });
    if (result.status === 'unreliable') throw new Error(result.error.message);
    expect(body(result.messages)).toContain('the Claude Code session "Fix the login flow" (example-session)');
    const long = await fixture([user('标'.repeat(130)), assistant('Done')]);
    expect(await convertSession({ ...long, source: 'claude-code', contextWindow: 32768 })).toMatchObject({ title: `${'标'.repeat(117)}...` });
  });

  it('returns unreliable for a source without conversation and writes no attachment', async () => {
    const paths = await fixture([{ type: 'session_meta', payload: { id: 'example', cwd: '/example/project' } }, { type: 'event_msg', payload: { type: 'task_started' } }]);
    const result = await convertSession({ ...paths, source: 'codex', contextWindow: 32768 });
    expect(result).toMatchObject({ status: 'unreliable', error: { code: 'EMPTY_SOURCE_HISTORY' } });
    await expect(readdir(paths.attachmentDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns unreliable for unsupported ancestor history without writing a successful archive', async () => {
    const paths = await fixture([{ type: 'session_meta', payload: { id: 'example', history_base: { thread_id: 'parent' } } }]);
    const result = await convertSession({ ...paths, source: 'codex', contextWindow: 32768 });
    expect(result).toMatchObject({ status: 'unreliable', error: { code: 'UNSUPPORTED_HISTORY_BASE', message: expect.stringContaining('forked or restarted from an earlier message') } });
    await expect(readdir(paths.attachmentDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid context windows before writing attachments (%s)', async contextWindow => {
    const paths = await fixture([user('task')]);
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow });
    expect(result).toMatchObject({ status: 'unreliable', error: { code: 'INVALID_CONTEXT_WINDOW' } });
    await expect(readdir(paths.attachmentDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([0, -1, 50000, 1.5])('rejects invalid explicit budgets (%s)', async tokenBudget => {
    const paths = await fixture([user('task')]);
    expect(await convertSession({ ...paths, source: 'claude-code', contextWindow: 32768, tokenBudget }))
      .toMatchObject({ status: 'unreliable', error: { code: 'INVALID_TOKEN_BUDGET' } });
  });

  it('reports an insufficient budget without claiming that useful context was converted', async () => {
    const paths = await fixture([user('task')]);
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow: 100 });
    expect(result).toMatchObject({ status: 'unreliable', error: { code: 'INSUFFICIENT_TOKEN_BUDGET' } });
  });

  it('stores embedded images and a persistent index alongside the full history', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=';
    const paths = await fixture([{ ...user(''), message: { role: 'user', content: [
      { type: 'text', text: 'Inspect the image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
    ] } }, assistant('Recorded response')]);
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow: 32768 });
    expect(result.status).toBe('complete');
    if (result.status === 'unreliable') throw new Error(result.error.message);
    expect(result.imageReferences).toHaveLength(1);
    const reference = result.imageReferences[0]!;
    const bytes = await readFile(reference.path!);
    expect(bytes).toEqual(Buffer.from(png, 'base64'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(reference.sha256);
    expect(body(result.messages)).toContain(reference.path!);
    expect(body(result.messages)).toContain(result.imageReferenceIndexPath!);
    expect(body(result.messages)).not.toContain(png);
    await rm(paths.sourcePath);
    expect(await readFile(reference.path!)).toEqual(bytes);
    expect(await readFile(result.historyPath, 'utf8')).toContain(reference.path!);
  });

  it('uses source metadata only in the archive without consuming the history budget', async () => {
    const source = history([{ id: 'turn', user: 'Original task', metadata: { veryLarge: 'm'.repeat(100000) }, steps: [
      { kind: 'tool_result', text: 'Original evidence', metadata: { veryLarge: 'n'.repeat(100000) } },
    ] }]);
    const result = renderHistory(source, '/example/history.jsonl', 2000, []);
    expect(body(result.messages)).toContain('Original task');
    expect(body(result.messages)).toContain('Original evidence');
    expect(body(result.messages)).not.toContain('veryLarge');
    expect(result.stats.omittedTurns).toBe(0);
  });

  it('keeps Unicode characters intact and token accounting exact after clipping', () => {
    const source = history([{ id: 'turn', user: '中文🙂'.repeat(10000), steps: [] }]);
    const result = renderHistory(source, '/example/history.jsonl', 2000, []);
    expect(result.stats.estimatedTokens).toBe(estimateMessages(result.messages));
    expect(result.stats.estimatedTokens).toBeLessThanOrEqual(2000);
    expect(Buffer.from(body(result.messages), 'utf8').toString('utf8')).toBe(body(result.messages));
    expect(estimateTokens('abcd中🙂')).toBe(3);
  });

  it('marks a recorded tool error on the result note even when the text is ambiguous', async () => {
    const paths = await fixture([user('Run the check'), {
      type: 'assistant', uuid: 'call', parentUuid: 'u', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'check', name: 'Bash', input: { command: 'npm test' } }] },
    }, { type: 'user', uuid: 'result', parentUuid: 'call', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'check', content: 'Build output', is_error: true }] }, toolUseResult: { exitCode: 2 } }]);
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow: 32768 });
    expect(result.status).toBe('complete');
    if (result.status === 'unreliable') throw new Error(result.error.message);
    expect(body(result.messages)).toContain('[external_agent_tool_call: Bash]\ncommand: npm test\n[/external_agent_tool_call]\n\n[external_agent_tool_result: error]\nBuild output\n[/external_agent_tool_result]');
  });

  it('marks a binary payload omitted from metadata as partial', async () => {
    const paths = await fixture([user('Run the check'), {
      type: 'assistant', uuid: 'call', parentUuid: 'u', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'check', name: 'Read', input: { path: '/example/document' } }] },
    }, { type: 'user', uuid: 'result', parentUuid: 'call', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'check', content: 'File attachment' }] }, toolUseResult: { type: 'file', base64: 'ZXhhbXBsZQ==' } }]);
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow: 32768 });
    expect(result.status).toBe('partial');
    if (result.status === 'unreliable') throw new Error(result.error.message);
    expect(result.issues.some(issue => issue.code === 'OMITTED_NON_IMAGE_MEDIA')).toBe(true);
  });

  it('rejects a symlink attachment root before any image is written through it', async () => {
    const paths = await fixture([{ ...user(''), message: { role: 'user', content: [{ type: 'image', source: {
      type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=',
    } }] } }]);
    const outside = join(paths.sourcePath, '..', 'outside');
    await mkdir(outside);
    await mkdir(join(paths.attachmentDirectory, '..'), { recursive: true });
    await symlink(outside, paths.attachmentDirectory, 'dir');
    const result = await convertSession({ ...paths, source: 'claude-code', contextWindow: 32768 });
    expect(result).toMatchObject({ status: 'unreliable', error: { code: 'INVALID_ATTACHMENT_DIRECTORY' }, issues: [{ stage: 'attachment' }] });
    expect(await readdir(outside)).toEqual([]);
  });
});
