import type { Component } from '@moonshot-ai/pi-tui';
import { UndoRef } from '@moonshot-ai/agent-core';

import { WelcomeComponent } from '../components/chrome/welcome';
import { CompactionComponent } from '../components/dialogs/compaction';
import {
  UndoSelectorComponent,
  type UndoChoice,
} from '../components/dialogs/undo-selector';
import { AgentGroupComponent } from '../components/messages/agent-group';
import { AssistantMessageComponent } from '../components/messages/assistant-message';
import { CronMessageComponent } from '../components/messages/cron-message';
import { ReadGroupComponent } from '../components/messages/read-group';
import { SkillActivationComponent } from '../components/messages/skill-activation';
import { ThinkingComponent } from '../components/messages/thinking';
import { ToolCallComponent } from '../components/messages/tool-call';
import { UserMessageComponent } from '../components/messages/user-message';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import type { TranscriptEntry } from '../types';
import { formatErrorMessage } from '../utils/errors';
import { getTranscriptComponentEntry } from '../utils/transcript-component-metadata';
import { nextTranscriptId } from '../utils/transcript-id';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Undo command
// ---------------------------------------------------------------------------

interface UndoAvailability {
  readonly maxCount: number;
  readonly stoppedAtCompaction: boolean;
}

const UNDO_LIMIT_STATUS_TURN_ID = 'undo-limit-status';

export async function handleUndoCommand(
  host: SlashCommandHost,
  args: string = '',
): Promise<void> {
  if (host.state.appState.streamingPhase !== 'idle') {
    host.showError('Cannot undo while streaming — press Esc or Ctrl-C first.');
    return;
  }

  const trimmed = args.trim();
  if (trimmed.length === 0) {
    await showUndoSelector(host);
    return;
  }

  const count = parseUndoCount(trimmed);
  if (count === undefined) {
    host.showError('Usage: /undo [count], where count is a positive integer.');
    return;
  }

  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const availability = resolveUndoAvailability(host);
  if (count > availability.maxCount) {
    showUndoLimitStatus(host, formatUndoLimitMessage(count, availability));
    return;
  }

  await undoByCount(host, count);
}

async function undoByCount(host: SlashCommandHost, count: number): Promise<boolean> {
  const main = host.mainAgent();
  if (main === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return false;
  }

  const entries = host.state.transcriptEntries;
  const lastUserIndex = findUndoAnchorEntryIndex(entries, count);
  if (lastUserIndex === undefined) {
    showUndoLimitStatus(host, 'Nothing to undo.');
    return false;
  }

  const undoFace = main.resolve(UndoRef);
  if (undoFace === undefined) {
    host.showError('Failed to undo: undo feature is not installed');
    return false;
  }
  try {
    await undoFace.undo(count);
  } catch (error) {
    const message = formatErrorMessage(error);
    host.showError(`Failed to undo: ${message}`);
    return false;
  }

  const children = host.state.transcriptContainer.children;
  const lastUserComponentIndex = findUndoAnchorComponentIndex(children, count);
  if (lastUserComponentIndex !== undefined) {
    // Structural removal only: the container's ref-checked render cache
    // detects the child-list change; no tree-wide invalidate needed.
    removeUndoContextComponents(children, lastUserComponentIndex);
  }

  const preservedEntries = entries.filter(
    (entry, index) => !(index >= lastUserIndex && isUndoContextEntry(entry)),
  );
  entries.splice(0, entries.length, ...preservedEntries);

  if (entries.length === 0) {
    renderWelcome(host);
  }

  host.state.ui.requestRender();
  return true;
}

