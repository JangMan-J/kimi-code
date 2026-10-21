/**
 * NotifyPanel — mid-turn updates, shown right above the input area.
 *
 * Updates are grouped into CHANNELS, one per agent: the main agent plus one
 * channel per subagent that posts a `NotifyUser` update. The head is a rule
 * labelled with the channel tabs and a pager; the body is the current update.
 * `Ctrl+N` gives the panel keyboard focus, then `←`/`→` page through the
 * channel's updates, `Shift+←`/`→` switch channels, `↑`/`↓` scroll a docked
 * body, and `Esc`/`Ctrl+N` hand focus back to the editor; any other key hands
 * focus back and goes to the editor. Docked (fullscreen), clicks on the head's
 * tabs, pager and stub change the view without taking focus. A new update
 * pulls the view along only while the panel is unfocused and showing the
 * newest update; otherwise other channels collect an unread dot.
 *
 * When the turn ends the panel folds to a one-line stub until the user focuses
 * it; while an approval or question waits it shrinks to a one-line summary of
 * the asking agent's latest update. The host clears the panel when the next
 * turn starts.
 */

import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { Markdown } from '#/tui/components/markdown/markdown';

import { MAIN_AGENT_ID } from '#/tui/constant/kimi-tui';
import { currentTheme } from '#/tui/theme';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import { createMarkdownOptions } from '#/tui/utils/markdown-options';

import { normalizeCapsLockedCtrl } from '../editor/custom-editor';

import { DockSection, type DockPart } from './dock-section';

export interface NotifyEntry {
  readonly id: string;
  readonly agentId: string;
  readonly agentName?: string;
  readonly time: number;
  /** One-line headline of the update; absent for updates posted without one. */
  readonly title?: string;
  readonly text: string;
}

export interface NotifyChannelView {
  readonly label: string;
  readonly entries: readonly { readonly id: string; readonly text: string }[];
  readonly unread: number;
}

interface NotifyChannel {
  readonly key: string;
  readonly label: string;
  readonly entries: NotifyEntry[];
  /** Page (entry index) the user last read in this channel. */
  page: number;
  /** Ids of entries that arrived while the user was reading another channel. */
  readonly unreadIds: Set<string>;
}

/** What a click on a head segment does. */
type HeadAction =
  | { readonly kind: 'channel'; readonly key: string }
  | { readonly kind: 'prev' }
  | { readonly kind: 'next' }
  | { readonly kind: 'close' }
  | { readonly kind: 'expand' };

interface HeadSegment {
  readonly text: string;
  readonly style: (text: string) => string;
  readonly action?: HeadAction;
}

interface HitTarget {
  readonly from: number;
  readonly to: number;
  readonly action: HeadAction;
}

const BODY_INDENT = '  ';

export class NotifyPanelComponent extends DockSection implements Focusable {
  private readonly channels: NotifyChannel[] = [];
  /** Key of the channel on display; channels themselves are append-only. */
  private activeKey = MAIN_AGENT_ID;
  private hasFocus = false;
  /** Update ids in arrival order; the view follows the last one while it shows it. */
  private readonly arrivals: string[] = [];
  private ended = false;
  /** Turn ended and no one is reading: the panel folds to a one-line stub. */
  private collapsed = false;
  /** The user clicked the ended panel open: it stays open until the next update. */
  private keptOpen = false;
  /** Set while an approval or question waits: the panel shrinks to a summary of this agent. */
  private prompt: { readonly agentId: string | undefined } | undefined;
  private hitTargets: readonly HitTarget[] = [];
  /** Hands keyboard focus back to the editor, forwarding `key` when the panel does not own it. */
  onReturnFocus: ((key: string | undefined) => void) | undefined;

