import type { TuiMouseEvent } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { describe, expect, it, onTestFinished } from 'vitest';

import {
  NotifyPanelComponent,
  type NotifyEntry,
} from '#/tui/components/chrome/notify-panel';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function render(panel: NotifyPanelComponent, width = 80): string[] {
  return panel.render(width).map(strip);
}

function titleOf(panel: NotifyPanelComponent, width = 80): string {
  return render(panel, width)[0]!;
}

function mouse(
  type: TuiMouseEvent['type'],
  x: number,
  overrides: Partial<TuiMouseEvent> = {},
): TuiMouseEvent {
  return {
    type,
    button: type === 'move' ? 'none' : 'left',
    x,
    y: 0,
    screenX: x,
    screenY: 0,
    width: 80,
    height: 20,
    shift: false,
    alt: false,
    ctrl: false,
    ...overrides,
  };
}

function click(panel: NotifyPanelComponent, label: string): void {
  const x = titleOf(panel).indexOf(label);
  expect(x).toBeGreaterThanOrEqual(0);
  for (const type of ['press', 'release', 'click'] as const) panel.handleMouse(mouse(type, x));
}

function entry(id: string, text: string, agentId = 'main', agentName?: string): NotifyEntry {
  return { id, agentId, agentName, time: 0, text };
}

function listRows(count: number, prefix = 'row'): string {
  return Array.from({ length: count }, (_, i) => `- ${prefix} ${String(i + 1)}`).join('\n');
}

