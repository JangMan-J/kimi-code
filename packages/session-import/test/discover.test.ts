import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, expect, test } from 'vitest';
import { findSessions } from '#/index';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 22, 12);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function homes() {
  const root = await mkdtemp(join(tmpdir(), 'session-discover-'));
  roots.push(root);
  return { claudeHome: join(root, 'claude'), codexHome: join(root, 'codex') };
}

async function write(path: string, rows: unknown[], ageDays: number, compressed = false) {
  await mkdir(dirname(path), { recursive: true });
  const text = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(path, compressed ? zstdCompressSync(Buffer.from(text)) : text);
  const time = new Date(NOW - ageDays * DAY);
  await utimes(path, time, time);
}

const claudeRows = (extra: Record<string, unknown> = {}) => [
  { type: 'summary', summary: 'Earlier title', leafUuid: 'u' },
  { type: 'user', uuid: 'u', parentUuid: null, cwd: '/example/project', entrypoint: 'cli', message: { role: 'user', content: 'task' }, ...extra },
];
const codexRows = (id: string, source: unknown = 'cli') => [
  { type: 'session_meta', payload: { id, cwd: '/example/codex-project', source, originator: 'codex_cli_rs' } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'task' }] } },
];

test('finds recent interactive Claude Code sessions with a prompt and skips the rest', async () => {
  const { claudeHome, codexHome } = await homes();
  const project = join(claudeHome, 'projects', '-example-project');
  await write(join(project, 'interactive.jsonl'), claudeRows(), 1);
  await write(join(project, 'print-mode.jsonl'), claudeRows({ entrypoint: 'sdk-cli' }), 1);
  await write(join(project, 'sidechain.jsonl'), claudeRows({ isSidechain: true }), 1);
  await write(join(project, 'no-cwd.jsonl'), [{ type: 'summary', summary: 'Title only', leafUuid: 'missing' }], 1);
  await write(join(project, 'commands-only.jsonl'), claudeRows({ message: { role: 'user', content: '<command-name>/model</command-name>' } }), 1);
  await write(join(project, 'image-only.jsonl'), claudeRows({ message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] } }), 1);
  await write(join(project, 'old.jsonl'), claudeRows(), 40);
  await write(join(project, 'interactive', 'subagents', 'agent-a.jsonl'), claudeRows(), 1);
  expect((await findSessions({ claudeHome, codexHome, since: NOW - 30 * DAY })).toSorted((a, b) => a.sourceId.localeCompare(b.sourceId))).toEqual([
    { source: 'claude-code', path: join(project, 'image-only.jsonl'), sourceId: 'image-only', cwd: '/example/project', modifiedAt: NOW - DAY },
    { source: 'claude-code', path: join(project, 'interactive.jsonl'), sourceId: 'interactive', cwd: '/example/project', modifiedAt: NOW - DAY },
  ]);
});

test('finds interactive Codex rollouts, keeps the newest rollout of a thread, and orders by recency', async () => {
  const { claudeHome, codexHome } = await homes();
  const day = join(codexHome, 'sessions', '2026', '10', '20');
  await write(join(day, 'rollout-2026-10-20T10-00-00-thread-a.jsonl'), codexRows('thread-a'), 5);
  await write(join(day, 'rollout-2026-10-20T11-00-00-thread-a-replacement.jsonl'), codexRows('thread-a'), 3);
  await write(join(day, 'rollout-2026-10-20T12-00-00-thread-b.jsonl.zst'), codexRows('thread-b', 'vscode'), 2, true);
  await write(join(day, 'rollout-2026-10-20T13-00-00-exec.jsonl'), codexRows('exec', 'exec'), 1);
  await write(join(day, 'rollout-2026-10-20T14-00-00-child.jsonl'), codexRows('child', { subagent: 'review' }), 1);
  await write(join(day, 'notes.jsonl'), codexRows('ignored'), 1);
  await write(join(claudeHome, 'projects', '-example-project', 'recent.jsonl'), claudeRows(), 4);
  const found = await findSessions({ claudeHome, codexHome, since: NOW - 30 * DAY });
  expect(found.map(session => [session.source, session.sourceId, session.modifiedAt])).toEqual([
    ['codex', 'thread-b', NOW - 2 * DAY],
    ['codex', 'thread-a', NOW - 3 * DAY],
    ['claude-code', 'recent', NOW - 4 * DAY],
  ]);
  expect(found[1]!.path).toBe(join(day, 'rollout-2026-10-20T11-00-00-thread-a-replacement.jsonl'));
  expect(found[1]!.cwd).toBe('/example/codex-project');
});

test('returns nothing when neither source directory exists', async () => {
  const { claudeHome, codexHome } = await homes();
  expect(await findSessions({ claudeHome, codexHome, since: 0 })).toEqual([]);
});
