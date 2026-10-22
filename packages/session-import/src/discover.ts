import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, join } from 'node:path';
import { readJsonLines } from '#/jsonl';
import type { FindSessionsOptions, SessionCandidate } from '#/types';

const CLAUDE_HEAD_LINES = 100;
const CLAUDE_CONTROL_TEXT = /^(?:<command-name>|<local-command|<command-message>|\[Request interrupted by user)/;
const INTERACTIVE_CODEX_SOURCES = new Set(['cli', 'vscode']);

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);

async function entries(directory: string): Promise<Dirent[]> {
  return readdir(directory, { withFileTypes: true }).catch(() => []);
}

async function modifiedSince(path: string, since: number): Promise<number | undefined> {
  const stats = await stat(path).catch(() => undefined);
  return stats?.isFile() && stats.mtimeMs >= since ? stats.mtimeMs : undefined;
}

async function head(path: string, limit: number): Promise<Row[]> {
  const rows: Row[] = [];
  let lines = 0;
  try {
    for await (const line of readJsonLines(path)) {
      if (lines++ >= limit) break;
      try {
        const row: unknown = JSON.parse(line);
        if (isRow(row)) rows.push(row);
      } catch {
        continue;
      }
    }
  } catch {
    return rows;
  }
  return rows;
}

function isClaudePrompt(row: Row): boolean {
  if (row['type'] !== 'user' || row['isMeta'] === true) return false;
  const message = row['message'];
  const content = isRow(message) ? message['content'] : undefined;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content.filter(isRow) : [];
  return blocks.some(block => block['type'] === 'image'
    || block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim() !== '' && !CLAUDE_CONTROL_TEXT.test(block['text'].trim()));
}

async function claudeSession(path: string, since: number): Promise<SessionCandidate | undefined> {
  const modifiedAt = await modifiedSince(path, since);
  if (modifiedAt === undefined) return undefined;
  const rows = await head(path, CLAUDE_HEAD_LINES);
  const message = rows.find(row => typeof row['cwd'] === 'string' && row['cwd'] !== '');
  if (!message || message['isSidechain'] === true || !rows.some(isClaudePrompt)) return undefined;
  if (typeof message['entrypoint'] === 'string' && message['entrypoint'].startsWith('sdk-')) return undefined;
  return { source: 'claude-code', path, sourceId: basename(path, '.jsonl'), cwd: message['cwd'] as string, modifiedAt };
}

async function codexSession(path: string, since: number): Promise<SessionCandidate | undefined> {
  const modifiedAt = await modifiedSince(path, since);
  if (modifiedAt === undefined) return undefined;
  const [first] = await head(path, 1);
  const meta = first?.['type'] === 'session_meta' ? first['payload'] : undefined;
  if (!isRow(meta) || typeof meta['id'] !== 'string' || typeof meta['cwd'] !== 'string' || meta['cwd'] === '') return undefined;
  if (meta['source'] !== undefined && !INTERACTIVE_CODEX_SOURCES.has(meta['source'] as string)) return undefined;
  return { source: 'codex', path, sourceId: meta['id'], cwd: meta['cwd'], modifiedAt };
}

async function rolloutPaths(directory: string, found: string[] = []): Promise<string[]> {
  for (const entry of await entries(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await rolloutPaths(path, found);
    else if (/^rollout-.*\.jsonl(?:\.zst)?$/.test(entry.name)) found.push(path);
  }
  return found;
}

export async function findSessions(options: FindSessionsOptions): Promise<SessionCandidate[]> {
  const sessions: SessionCandidate[] = [];
  const projects = join(options.claudeHome, 'projects');
  for (const project of await entries(projects)) {
    if (!project.isDirectory()) continue;
    for (const file of await entries(join(projects, project.name))) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const session = await claudeSession(join(projects, project.name, file.name), options.since);
      if (session) sessions.push(session);
    }
  }
  const threads = new Map<string, SessionCandidate>();
  for (const path of await rolloutPaths(join(options.codexHome, 'sessions'))) {
    const session = await codexSession(path, options.since);
    const known = session && threads.get(session.sourceId);
    if (session && (!known || known.modifiedAt < session.modifiedAt)) threads.set(session.sourceId, session);
  }
  return [...sessions, ...threads.values()].toSorted((a, b) => b.modifiedAt - a.modifiedAt);
}