  /**
   * Add or update an entry in a channel. A repeated `id` updates the entry in
   * place; a new id appends. A new entry pulls the view to its channel's tail
   * only while the panel is unfocused and showing the newest update, the way
   * a scrolled-up transcript stops following; otherwise a background channel
   * collects an unread dot and the pager simply grows.
   */
  upsert(entry: NotifyEntry): void {
    const following = !this.hasFocus && this.showsNewest();
    const ch = this.channelFor(entry);
    const existing = ch.entries.find((item) => item.id === entry.id);
    if (existing !== undefined) {
      ch.entries[ch.entries.indexOf(existing)] = entry;
    } else {
      ch.entries.push(entry);
      this.arrivals.push(entry.id);
      if (following) this.showChannel(ch.key);
      else if (ch.key !== this.activeKey) ch.unreadIds.add(entry.id);
    }
    this.ended = false;
    this.collapsed = false;
    this.keptOpen = false;
  }

  remove(id: string): boolean {
    const ch = this.channels.find((channel) => channel.entries.some((entry) => entry.id === id));
    if (ch === undefined) return false;
    const index = ch.entries.findIndex((entry) => entry.id === id);
    ch.entries.splice(index, 1);
    if (ch.entries.length === 0) {
      this.channels.splice(this.channels.indexOf(ch), 1);
      if (ch.key === this.activeKey) this.activeKey = this.channels.at(-1)?.key ?? MAIN_AGENT_ID;
    } else {
      ch.page = Math.min(ch.page, ch.entries.length - 1);
      ch.unreadIds.delete(id);
    }
    this.arrivals.splice(this.arrivals.indexOf(id), 1);
    if (this.channels.length === 0) this.dropFocus();
    return true;
  }

  clearUpdates(): void {
    this.channels.length = 0;
    this.activeKey = MAIN_AGENT_ID;
    this.dropFocus();
    this.arrivals.length = 0;
    this.ended = false;
    this.collapsed = false;
    this.keptOpen = false;
  }

  isEmpty(): boolean {
    return this.channels.length === 0;
  }

  getChannels(): readonly NotifyChannelView[] {
    return this.channels.map((ch) => ({
      label: ch.label,
      entries: ch.entries.map((entry) => ({ id: entry.id, text: entry.text })),
      unread: ch.unreadIds.size,
    }));
  }

  /** Every entry across channels, in display order (main first, then arrival). */
  getEntries(): readonly NotifyEntry[] {
    return this.channels.flatMap((ch) => ch.entries);
  }

  /**
   * The turn that produced these updates has ended: dim the title and fold
   * the panel down to a one-line stub so the final reply owns the screen. A
   * focused user keeps reading — the fold lands when they blur. Only the turn
   * ending folds it: a stub the user clicked open stays open until the next
   * update, focus or not.
   */
  setEnded(ended: boolean): void {
    if (ended && !this.ended && !this.hasFocus) this.collapsed = true;
    if (!ended) {
      this.collapsed = false;
      this.keptOpen = false;
    }
    this.ended = ended;
  }

  /**
   * An approval or question from `agentId` is waiting (`undefined` agent when
   * the client did not say who asks), or nothing is (`undefined` prompt).
   * While one waits a docked panel is a read-only summary line and cannot
   * take focus; an inline panel stays as it is.
   */
  setPrompt(prompt: { readonly agentId: string | undefined } | undefined): void {
    if (this.layout === undefined) return;
    this.prompt = prompt;
    if (prompt !== undefined) this.blur();
  }

