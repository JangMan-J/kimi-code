import { createHash } from 'node:crypto';
import { writeAttachmentFile } from '#/images';
import type { ConversionIssue, EffectiveHistory } from '#/types';

export async function saveEffectiveHistory(
  history: EffectiveHistory,
  directory: string,
  issues: readonly ConversionIssue[],
): Promise<string> {
  function* lines(): Generator<string> {
    const { turns, ...header } = history;
    yield JSON.stringify({ type: 'session', format: 'kimi-import-history', version: 1, ...header, issues }) + '\n';
    for (const turn of turns) yield JSON.stringify({ type: 'turn', ...turn }) + '\n';
  }
  const hash = createHash('sha256');
  for (const line of lines()) hash.update(line);
  const filename = `effective-history-${hash.digest('hex')}.jsonl`;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (const line of lines()) yield Buffer.from(line);
  }
  return (await writeAttachmentFile(directory, filename, chunks())).path;
}
