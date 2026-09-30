/**
 * Scan submitted text for image placeholders and produce the user-message
 * content parts sent to the engine.
 *
 * `extractMediaAttachments` (sync) is the single expansion path for prompts:
 * image placeholders expand to `image_url` content parts carrying inline
 * base64 sources (the paste was compressed in the background at ingestion; the
 * engine's media prompt gate applies its own compression/persistence from
 * there).
 *
 * Rules:
 *   - Only placeholders that resolve against `store` get extracted.
 *     A literal `[image #999 ...]` the user typed themselves stays in
 *     the text (we can't hallucinate files for it).
 *   - Order is preserved for text/image segments.
 *   - Adjacent text segments are flattened — empty / whitespace-only
 *     segments drop out so we never emit `{type:'text', text:' '}`
 *     noise between two image parts.
 */

import type { ContentPart } from '@moonshot-ai/agent-core';

import type { ImageAttachmentStore } from './image-attachment-store';

const PLACEHOLDER_REGEX = /\[(image) #(\d+) (?:(\(\d+×\d+\))|([^\]]+))\]/g;

export interface ExtractionResult {
  /** Flat list of parts in input order; empty array when no media matched. */
  parts: ContentPart[];
  /**
   * Did we find at least one matching attachment? When false, callers
   * should keep the prompt on the plain text path.
   */
  hasMedia: boolean;
  /** Image attachment ids matched, in the order they appeared. */
  imageAttachmentIds: number[];
}

export function extractMediaAttachments(
  text: string,
  store: ImageAttachmentStore,
): ExtractionResult {
  const parts: ContentPart[] = [];
  const imageAttachmentIds: number[] = [];
  let cursor = 0;
  let hasMedia = false;

  PLACEHOLDER_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_REGEX.exec(text)) !== null) {
    const [literal, kind, idStr] = match;
    if (kind !== 'image') continue;
    if (idStr === undefined) continue;
    const id = Number.parseInt(idStr, 10);
    const attachment = store.get(id);
    if (attachment === undefined) continue; // stale / user-typed — leave as text
    if (attachment.kind !== kind) continue;
    const before = text.slice(cursor, match.index);
    pushText(parts, before);
    const base64 = Buffer.from(attachment.bytes).toString('base64');
    parts.push({
      type: 'image_url',
      source: { kind: 'inline', mimeType: attachment.mime, data: base64 },
    });
    imageAttachmentIds.push(id);
    hasMedia = true;
    cursor = match.index + literal.length;
  }
  const tail = text.slice(cursor);
  pushText(parts, tail);

  return {
    // Text-only submissions drop the synthesised parts array — the
    // caller's contract is "parts is meaningful iff hasMedia", and
    // emitting a stray TextPart confuses consumers that branch on
    // `parts.length > 0`.
    parts: hasMedia ? parts : [],
    hasMedia,
    imageAttachmentIds,
  };
}

/**
 * Give media referenced by `text` a bounded moment to finish its background
 * paste ingestion (image compression — see `ImageAttachment.pending`) before
 * extraction, so a paste-then-immediately-submit still sends the compressed
 * form. The returned promise resolves after `timeoutMs` at the latest.
 * Returns undefined when nothing is pending, so the submit path stays
 * synchronous for media-free prompts.
 */
export function pendingMediaIngestions(
  text: string,
  store: ImageAttachmentStore,
  timeoutMs: number,
): Promise<void> | undefined {
  const pendings: Promise<void>[] = [];
  PLACEHOLDER_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_REGEX.exec(text)) !== null) {
    const [, kind, idStr] = match;
    if (kind !== 'image') continue;
    if (idStr === undefined) continue;
    const attachment = store.get(Number.parseInt(idStr, 10));
    if (attachment?.kind === kind && attachment.pending !== undefined) {
      pendings.push(attachment.pending);
    }
  }
  if (pendings.length === 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.allSettled(pendings).then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

function pushText(parts: ContentPart[], segment: string): void {
  if (segment.length === 0) return;
  // Keep whitespace-only segments only when they sit between non-empty
  // text elsewhere — the simpler rule "drop everything whitespace-only"
  // is fine here because the LLM doesn't care about inter-image spaces.
  if (segment.trim().length === 0) return;
  const last = parts.at(-1);
  if (last?.type === 'text') {
    parts[parts.length - 1] = { type: 'text', text: last.text + segment };
    return;
  }
  parts.push({ type: 'text', text: segment });
}