  /** Set by the TUI when keyboard focus moves to or away from the panel. */
  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    if (value) this.focus();
    else this.blur();
  }

  /** Whether there is something to read and no prompt holds the keyboard. */
  canFocus(): boolean {
    return this.channels.length > 0 && this.prompt === undefined;
  }

  focus(): boolean {
    if (!this.canFocus()) return false;
    this.hasFocus = true;
    this.collapsed = false;
    this.activeChannel().unreadIds.clear();
    return true;
  }

  blur(): boolean {
    if (!this.hasFocus) return false;
    this.hasFocus = false;
    if (this.ended && !this.keptOpen) this.collapsed = true;
    return true;
  }

  /** Nothing is left to read: hand the keyboard back to the editor. */
  private dropFocus(): void {
    if (!this.hasFocus) return;
    this.hasFocus = false;
    this.onReturnFocus?.(undefined);
  }

  handleInput(data: string): void {
    const key = normalizeCapsLockedCtrl(data);
    if (matchesKey(key, Key.escape) || matchesKey(key, Key.ctrl('n'))) {
      this.onReturnFocus?.(undefined);
    } else if (matchesKey(key, 'shift+left')) {
      this.prevChannel();
    } else if (matchesKey(key, 'shift+right')) {
      this.nextChannel();
    } else if (matchesKey(key, Key.left)) {
      this.prevPage();
    } else if (matchesKey(key, Key.right)) {
      this.nextPage();
    } else if (this.layout !== undefined && matchesKey(key, Key.up)) {
      this.scrollBody(-1);
    } else if (this.layout !== undefined && matchesKey(key, Key.down)) {
      this.scrollBody(1);
    } else {
      this.onReturnFocus?.(data);
    }
  }

  /** Older channel (`Shift+←`), landing on its latest update; false on the leftmost tab. */
  prevChannel(): boolean {
    const index = this.activeIndex();
    if (index <= 0) return false;
    this.showChannel(this.channels[index - 1]!.key);
    return true;
  }

  /** Newer channel (`Shift+→`), landing on its latest update; false on the rightmost tab. */
  nextChannel(): boolean {
    const index = this.activeIndex();
    if (index >= this.channels.length - 1) return false;
    this.showChannel(this.channels[index + 1]!.key);
    return true;
  }

  /** Older update in the current channel (`←`); false on the first page. */
  prevPage(): boolean {
    if (this.channels.length === 0) return false;
    const ch = this.activeChannel();
    if (ch.page <= 0) return false;
    ch.page -= 1;
    this.scrollBodyToTop();
    return true;
  }

  /** Newer update in the current channel (`→`); false on the latest page. */
  nextPage(): boolean {
    if (this.channels.length === 0) return false;
    const ch = this.activeChannel();
    if (ch.page >= ch.entries.length - 1) return false;
    ch.page += 1;
    this.scrollBodyToTop();
    return true;
  }

  protected renderPart(part: DockPart, width: number): string[] {
    if (this.channels.length === 0) return [];
    if (part === 'foot') return [];
    if (part === 'body') {
      return this.prompt !== undefined || this.collapsed ? [] : this.bodyRows(width);
    }
    if (this.prompt !== undefined) {
      this.hitTargets = [];
      return [truncateToWidth(this.summaryLine(this.prompt.agentId), width)];
    }
    const segments = this.collapsed ? this.stubSegments(width) : this.headSegments(width);
    return [this.paintSegments(segments, width)];
  }

  protected override handlePartMouse(
    part: DockPart,
    event: TuiMouseEvent,
  ): TuiMouseEventResult | undefined {
    if (part !== 'head' || event.y !== 0) return undefined;
    const target = this.hitTargets.find((hit) => event.x >= hit.from && event.x < hit.to);
    if (target === undefined || event.button !== 'left') return undefined;
    if (event.type === 'press' || event.type === 'release') return { handled: true };
    if (event.type !== 'click') return undefined;
    this.runAction(target.action);
    return { handled: true };
  }

  private runAction(action: HeadAction): void {
    switch (action.kind) {
      case 'channel':
        this.showChannel(action.key);
        this.openByClick();
        return;
      case 'prev':
        this.prevPage();
        return;
      case 'next':
        this.nextPage();
        return;
      case 'expand':
        this.openByClick();
        return;
      case 'close':
        if (this.hasFocus) {
          this.onReturnFocus?.(undefined);
        } else {
          this.collapsed = true;
          this.keptOpen = false;
        }
        return;
    }
  }

  private openByClick(): void {
    if (!this.collapsed) return;
    this.collapsed = false;
    this.keptOpen = true;
  }

  private showChannel(key: string): void {
    const ch = this.channels.find((channel) => channel.key === key);
    if (ch === undefined) return;
    const moved = this.activeKey !== key || ch.page !== ch.entries.length - 1;
    this.activeKey = key;
    ch.page = ch.entries.length - 1;
    ch.unreadIds.clear();
    if (moved) this.scrollBodyToTop();
  }

  private bodyRows(width: number): string[] {
    const inner = Math.max(1, width - BODY_INDENT.length);
    const entry = this.currentEntry();
    const titleRows =
      entry.title === undefined
        ? []
        : wrapTextWithAnsi(entry.title, inner).map((row) => currentTheme.boldFg('textStrong', row));
    const textRows = new Markdown(
      entry.text.trim(),
      0,
      0,
      createMarkdownTheme(),
      undefined,
      createMarkdownOptions(),
    ).render(inner);
    return [...titleRows, ...textRows].map((row) => truncateToWidth(`${BODY_INDENT}${row}`, width));
  }

  private paintSegments(segments: readonly HeadSegment[], width: number): string {
    const targets: HitTarget[] = [];
    let x = 0;
    let line = '';
    for (const segment of segments) {
      const segmentWidth = visibleWidth(segment.text);
      line += segment.style(segment.text);
      if (segment.action !== undefined) {
        targets.push({ from: x, to: x + segmentWidth, action: segment.action });
      }
      x += segmentWidth;
    }
    this.hitTargets = targets.filter((target) => target.to <= width);
    return truncateToWidth(line, width);
  }

  /**
   * The expanded head: a rule labelled with the channel tabs, the pager and a
   * key hint, plus a close button while focused or clicked open. Slims down as
   * width shrinks: first the other tabs and the hint go, then the label altogether.
   */
  private headSegments(width: number): HeadSegment[] {
    const rule = (text: string) => currentTheme.fg(this.hasFocus ? 'primary' : 'border', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const strong = (text: string) =>
      this.ended ? currentTheme.boldFg('textDim', text) : currentTheme.boldFg('primary', text);
    const ch = this.activeChannel();
    const label = (tabs: HeadSegment[], hint: string): HeadSegment[] => {
      const segments: HeadSegment[] = [
        { text: '─ ', style: rule },
        ...tabs,
        { text: ' · Updates', style: strong },
      ];
      if (ch.entries.length > 1) {
        segments.push(
          { text: ' ', style: strong },
          { text: this.hasFocus ? '←' : '<', style: strong, action: { kind: 'prev' } },
          { text: ` ${String(ch.page + 1)}/${String(ch.entries.length)} `, style: strong },
          { text: this.hasFocus ? '→' : '>', style: strong, action: { kind: 'next' } },
        );
      }
      if (this.ended) segments.push({ text: ' · turn ended', style: strong });
      if (hint.length > 0) segments.push({ text: ` · ${hint}`, style: dim });
      segments.push({ text: ' ', style: rule });
      return segments;
    };
    const close = (text: string): HeadSegment[] => {
      if (!this.hasFocus && !this.keptOpen) return [];
      return [
        { text: ' ', style: rule },
        { text: this.hasFocus ? text : 'close', style: dim, action: { kind: 'close' } },
        { text: ' ─', style: rule },
      ];
    };
    const hint = this.hasFocus
      ? this.channels.length > 1
        ? 'shift+←→ agent'
        : ''
      : 'ctrl+n to browse';
    const candidates: [HeadSegment[], HeadSegment[]][] = [
      [label(this.tabSegments(), hint), close('esc close')],
      [label([this.tabSegment(ch, true)], ''), close('esc')],
    ];
    for (const [left, right] of candidates) {
      const fill = width - segmentsWidth(left) - segmentsWidth(right);
      if (fill >= 1) return [...left, { text: '─'.repeat(fill), style: rule }, ...right];
    }
    return [{ text: '─'.repeat(width), style: rule }];
  }

  /**
   * The collapsed one-liner: an expand marker, the channel tabs, the total
   * update count, and a preview of the current entry's first line —
   * everything the user needs to decide whether to open the panel. A click on
   * a tab opens that channel; anywhere else opens the current one.
   */
  private stubSegments(width: number): HeadSegment[] {
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const expand: HeadAction = { kind: 'expand' };
    const marker: HeadSegment = {
      text: ' ▸ ',
      style: (text) => currentTheme.fg('primary', text),
      action: expand,
    };
    const total = this.channels.reduce((sum, ch) => sum + ch.entries.length, 0);
    const count = `${String(total)} ${total === 1 ? 'update' : 'updates'}`;
    const tail: HeadSegment = { text: ' · ctrl+n to expand', style: dim, action: expand };
    const head = [marker, ...this.tabSegments(), { text: ` · ${count}`, style: dim, action: expand }];
    const preview = this.previewText(this.currentEntry());
    if (preview !== undefined) {
      const budget = width - segmentsWidth(head) - segmentsWidth([tail]) - 3;
      if (budget >= 12) {
        return [...head, { text: ` · ${truncateToWidth(preview, budget)}`, style: dim, action: expand }, tail];
      }
    }
    if (segmentsWidth(head) + segmentsWidth([tail]) <= width) return [...head, tail];
    return [marker, { text: `${count} · ctrl+n to expand`, style: dim, action: expand }];
  }

  /** `▸ explore · <latest update>` for the agent behind a waiting approval or question. */
  private summaryLine(agentId: string | undefined): string {
    const asking = this.channels.find((ch) => ch.key === agentId);
    const ch =
      asking ??
      this.channels.reduce((latest, channel) =>
        (channel.entries.at(-1)?.time ?? 0) >= (latest.entries.at(-1)?.time ?? 0) ? channel : latest,
      );
    const entry = ch.entries.at(-1)!;
    const preview = this.previewText(entry);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    return (
      ` ${currentTheme.fg('primary', '▸')} ${currentTheme.boldFg('primary', ch.label)}` +
      (preview === undefined ? '' : dim(` · ${preview}`))
    );
  }

  private tabSegments(): HeadSegment[] {
    const segments: HeadSegment[] = [];
    for (const [index, channel] of this.channels.entries()) {
      if (index > 0) segments.push({ text: ' · ', style: (text) => currentTheme.fg('textDim', text) });
      segments.push(this.tabSegment(channel, channel.key === this.activeKey));
    }
    return segments;
  }

  private tabSegment(channel: NotifyChannel, active: boolean): HeadSegment {
    const action: HeadAction = { kind: 'channel', key: channel.key };
    if (active) {
      return { text: channel.label, style: (text) => currentTheme.boldFg('primary', text), action };
    }
    const unread = channel.unreadIds.size > 0;
    return {
      text: unread ? `${channel.label}●` : channel.label,
      style: (text) => currentTheme.fg(unread ? 'primary' : 'textDim', text),
      action,
    };
  }

  /** An entry's title, else its first non-empty line stripped of list/bold markers. */
  private previewText(entry: NotifyEntry): string | undefined {
    if (entry.title !== undefined) return entry.title;
    const firstLine = entry.text
      .trim()
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim()
      .replace(/^[-*#>\s]+/, '')
      .replaceAll('**', '');
    return firstLine === undefined || firstLine.length === 0 ? undefined : firstLine;
  }

  private showsNewest(): boolean {
    const newest = this.arrivals.at(-1);
    return this.channels.length === 0 || newest === undefined || this.currentEntry().id === newest;
  }

  private currentEntry(): NotifyEntry {
    const ch = this.activeChannel();
    return ch.entries[Math.min(ch.page, ch.entries.length - 1)]!;
  }

  private channelFor(entry: NotifyEntry): NotifyChannel {
    const key = entry.agentId;
    const found = this.channels.find((ch) => ch.key === key);
    if (found !== undefined) return found;
    const created: NotifyChannel = {
      key,
      label: this.labelFor(entry.agentName ?? key),
      entries: [],
      page: 0,
      unreadIds: new Set(),
    };
    if (key === MAIN_AGENT_ID) this.channels.unshift(created);
    else this.channels.push(created);
    return created;
  }

  /** Dedup identical labels as `explore`, `explore(2)`, `explore(3)`, … */
  private labelFor(base: string): string {
    if (!this.channels.some((ch) => ch.label === base)) return base;
    let n = 2;
    while (this.channels.some((ch) => ch.label === `${base}(${String(n)})`)) n += 1;
    return `${base}(${String(n)})`;
  }

  private activeIndex(): number {
    const index = this.channels.findIndex((ch) => ch.key === this.activeKey);
    return Math.max(0, index);
  }

  private activeChannel(): NotifyChannel {
    return this.channels[this.activeIndex()]!;
  }
}

function segmentsWidth(segments: readonly HeadSegment[]): number {
  return segments.reduce((sum, segment) => sum + visibleWidth(segment.text), 0);
}