describe('NotifyPanelComponent', () => {
  it('returns no lines when empty (so the layout slot collapses)', () => {
    const panel = new NotifyPanelComponent();
    expect(panel.render(80)).toEqual([]);
    expect(panel.isEmpty()).toBe(true);
    expect(panel.focus()).toBe(false);
  });

  it('renders the update under a rule labelled with the channel tab', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'Login module is clean; the bug is in **session expiry**.'));
    const lines = render(panel);

    expect(lines[0]).toMatch(/^─ main · Updates · ctrl\+n to browse ─+$/);
    expect(lines.slice(1).map((line) => line.trimEnd())).toEqual([
      '  Login module is clean; the bug is in session expiry.',
    ]);
  });

  it('updates an entry in place and flattens entries in display order', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'Reading the'));
    panel.upsert(entry('tc-1', 'Reading the parser first.'));
    expect(panel.getEntries().map((item) => item.text)).toEqual(['Reading the parser first.']);
    expect(render(panel).join('\n')).toContain('Reading the parser first.');
  });

  it('follows the latest activity across channels while unfocused', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'main phase one'));
    panel.upsert(entry('tc-2', 'main phase two'));
    expect(titleOf(panel)).toContain('Updates ← 2/2 →');

    panel.upsert(entry('a0:c1', 'explore finding', 'a0', 'explore'));
    const lines = render(panel);
    expect(lines[0]).toContain('main · explore · Updates · ctrl+n to browse');
    expect(lines.join('\n')).toContain('explore finding');
    expect(lines.join('\n')).not.toContain('main phase');
  });

  it('switches channels with prev/nextChannel and pages inside a channel', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'main one'));
    panel.upsert(entry('tc-2', 'main two'));
    panel.upsert(entry('a0:c1', 'explore one', 'a0', 'explore'));

    expect(panel.focus()).toBe(true);
    expect(panel.nextChannel()).toBe(false);

    expect(panel.prevChannel()).toBe(true);
    expect(titleOf(panel)).toContain('Updates ← 2/2 →');
    expect(render(panel).join('\n')).toContain('main two');

    expect(panel.prevPage()).toBe(true);
    expect(titleOf(panel)).toContain('Updates ← 1/2 →');
    expect(render(panel).join('\n')).toContain('main one');
    expect(panel.prevPage()).toBe(false);

    expect(panel.nextPage()).toBe(true);
    expect(render(panel).join('\n')).toContain('main two');
  });

  it('collects an unread dot on background channels while focused, cleared on visit', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'main one'));
    panel.upsert(entry('a0:c1', 'explore one', 'a0', 'explore'));

    panel.focus();
    panel.prevChannel();
    expect(titleOf(panel)).not.toContain('●');

    panel.upsert(entry('a0:c2', 'explore two', 'a0', 'explore'));
    expect(titleOf(panel)).toContain('explore●');
    expect(render(panel).join('\n')).toContain('main one');

    expect(panel.nextChannel()).toBe(true);
    expect(titleOf(panel)).not.toContain('●');
    expect(titleOf(panel)).toContain('Updates ← 2/2 →');
    expect(render(panel).join('\n')).toContain('explore two');
  });

  it('dedups repeated channel labels with a counter', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('a1:c1', 'first explore', 'a1', 'explore'));
    panel.upsert(entry('a2:c1', 'second explore', 'a2', 'explore'));

    expect(panel.getChannels().map((ch) => ch.label)).toEqual(['explore', 'explore(2)']);
  });

  it('labels channels by raw agent id when no name is known', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('a9:c1', 'mystery worker', 'agent-9'));
    expect(panel.getChannels().map((ch) => ch.label)).toEqual(['agent-9']);
    expect(titleOf(panel)).toContain('agent-9');
  });

  it('renders every row of a long entry — adaptive height, no truncation', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', listRows(30)));
    const text = render(panel).join('\n');
    expect(text).toContain('row 1');
    expect(text).toContain('row 30');
    expect(text).not.toContain('later lines');
    expect(text).not.toContain('more lines');
  });

  it('renders focus state: agent hint with several channels, a close button, blur restores', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'phase one'));

    expect(titleOf(panel)).toContain('Updates · ctrl+n to browse');
    panel.focus();
    expect(titleOf(panel)).toMatch(/^─ main · Updates ─+ esc close ─$/);
    panel.upsert(entry('a0:c1', 'explore one', 'a0', 'explore'));
    expect(titleOf(panel)).toMatch(/^─ main · explore● · Updates · shift\+←→ agent ─+ esc close ─$/);
    expect(titleOf(panel, 30)).toMatch(/^─ main · Updates ─+ esc ─$/);
    panel.blur();
    expect(panel.blur()).toBe(false);
    expect(titleOf(panel)).toContain('ctrl+n to browse');
  });

  it('folds to a one-line preview stub when the turn ends, expands on focus', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'phase one intro\n\n- detail one\n- detail two'));
    panel.setEnded(true);

    expect(render(panel)).toEqual([' ▸ main · 1 update · phase one intro · ctrl+n to expand']);

    panel.focus();
    const expanded = render(panel);
    expect(expanded.join('\n')).toContain('detail one');
    expect(expanded.length).toBeGreaterThan(2);

    panel.blur();
    expect(render(panel)).toHaveLength(1);
  });

  it('shows the title above the message and previews the title when folded', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert({
      id: 'tc-1',
      agentId: 'main',
      time: 0,
      title: 'Root cause found',
      text: 'Two refreshes reuse one token.\n\n- interceptor\n- visibility',
    });

    const lines = render(panel);
    const titleRow = lines.findIndex((line) => line.includes('Root cause found'));
    const bodyRow = lines.findIndex((line) => line.includes('Two refreshes reuse one token.'));
    expect(titleRow).toBe(1);
    expect(bodyRow).toBe(2);

    panel.setEnded(true);
    const collapsed = render(panel);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toContain('Root cause found');
    expect(collapsed[0]).not.toContain('Two refreshes');
  });

  it('stays expanded when the turn ends while the user is reading, folds on blur', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'phase one'));
    panel.focus();
    panel.setEnded(true);

    expect(render(panel).join('\n')).toContain('phase one');

    panel.blur();
    expect(render(panel)).toHaveLength(1);
  });

  it('unfolds and undims when a fresh update arrives after the turn ended', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'done with phase one'));
    panel.setEnded(true);
    expect(render(panel)).toHaveLength(1);

    panel.upsert(entry('tc-2', 'fresh turn update'));
    const lines = render(panel);
    expect(lines.join('\n')).toContain('fresh turn update');
    expect(lines[0]).not.toContain('turn ended');
  });

  it('removes an entry and drops empty channels', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'main one'));
    panel.upsert(entry('a0:c1', 'explore one', 'a0', 'explore'));

    expect(panel.remove('a0:c1')).toBe(true);
    expect(panel.getChannels().map((ch) => ch.label)).toEqual(['main']);
    expect(panel.remove('missing')).toBe(false);
  });

  it('clamps the page when the newest entry is removed', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'first'));
    panel.upsert(entry('tc-2', 'second'));
    expect(titleOf(panel)).toContain('Updates ← 2/2 →');

    expect(panel.remove('tc-2')).toBe(true);
    expect(titleOf(panel)).toContain('Updates · ctrl+n to browse');
    expect(panel.nextPage()).toBe(false);
  });

  it('releases focus when removal empties the panel', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'only'));
    expect(panel.focus()).toBe(true);

    expect(panel.remove('tc-1')).toBe(true);
    expect(panel.isEmpty()).toBe(true);
    expect(panel.isFocused()).toBe(false);
    expect(panel.prevPage()).toBe(false);
    expect(panel.nextPage()).toBe(false);
  });

  it('clears the unread count when a retracted entry was unread', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'main one'));
    panel.upsert(entry('a0:c1', 'explore one', 'a0', 'explore'));
    expect(panel.focus()).toBe(true);

    panel.upsert(entry('tc-2', 'main two'));
    const before = panel.getChannels().find((ch) => ch.label === 'main');
    expect(before?.unread).toBe(1);

    expect(panel.remove('tc-2')).toBe(true);
    const after = panel.getChannels().find((ch) => ch.label === 'main');
    expect(after?.unread).toBe(0);
  });

  it('keeps the unread count when a retracted entry was already read', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'main one'));
    panel.upsert(entry('a0:c1', 'explore one', 'a0', 'explore'));
    expect(panel.focus()).toBe(true);

    panel.upsert(entry('tc-2', 'delegation'));
    expect(panel.getChannels().find((ch) => ch.label === 'main')?.unread).toBe(1);

    expect(panel.prevChannel()).toBe(true);
    expect(panel.nextChannel()).toBe(true);
    panel.upsert(entry('tc-3', 'main three'));
    expect(panel.getChannels().find((ch) => ch.label === 'main')?.unread).toBe(1);

    expect(panel.remove('tc-2')).toBe(true);
    expect(panel.getChannels().find((ch) => ch.label === 'main')?.unread).toBe(1);
  });

  it('dims to a stub and notes the ended turn, and clears wholesale', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'done with phase one'));
    panel.setEnded(true);
    expect(render(panel)).toHaveLength(1);
    expect(titleOf(panel)).toContain('ctrl+n');

    panel.clearUpdates();
    expect(panel.isEmpty()).toBe(true);
    expect(panel.render(80)).toEqual([]);

    panel.upsert(entry('tc-2', 'fresh turn'));
    expect(titleOf(panel)).not.toContain('turn ended');
  });

  it('never renders wider than the requested width', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', `${'word '.repeat(60)}\n\n- a very long bullet ${'x'.repeat(120)}`));
    panel.upsert(entry('a1:c1', listRows(12, 'later'), 'a1', 'explore'));
    for (const width of [24, 40, 80]) {
      for (const line of panel.render(width)) {
        expect(strip(line).length).toBeLessThanOrEqual(width);
      }
    }
  });

  it('caps a docked body at its rows while an inline one keeps every row', () => {
    const docked = new NotifyPanelComponent({ maxBodyRows: 6 });
    docked.upsert({ ...entry('tc-1', listRows(10)), title: 'Long update' });
    const lines = render(docked);
    expect(lines).toHaveLength(7);
    expect(lines[1]).toContain('Long update');
    expect(lines.at(-1)).toContain('row 5');
  });

  it('shrinks to a summary of the asking agent while a prompt waits, and refuses focus', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert({ ...entry('a0:c1', 'details', 'a0', 'explore'), title: 'Checking the auth tests' });
    panel.upsert({ ...entry('tc-1', 'main is planning'), time: 1 });
    panel.focus();

    panel.setPrompt({ agentId: 'a0' });
    expect(render(panel)).toEqual([' ▸ explore · Checking the auth tests']);
    expect(panel.isFocused()).toBe(false);
    expect(panel.focus()).toBe(false);

    panel.setPrompt({ agentId: 'agent-without-updates' });
    expect(render(panel)).toEqual([' ▸ main · main is planning']);

    panel.setPrompt(undefined);
    expect(titleOf(panel)).toContain('Updates · ctrl+n to browse');
    expect(panel.focus()).toBe(true);
  });

  it('switches channel, pages and closes on clicks in the head, focusing the panel', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'main one'));
    panel.upsert(entry('tc-2', 'main two'));
    panel.upsert(entry('a0:c1', 'explore one', 'a0', 'explore'));

    click(panel, 'main');
    expect(panel.isFocused()).toBe(true);
    expect(titleOf(panel)).toContain('Updates ← 2/2 →');
    click(panel, '←');
    expect(render(panel).join('\n')).toContain('main one');
    click(panel, '→');
    expect(render(panel).join('\n')).toContain('main two');
    click(panel, 'esc close');
    expect(panel.isFocused()).toBe(false);
  });

  it('opens the folded stub on a click', () => {
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'phase one'));
    panel.setEnded(true);
    click(panel, 'ctrl+n to expand');
    expect(panel.isFocused()).toBe(true);
    expect(render(panel).join('\n')).toContain('phase one');
  });

  it('underlines the head segment under the pointer', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    onTestFinished(() => {
      chalk.level = previousLevel;
    });
    const panel = new NotifyPanelComponent();
    panel.upsert(entry('tc-1', 'main one'));
    panel.upsert(entry('a0:c1', 'explore one', 'a0', 'explore'));
    const underline = '\u001B[4m';
    expect(panel.render(80)[0]).not.toContain(underline);

    const x = titleOf(panel).indexOf('main');
    expect(panel.handleMouse(mouse('move', x))).toMatchObject({ handled: true, render: true });
    expect(panel.render(80)[0]).toContain(`${underline}`);
    expect(strip(panel.render(80)[0]!)).toBe(titleOf(panel));
    expect(panel.handleMouse(mouse('move', 0))).toMatchObject({ handled: true, render: true });
    expect(panel.render(80)[0]).not.toContain(underline);
  });
});
