import {
  Container,
  Key,
  matchesKey,
  type Terminal,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';
import type { TaskRecord, TaskStatus } from '@moonshot-ai/harness-core';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';

const ELLIPSIS = '…';

export type TasksFilter = 'all' | 'active';

export interface TaskRow {
  readonly record: TaskRecord;
  readonly agentId?: string;
}

export interface TasksBrowserProps {
  readonly tasks: readonly TaskRow[];
  readonly filter: TasksFilter;
  readonly selectedTaskId: string | undefined;
  readonly flashMessage: string | undefined;
  readonly onSelect: (taskId: string) => void;
  readonly onToggleFilter: () => void;
  readonly onCancel: () => void;
  readonly onStopConfirmed: (taskId: string) => void;
  readonly onOpenOutput: (taskId: string) => void;
  readonly onStopIgnored?: (taskId: string, reason: 'terminal') => void;
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  killed: 'killed',
  lost: 'lost',
};

const STOP_CONFIRM_TIMEOUT_MS = 5_000;

const MIN_WIDTH = 48;
const MIN_HEIGHT = 10;

const LIST_COL_MIN = 28;
const LIST_COL_MAX = 44;
const LIST_COL_RATIO = 0.32;

export function taskStatusColor(status: TaskStatus): 'success' | 'textMuted' | 'error' {
  switch (status) {
    case 'running':
      return 'success';
    case 'completed':
      return 'textMuted';
    case 'failed':
    case 'killed':
    case 'lost':
      return 'error';
  }
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status !== 'running';
}

function formatRelativeTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts) || ts <= 0) return '';
  const diffSec = Math.floor(Math.max(0, Date.now() - ts) / 1000);
  if (diffSec < 60) return 'just now';
  const minutes = Math.floor(diffSec / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function padToWidth(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w === width) return line;
  if (w > width) return truncateToWidth(line, width, ELLIPSIS);
  return line + ' '.repeat(width - w);
}

function fitExactly(line: string, width: number): string {
  let s = line;
  if (visibleWidth(s) > width) s = truncateToWidth(s, width, ELLIPSIS);
  return padToWidth(s, width);
}

function visibleTasks(tasks: readonly TaskRow[], filter: TasksFilter): TaskRow[] {
  if (filter === 'all') return [...tasks];
  return tasks.filter((row) => !isTerminalTaskStatus(row.record.status));
}

function compareTasks(a: TaskRow, b: TaskRow): number {
  const aTerminal = isTerminalTaskStatus(a.record.status);
  const bTerminal = isTerminalTaskStatus(b.record.status);
  if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
  if (!aTerminal) return a.record.startedAt - b.record.startedAt;
  return (b.record.endedAt ?? b.record.startedAt) - (a.record.endedAt ?? a.record.startedAt);
}

export function previewOutputOf(row: TaskRow | undefined): string {
  if (row === undefined) return '';
  const { record } = row;
  if (record.output !== undefined && record.output.length > 0) return record.output;
  if (record.detachText !== undefined && record.detachText.length > 0) return record.detachText;
  return '';
}

export class TasksBrowserApp extends Container implements Focusable {
  focused = false;

  private props: TasksBrowserProps;
  private readonly terminal: Terminal;
  private sortedVisible: TaskRow[];
  private selectedIndex = 0;
  private listScroll = 0;
  private pendingStopTaskId: string | undefined = undefined;
  private pendingStopTimer: NodeJS.Timeout | undefined = undefined;

  constructor(props: TasksBrowserProps, terminal: Terminal) {
    super();
    this.props = props;
    this.terminal = terminal;
    this.sortedVisible = visibleTasks(props.tasks, props.filter).toSorted(compareTasks);
    this.syncSelectionFromProps();
  }

  setProps(next: TasksBrowserProps): void {
    this.props = next;
    this.sortedVisible = visibleTasks(next.tasks, next.filter).toSorted(compareTasks);
    this.syncSelectionFromProps();
    if (this.pendingStopTaskId !== undefined) {
      const task = next.tasks.find((row) => row.record.taskId === this.pendingStopTaskId);
      if (task === undefined || isTerminalTaskStatus(task.record.status)) this.clearPendingStop();
    }
    this.invalidate();
  }

  private syncSelectionFromProps(): void {
    if (this.sortedVisible.length === 0) {
      this.selectedIndex = 0;
      this.listScroll = 0;
      return;
    }
    if (this.props.selectedTaskId !== undefined) {
      const idx = this.sortedVisible.findIndex(
        (row) => row.record.taskId === this.props.selectedTaskId,
      );
      if (idx !== -1) {
        this.selectedIndex = idx;
        return;
      }
    }
    if (this.selectedIndex >= this.sortedVisible.length) {
      this.selectedIndex = this.sortedVisible.length - 1;
    }
  }