async function showUndoSelector(host: SlashCommandHost): Promise<void> {
  if (host.session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const availability = resolveUndoAvailability(host);
  const choices = createUndoChoices(
    host.state.transcriptEntries,
    host.state.transcriptContainer.children,
    availability.maxCount,
  );
  if (choices.length === 0) {
    showUndoLimitStatus(host, formatNothingToUndoMessage(availability));
    return;
  }

  host.mountEditorReplacement(
    new UndoSelectorComponent({
      choices,
      onSelect: (choice) => {
        void undoByCount(host, choice.count).then((undone) => {
          if (undone) {
            host.restoreInputText(choice.input);
            return;
          }
          host.restoreEditor();
        });
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function parseUndoCount(args: string): number | undefined {
  const value = args.trim();
  if (value.length === 0) return 1;
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
}

function resolveUndoAvailability(host: SlashCommandHost): UndoAvailability {
  const { anchors, stoppedAtCompaction } = activeUndoAnchorEntries(
    host.state.transcriptEntries,
    host.state.transcriptContainer.children,
  );
  const engine = engineUndoAvailability(host);
  return {
    maxCount: engine === undefined ? anchors.length : Math.min(anchors.length, engine.maxCount),
    stoppedAtCompaction: stoppedAtCompaction || (engine?.stoppedAtCompaction ?? false),
  };
}

function engineUndoAvailability(host: SlashCommandHost): UndoAvailability | undefined {
  const main = host.mainAgent();
  if (main === undefined) return undefined;
  const undo = main.resolve(UndoRef);
  if (undo === undefined) return undefined;
  const availability = undo.availability();
  return { maxCount: availability.maxTurns, stoppedAtCompaction: availability.stoppedAtCompaction };
}

function createUndoChoices(
  entries: readonly TranscriptEntry[],
  children: readonly Component[],
  maxCount: number,
): readonly UndoChoice[] {
  if (maxCount <= 0) return [];
  const anchors = activeUndoAnchorEntries(entries, children).anchors.slice(-maxCount);
  return anchors.map((entry, index) => ({
    id: entry.id,
    count: anchors.length - index,
    input: formatUndoChoiceInput(entry),
    label: formatUndoChoiceLabel(entry),
  }));
}

function activeUndoAnchorEntries(
  entries: readonly TranscriptEntry[],
  children: readonly Component[],
): { readonly anchors: readonly TranscriptEntry[]; readonly stoppedAtCompaction: boolean } {
  const lastCompactionChildIndex = children.findLastIndex(
    (child) => child instanceof CompactionComponent,
  );
  if (lastCompactionChildIndex >= 0) {
    return {
      anchors: children
        .slice(lastCompactionChildIndex + 1)
        .map((child) => getTranscriptComponentEntry(child))
        .filter((entry): entry is TranscriptEntry => entry !== undefined)
        .filter(isUndoAnchorEntry),
      stoppedAtCompaction: true,
    };
  }

  const lastCompactionEntryIndex = entries.findLastIndex(
    (entry) => entry.compactionData !== undefined,
  );
  const activeEntries =
    lastCompactionEntryIndex >= 0 ? entries.slice(lastCompactionEntryIndex + 1) : entries;
  return {
    anchors: activeEntries.filter(isUndoAnchorEntry),
    stoppedAtCompaction: lastCompactionEntryIndex >= 0,
  };
}

function formatUndoChoiceLabel(
  entry: TranscriptEntry,
): string {
  if (entry.kind === 'skill_activation') {
    const name = singleLine(
      entry.skillName ?? entry.content.replace(/^Activated skill:\s*/, ''),
    );
    const args = singleLine(entry.skillArgs ?? '');
    if (name.length === 0) return 'Skill: unknown';
    return args.length > 0 ? `/${name} ${args}` : `/${name}`;
  }

  const content = singleLine(entry.content);
  const imageCount = entry.imageAttachmentIds?.length ?? 0;
  if (content.length > 0) return content;
  if (imageCount > 0) {
    return `User message (${String(imageCount)} ${imageCount === 1 ? 'image' : 'images'})`;
  }
  return 'User message';
}

function formatUndoChoiceInput(entry: TranscriptEntry): string {
  if (entry.kind === 'skill_activation') {
    const name = singleLine(
      entry.skillName ?? entry.content.replace(/^Activated skill:\s*/, ''),
    );
    const args = singleLine(entry.skillArgs ?? '');
    if (name.length === 0) return '';
    return args.length > 0 ? `/${name} ${args}` : `/${name}`;
  }
  return entry.content;
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function formatUndoLimitMessage(
  requestedCount: number,
  availability: UndoAvailability,
): string {
  const reason = availability.stoppedAtCompaction ? ' after the last compaction' : '';
  const requested = formatPromptCount(requestedCount);
  const max = formatPromptCount(availability.maxCount);
  return `Cannot undo ${requested}; only ${max} can be undone in the active context${reason}.`;
}

function formatNothingToUndoMessage(availability: UndoAvailability): string {
  if (availability.stoppedAtCompaction) {
    return 'Nothing to undo after the last compaction.';
  }
  return 'Nothing to undo.';
}

function formatPromptCount(count: number): string {
  return `${String(count)} ${count === 1 ? 'prompt' : 'prompts'}`;
}

function showUndoLimitStatus(host: SlashCommandHost, message: string): void {
  host.appendTranscriptEntry({
    id: nextTranscriptId(),
    kind: 'status',
    turnId: UNDO_LIMIT_STATUS_TURN_ID,
    renderMode: 'plain',
    content: message,
  });
}

function isUndoAnchorEntry(entry: TranscriptEntry): boolean {
  return (
    entry.kind === 'user' ||
    (entry.kind === 'skill_activation' && entry.skillTrigger === 'user-slash')
  );
}

function findUndoAnchorEntryIndex(
  entries: readonly TranscriptEntry[],
  count: number,
): number | undefined {
  let found = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry !== undefined && isUndoAnchorEntry(entry)) {
      found++;
      if (found === count) return i;
    }
  }
  return undefined;
}

function isUndoContextEntry(entry: TranscriptEntry): boolean {
  switch (entry.kind) {
    case 'user':
    case 'assistant':
    case 'tool_call':
    case 'thinking':
    case 'skill_activation':
    case 'cron':
      return true;
    case 'status':
      return entry.turnId !== undefined;
    case 'welcome':
      return false;
  }
}

function findUndoAnchorComponentIndex(
  children: readonly Component[],
  count: number,
): number | undefined {
  let found = 0;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child !== undefined && isUndoAnchorComponent(child)) {
      found++;
      if (found === count) return i;
    }
  }
  return undefined;
}

function removeUndoContextComponents(
  children: Component[],
  startIndex: number,
): void {
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child !== undefined && i >= startIndex && isUndoContextComponent(child)) {
      children.splice(i, 1);
    }
  }
}

function isUndoAnchorComponent(child: Component): boolean {
  return (
    child instanceof UserMessageComponent ||
    (child instanceof SkillActivationComponent && child.trigger === 'user-slash')
  );
}

function isUndoContextComponent(child: Component): boolean {
  const entry = getTranscriptComponentEntry(child);
  if (entry !== undefined) {
    return isUndoContextEntry(entry);
  }

  return (
    child instanceof UserMessageComponent ||
    child instanceof AssistantMessageComponent ||
    child instanceof ThinkingComponent ||
    child instanceof ToolCallComponent ||
    child instanceof AgentGroupComponent ||
    child instanceof ReadGroupComponent ||
    child instanceof SkillActivationComponent ||
    child instanceof CronMessageComponent
  );
}

function renderWelcome(host: SlashCommandHost): void {
  if (
    host.state.transcriptContainer.children.some(
      (child) => child instanceof WelcomeComponent,
    )
  ) {
    return;
  }
  host.state.transcriptContainer.addChild(
    new WelcomeComponent(host.state.appState),
  );
}
