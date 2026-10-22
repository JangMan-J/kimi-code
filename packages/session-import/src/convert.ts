import { isAbsolute, join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { readClaudeSession } from '#/claude-code';
import { readRolloutSession } from '#/rollout';
import { saveEffectiveHistory } from '#/archive';
import { DEFAULT_IMPORT_RATIO, renderHistory } from '#/render';
import type { ConversionIssue, ConversionOptions, ConversionResult, EffectiveHistory } from '#/types';

export function sourceIssues(history: EffectiveHistory): ConversionIssue[] {
  const fields: Array<[string, string, string]> = [
    ['invalidJsonLines', 'INVALID_SOURCE_RECORDS', 'Malformed JSON records were skipped.'],
    ['invalidRecords', 'INVALID_SOURCE_RECORDS', 'Invalid source records were skipped.'],
    ['unresolvedParentReferences', 'INCOMPLETE_SOURCE_CHAIN', 'Some source parent records could not be found.'],
    ['unresolvedPreservedReferences', 'INCOMPLETE_PRESERVED_HISTORY', 'Some preserved source history could not be reconstructed.'],
    ['chainCycles', 'INCOMPLETE_SOURCE_CHAIN', 'The source history contains a cycle.'],
    ['missingCompactionSummaries', 'UNAVAILABLE_COMPACTION_SUMMARY', 'A source compaction summary is missing.'],
    ['opaqueCompactionSteps', 'UNAVAILABLE_COMPACTION_SUMMARY', 'A source compaction checkpoint has no available plaintext.'],
    ['opaqueReasoningSteps', 'UNAVAILABLE_REASONING', 'Some source reasoning has no available plaintext.'],
    ['textlessThinkingBlocks', 'UNAVAILABLE_REASONING', 'Some source thinking has no recorded text.'],
    ['documentBlocks', 'OMITTED_NON_IMAGE_MEDIA', 'Source document payloads were omitted.'],
    ['binaryPayloadsOmitted', 'OMITTED_NON_IMAGE_MEDIA', 'Non-image binary payloads were omitted.'],
    ['metadataBinaryPayloads', 'OMITTED_NON_IMAGE_MEDIA', 'Non-image binary payloads in source metadata were omitted.'],
    ['unknownBlocks', 'UNRECOGNIZED_SOURCE_CONTENT', 'Unrecognized source content was retained where possible; its meaning was not interpreted.'],
    ['unknownContentBlocks', 'UNRECOGNIZED_SOURCE_CONTENT', 'Unrecognized source content was retained where possible; its meaning was not interpreted.'],
    ['unknownRecords', 'UNRECOGNIZED_SOURCE_CONTENT', 'Unrecognized source records were retained where possible; their meaning was not interpreted.'],
    ['unmatchedToolResults', 'UNMATCHED_TOOL_RESULTS', 'Some source tool results have no matching call in the effective history.'],
  ];
  const issues: ConversionIssue[] = [];
  for (const [field, code, message] of fields) {
    const value = history.stats[field];
    if (typeof value === 'number' && value > 0) issues.push({ code, stage: 'source', message, count: value });
  }
  const unresolved = history.imageReferences.filter(reference => reference.unresolved).length;
  if (unresolved) issues.push({ code: 'UNRESOLVED_IMAGE_REFERENCES', stage: 'attachment', message: 'Some image references could not be resolved against the source location.', count: unresolved });
  return issues;
}

export async function convertSession(options: ConversionOptions): Promise<ConversionResult> {
  let stage: ConversionIssue['stage'] = 'source';
  try {
    if (options.source !== 'claude-code' && options.source !== 'codex') throw Object.assign(new Error('Unsupported session source.'), { code: 'INVALID_SOURCE' });
    if (!Number.isSafeInteger(options.contextWindow) || options.contextWindow <= 0) throw Object.assign(new Error('contextWindow must be a positive safe integer.'), { code: 'INVALID_CONTEXT_WINDOW' });
    if (!isAbsolute(options.attachmentDirectory)) throw Object.assign(new Error('attachmentDirectory must be an absolute destination session attachment path.'), { code: 'INVALID_ATTACHMENT_DIRECTORY' });
    const tokenBudget = options.tokenBudget ?? Math.floor(options.contextWindow * DEFAULT_IMPORT_RATIO);
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0 || tokenBudget > options.contextWindow) throw Object.assign(new Error('tokenBudget must be positive and no larger than contextWindow.'), { code: 'INVALID_TOKEN_BUDGET' });
    stage = 'attachment';
    try {
      const destination = await lstat(options.attachmentDirectory);
      if (!destination.isDirectory() || destination.isSymbolicLink()) throw Object.assign(new Error('The attachment destination must be a real directory, not a symbolic link.'), { code: 'INVALID_ATTACHMENT_DIRECTORY' });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const readOptions = { imageDirectory: join(options.attachmentDirectory, 'images'), stateDatabasePath: options.stateDatabasePath };
    stage = 'source';
    const history = options.source === 'claude-code'
      ? await readClaudeSession(options.sourcePath, readOptions)
      : await readRolloutSession(options.sourcePath, readOptions);
    const issues = sourceIssues(history);
    stage = 'attachment';
    const historyPath = await saveEffectiveHistory(history, options.attachmentDirectory, issues);
    stage = 'context';
    const { messages, stats } = renderHistory(history, historyPath, tokenBudget, issues);
    if (stats.omittedBlocks || stats.truncatedCharacters) issues.push({
      code: 'CONTEXT_TRUNCATED', stage: 'context',
      message: 'The model context contains only the most recent history that fits the budget. The full effective history is saved in the attachment.',
      count: stats.omittedBlocks,
    });
    return { status: issues.length > 0 ? 'partial' : 'complete', source: history.source, sourceId: history.sourceId,
      title: history.title, cwd: history.cwd, messages, historyPath,
      imageReferenceIndexPath: history.imageReferenceIndexPath, imageReferences: history.imageReferences, stats, issues };
  } catch (error) {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'CONVERSION_FAILED';
    const message = error instanceof Error ? error.message : 'Session conversion failed.';
    if (code.includes('IMAGE')) stage = 'attachment';
    return { status: 'unreliable', error: { code, message }, issues: [{ code, stage, message }] };
  }
}
