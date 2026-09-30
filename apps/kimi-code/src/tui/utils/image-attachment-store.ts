/**
 * Registry for images pasted into the input box.
 *
 * Each paste produces an `ImageAttachment` with an auto-incrementing id and
 * a human-readable placeholder (`[image #1 (640×480)]`). The placeholder is
 * what the user sees in the input field; on submit,
 * `extractMediaAttachments` walks the text and expands image placeholders to
 * `image_url` content parts carrying base64 `data:` URLs — the engine's
 * media prompt gate compresses and persists them from there.
 *
 * Scope is per-`KimiTUI` instance. Reloads (`/new`, `/clear`,
 * session switch) call `clear()` so ids restart from 1 and stale
 * prompt attachments are dropped. We intentionally do NOT persist
 * attachments across sessions — coding-agent doesn't either, and
 * `--resume` wouldn't know how to materialize the files anyway.
 */

export interface ImageAttachment {
  readonly id: number;
  readonly kind: 'image';
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  /**
   * Background ingestion (compression) still in flight. The paste callback
   * settles once the placeholder is in the editor — typing never waits on
   * this — but submit holds it briefly (`pendingMediaIngestions`) so a fast
   * paste-then-Enter still sends the compressed form. Cleared when ingestion
   * completes.
   */
  pending?: Promise<void>;
  /** Rendered placeholder string, e.g. `[image #1 (640×480)]`. */
  readonly placeholder: string;
}

type MutableImageAttachment = {
  -readonly [Property in keyof ImageAttachment]: ImageAttachment[Property];
};

export class ImageAttachmentStore {
  private nextId = 1;
  private readonly byId = new Map<number, ImageAttachment>();

  addImage(
    bytes: Uint8Array,
    mime: string,
    width: number,
    height: number,
  ): ImageAttachment {
    const id = this.nextId;
    this.nextId += 1;
    const attachment: ImageAttachment = {
      id,
      kind: 'image',
      bytes,
      mime,
      width,
      height,
      placeholder: formatPlaceholder(id, width, height),
    };
    this.byId.set(id, attachment);
    return attachment;
  }

  /**
   * Complete an image that was inserted into the editor before its ingestion
   * work (compression) finished. Returns undefined when the attachment was
   * cleared while that work was in flight.
   */
  completeImage(
    attachment: ImageAttachment,
    input: {
      bytes: Uint8Array;
      mime: string;
      width: number;
      height: number;
    },
  ): ImageAttachment | undefined {
    const current = this.byId.get(attachment.id);
    if (current !== attachment) return undefined;
    const mutable = attachment as MutableImageAttachment;
    mutable.bytes = input.bytes;
    mutable.mime = input.mime;
    mutable.width = input.width;
    mutable.height = input.height;
    mutable.pending = undefined;
    mutable.placeholder = formatPlaceholder(attachment.id, input.width, input.height);
    return attachment;
  }

  get(id: number): ImageAttachment | undefined {
    return this.byId.get(id);
  }

  /** Drop every attachment. */
  clear(): void {
    this.byId.clear();
    this.nextId = 1;
  }

  /**
   * Drop a single attachment, releasing its bytes. Used to reclaim image
   * memory once the transcript entry that references it is trimmed.
   */
  remove(id: number): void {
    this.byId.delete(id);
  }

  /** Drop many attachments at once. See {@link remove}. */
  removeMany(ids: Iterable<number>): void {
    for (const id of ids) {
      this.remove(id);
    }
  }

  size(): number {
    return this.byId.size;
  }
}

export function formatPlaceholder(id: number, width: number, height: number): string {
  return `[image #${String(id)} (${String(width)}×${String(height)})]`;
}