  private clearPendingStop(): void {
    this.pendingStopTaskId = undefined;
    if (this.pendingStopTimer !== undefined) {
      clearTimeout(this.pendingStopTimer);
      this.pendingStopTimer = undefined;
    }
  }

  private emitSelect(): void {
    const row = this.sortedVisible[this.selectedIndex];
    if (row !== undefined) this.props.onSelect(row.record.taskId);
  }

  handleInput(data: string): void {
    const k = printableChar(data);

    if (this.pendingStopTaskId !== undefined) {
      if (k === 'y' || k === 'Y') {
        const taskId = this.pendingStopTaskId;
        this.clearPendingStop();
        this.props.onStopConfirmed(taskId);
        this.invalidate();
        return;
      }
      this.clearPendingStop();
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.escape) || k === 'q' || k === 'Q') {
      this.props.onCancel();
      return;
    }
    if (matchesKey(data, Key.up) || k === 'k') {
      if (this.sortedVisible.length === 0) return;
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.emitSelect();
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down) || k === 'j') {
      if (this.sortedVisible.length === 0) return;
      this.selectedIndex = Math.min(this.sortedVisible.length - 1, this.selectedIndex + 1);
      this.emitSelect();
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.tab) || k === '\t') {
      this.props.onToggleFilter();
      return;
    }
    if (k === 's' || k === 'S') {
      const row = this.sortedVisible[this.selectedIndex];
      if (row === undefined) return;
      if (isTerminalTaskStatus(row.record.status)) {
        this.props.onStopIgnored?.(row.record.taskId, 'terminal');
        return;
      }
      this.pendingStopTaskId = row.record.taskId;
      this.pendingStopTimer = setTimeout(() => {
        this.clearPendingStop();
        this.invalidate();
      }, STOP_CONFIRM_TIMEOUT_MS);
      this.invalidate();
      return;
    }
    if (k === 'o' || k === 'O' || matchesKey(data, Key.enter)) {
      const row = this.sortedVisible[this.selectedIndex];
      if (row !== undefined) this.props.onOpenOutput(row.record.taskId);
      return;
    }
  }

  override render(width: number): string[] {
    const rows = Math.max(1, this.terminal.rows);
    if (width < MIN_WIDTH || rows < MIN_HEIGHT) {
      return this.renderTooSmall(width, rows);
    }

    const header = this.renderHeader(width);
    const footer = this.renderFooter(width);
    const bodyHeight = rows - 2;

    const listWidth = Math.max(
      LIST_COL_MIN,
      Math.min(LIST_COL_MAX, Math.floor(width * LIST_COL_RATIO)),
    );
    const rightWidth = width - listWidth;

    const listFrame = this.renderListFrame(listWidth, bodyHeight);
    const rightFrames = this.renderRightStack(rightWidth, bodyHeight);

    const lines: string[] = [header];
    for (let i = 0; i < bodyHeight; i++) {
      lines.push((listFrame[i] ?? ' '.repeat(listWidth)) + (rightFrames[i] ?? ' '.repeat(rightWidth)));
    }
    lines.push(footer);
    return lines;
  }

  private renderHeader(width: number): string {
    const title = currentTheme.boldFg('primary', ' TASK BROWSER ');
    const filterText = currentTheme.fg(
      'textMuted',
      ` filter=${this.props.filter === 'all' ? 'ALL' : 'ACTIVE'} `,
    );
    const visible = visibleTasks(this.props.tasks, this.props.filter);
    let running = 0;
    let completed = 0;
    let interrupted = 0;
    for (const row of visible) {
      if (row.record.status === 'running') running += 1;
      else if (row.record.status === 'completed') completed += 1;
      else interrupted += 1;
    }
    const countSegments: string[] = [];
    if (running > 0) countSegments.push(currentTheme.fg('success', ` ${String(running)} running `));
    if (completed > 0)
      countSegments.push(currentTheme.fg('textDim', ` ${String(completed)} completed `));
    if (interrupted > 0)
      countSegments.push(currentTheme.fg('error', ` ${String(interrupted)} interrupted `));
    const totals = currentTheme.fg('textMuted', ` ${String(visible.length)} total `);

    const composed = title + filterText + countSegments.join('') + totals;
    return fitExactly(composed, width);
  }

  private renderFooter(width: number): string {
    const key = (text: string): string => currentTheme.boldFg('primary', text);
    const dim = (text: string): string => currentTheme.fg('textMuted', text);

    if (this.pendingStopTaskId !== undefined) {
      const warn = (text: string): string => currentTheme.boldFg('warning', text);
      const line =
        ` ${warn('Stop')} ${currentTheme.fg('text', this.pendingStopTaskId)}? ` +
        `${key('Y')} ${dim('confirm')}  ${key('N')}${dim('/')}${key('esc')} ${dim('cancel')} `;
      return fitExactly(line, width);
    }

    const parts = [
      ` ${key('↑↓')} ${dim('select')}`,
      `${key('Enter/O')} ${dim('output')}`,
      `${key('S')} ${dim('stop')}`,
      `${key('Tab')} ${dim('filter')}`,
      `${key('Q/Esc')} ${dim('cancel')} `,
    ];
    const left = parts.join('  ');
    const flash = this.props.flashMessage;
    if (flash !== undefined && flash.length > 0) {
      const flashStyled = currentTheme.fg('warning', ` ${flash} `);
      const total = visibleWidth(left) + visibleWidth(flashStyled);
      if (total <= width) {
        return left + ' '.repeat(width - total) + flashStyled;
      }
    }
    return fitExactly(left, width);
  }

  private renderFrame(
    title: string,
    content: readonly string[],
    width: number,
    height: number,
  ): string[] {
    if (height < 2 || width < 4) {
      const out: string[] = [];
      for (let i = 0; i < height; i++) out.push(' '.repeat(width));
      return out;
    }
    const innerWidth = width - 2;
    const innerHeight = height - 2;

    const titleStyled = currentTheme.boldFg('textStrong', title);
    const titleWidth = visibleWidth(titleStyled);
    const titleSegment = `─ ${titleStyled} `;
    const titleSegmentWidth = visibleWidth(titleSegment);
    const remainingDashes = Math.max(0, innerWidth - titleSegmentWidth);
    const topMid =
      titleWidth > 0 && titleSegmentWidth <= innerWidth
        ? currentTheme.fg('primary', '─ ') +
          titleStyled +
          ' ' +
          currentTheme.fg('primary', '─'.repeat(remainingDashes))
        : currentTheme.fg('primary', '─'.repeat(innerWidth));
    const top = currentTheme.fg('primary', '┌') + topMid + currentTheme.fg('primary', '┐');
    const bottom = currentTheme.fg('primary', '└' + '─'.repeat(innerWidth) + '┘');

    const lines: string[] = [top];
    for (let i = 0; i < innerHeight; i++) {
      const inner = content[i] ?? '';
      lines.push(currentTheme.fg('primary', '│') + fitExactly(inner, innerWidth) + currentTheme.fg('primary', '│'));
    }
    lines.push(bottom);
    return lines;
  }

  private renderListFrame(width: number, height: number): string[] {
    const title = `Tasks [${this.props.filter}]`;
    const innerHeight = Math.max(0, height - 2);

    if (this.sortedVisible.length === 0) {
      const empty =
        this.props.filter === 'active'
          ? 'No active tasks. Tab = show all.'
          : 'No background tasks in this session.';
      const lines: string[] = [currentTheme.fg('textMuted', empty)];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame(title, lines, width, height);
    }

    this.adjustScroll(innerHeight);

    const innerWidth = width - 2;
    const allLines: string[] = [];
    for (const [index, row] of this.sortedVisible.entries()) {
      allLines.push(this.renderListRow(row, index === this.selectedIndex, innerWidth));
    }
    const lines = allLines.slice(this.listScroll, this.listScroll + innerHeight);
    while (lines.length < innerHeight) lines.push('');

    return this.renderFrame(title, lines, width, height);
  }

  private renderListRow(row: TaskRow, selected: boolean, innerWidth: number): string {
    const pointer = selected ? `${SELECT_POINTER} ` : '  ';
    const pointerStyled = currentTheme.fg(selected ? 'primary' : 'textDim', pointer);

    const idColor = selected
      ? 'primary'
      : row.record.toolName === 'Agent' || row.record.toolName === 'AgentSwarm'
        ? 'success'
        : 'accent';
    const idText = selected
      ? currentTheme.boldFg(idColor, row.record.taskId)
      : currentTheme.fg(idColor, row.record.taskId);
    const idPad = ' '.repeat(Math.max(0, 17 - row.record.taskId.length));

    const status = TASK_STATUS_LABEL[row.record.status];
    const statusBadge = currentTheme.fg(taskStatusColor(row.record.status), status);

    const prefix = `${pointerStyled}${idText}${idPad} ${statusBadge}`;
    const prefixWidth = visibleWidth(prefix);
    const descBudget = Math.max(0, innerWidth - prefixWidth - 1);
    if (descBudget < 4) return fitExactly(prefix, innerWidth);

    const description = singleLine(row.record.description ?? '') || '(no description)';
    const desc = truncateToWidth(description, descBudget, ELLIPSIS);
    return fitExactly(`${prefix} ${currentTheme.fg('text', desc)}`, innerWidth);
  }

  private adjustScroll(visibleRows: number): void {
    if (visibleRows <= 0) {
      this.listScroll = 0;
      return;
    }
    if (this.selectedIndex < this.listScroll) {
      this.listScroll = this.selectedIndex;
    } else if (this.selectedIndex >= this.listScroll + visibleRows) {
      this.listScroll = this.selectedIndex - visibleRows + 1;
    }
    const maxScroll = Math.max(0, this.sortedVisible.length - visibleRows);
    if (this.listScroll < 0) this.listScroll = 0;
    if (this.listScroll > maxScroll) this.listScroll = maxScroll;
  }

  private renderRightStack(width: number, height: number): string[] {
    const detailHeight = Math.min(
      Math.max(10, Math.min(Math.floor(height * 0.4), height - 5)),
      Math.max(3, height - 3),
    );
    const previewHeight = height - detailHeight;
    return [
      ...this.renderDetailFrame(width, detailHeight),
      ...this.renderPreviewFrame(width, previewHeight),
    ];
  }

  private renderDetailFrame(width: number, height: number): string[] {
    const innerHeight = Math.max(0, height - 2);
    const row = this.sortedVisible[this.selectedIndex];
    if (row === undefined) {
      const empty = currentTheme.fg('textMuted', 'Select a task from the list.');
      const lines: string[] = [empty];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame('Detail', lines, width, height);
    }

    const { record } = row;
    const label = (text: string): string => currentTheme.fg('textMuted', text.padEnd(14));
    const value = (text: string): string => currentTheme.fg('text', text);

    const lines: string[] = [
      `${label('Task ID:')}${value(record.taskId)}`,
      `${label('Status:')}${currentTheme.fg(taskStatusColor(record.status), TASK_STATUS_LABEL[record.status])}`,
      `${label('Tool:')}${value(record.toolName)}`,
      `${label('Description:')}${value(singleLine(record.description ?? '') || '—')}`,
    ];
    if (row.agentId !== undefined) {
      lines.push(`${label('Agent ID:')}${value(row.agentId)}`);
    }
    const timing =
      record.status === 'running'
        ? `running ${formatRelativeTime(record.startedAt)}`
        : record.endedAt !== undefined
          ? `finished ${formatRelativeTime(record.endedAt)}`
          : '';
    if (timing.length > 0) lines.push(`${label('Time:')}${currentTheme.fg('textMuted', timing)}`);
    if (record.stopReason !== undefined && record.stopReason.length > 0) {
      lines.push(`${label('Reason:')}${currentTheme.fg('textMuted', singleLine(record.stopReason))}`);
    }
    while (lines.length < innerHeight) lines.push('');
    return this.renderFrame('Detail', lines, width, height);
  }

  private renderPreviewFrame(width: number, height: number): string[] {
    const innerHeight = Math.max(0, height - 2);
    const row = this.sortedVisible[this.selectedIndex];
    if (row === undefined) {
      const lines: string[] = [currentTheme.fg('textMuted', 'No task selected.')];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame('Preview Output', lines, width, height);
    }

    const output = previewOutputOf(row);
    const body =
      output.length === 0
        ? '[no output captured]'
        : sanitizeShellOutput(output);

    const rawLines = body.split('\n');
    const tailLines = rawLines.slice(-innerHeight);
    const styled = tailLines.map((line) => currentTheme.fg('textDim', line));
    while (styled.length < innerHeight) styled.push('');
    return this.renderFrame('Preview Output', styled, width, height);
  }

  private renderTooSmall(width: number, rows: number): string[] {
    const lines: string[] = [];
    const msg = currentTheme.fg(
      'error',
      `Terminal too small (need ≥ ${String(MIN_WIDTH)} × ${String(MIN_HEIGHT)})`,
    );
    lines.push(fitExactly(msg, width));
    for (let i = 1; i < rows; i++) lines.push(' '.repeat(width));
    return lines;
  }
}
