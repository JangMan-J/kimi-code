import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOUBLE_ESC_WINDOW_MS } from '#/tui/constant/kimi-tui';
import {
  EditorKeyboardController,
  type EditorKeyboardHost,
} from '#/tui/controllers/editor-keyboard';
import type { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';

interface Harness {
  readonly host: EditorKeyboardHost;
  readonly editor: Record<string, ((...args: never[]) => unknown) | undefined>;
  readonly openUndoSelector: ReturnType<typeof vi.fn>;
  readonly cancelOngoingWork: ReturnType<typeof vi.fn>;
  readonly cancelCurrentCompaction: ReturnType<typeof vi.fn>;
  readonly survey: {
    readonly handlePreInput: ReturnType<typeof vi.fn<(data: string) => boolean>>;
    readonly handleSubmit: ReturnType<typeof vi.fn<(text: string) => boolean>>;
    readonly handleEditorChange: ReturnType<typeof vi.fn<(text: string) => void>>;
    readonly closeSilently: ReturnType<typeof vi.fn<() => void>>;
  };
}

function createHarness(options: { streamingPhase?: string; isCompacting?: boolean } = {}): Harness {
  const editor: Record<string, ((...args: never[]) => unknown) | undefined> = {
    setHistoryFilter: vi.fn() as unknown as (...args: never[]) => unknown,
    setInputMode: vi.fn() as unknown as (...args: never[]) => unknown,
    getText: vi.fn(() => '') as unknown as (...args: never[]) => unknown,
    setText: vi.fn() as unknown as (...args: never[]) => unknown,
  };
  const openUndoSelector = vi.fn();
  const cancelOngoingWork = vi.fn();
  const cancelCurrentCompaction = vi.fn();
  const survey = {
    handlePreInput: vi.fn<(data: string) => boolean>(() => false),
    handleSubmit: vi.fn<(text: string) => boolean>(() => false),
    handleEditorChange: vi.fn<(text: string) => void>(() => {}),
    closeSilently: vi.fn<() => void>(() => {}),
  };
  const host = {
    state: {
      editor,
      activeDialog: null,
      appState: {
        streamingPhase: options.streamingPhase ?? 'idle',
        isCompacting: options.isCompacting ?? false,
        editorCommand: null,
      },
      footer: { setTransientHint: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: { id: 's1' },
    surveyController: survey,
    btwPanelController: {
      isActive: () => false,
      clear: vi.fn(),
      closeOrCancel: vi.fn(() => false),
      cancelRunning: vi.fn(() => false),
      sendUserInput: vi.fn(() => false),
      scroll: vi.fn(() => false),
    },
    openUndoSelector,
    cancelOngoingWork,
    cancelCurrentCompaction,
    updateEditorBorderHighlight: vi.fn(),
    updateGoalLengthWarning: vi.fn(),
    handleUserInput: vi.fn(),
    track: vi.fn(),
    showError: vi.fn(),
    stop: vi.fn(),
  } as unknown as EditorKeyboardHost;

  const controller = new EditorKeyboardController(
    host,
    undefined as unknown as ImageAttachmentStore,
  );
  controller.install();

  return {
    host,
    editor,
    openUndoSelector,
    cancelOngoingWork,
    cancelCurrentCompaction,
    survey,
  };
}

function pressEscape(editor: Harness['editor']): void {
  const handler = editor['onEscape'];
  if (handler === undefined) throw new Error('onEscape handler not installed');
  (handler as () => void)();
}

function pressCtrlC(editor: Harness['editor']): void {
  const handler = editor['onCtrlC'];
  if (handler === undefined) throw new Error('onCtrlC handler not installed');
  (handler as () => void)();
}

function pressCtrlD(editor: Harness['editor']): void {
  const handler = editor['onCtrlD'];
  if (handler === undefined) throw new Error('onCtrlD handler not installed');
  (handler as () => void)();
}

function pressNonEscape(editor: Harness['editor']): void {
  const handler = editor['onNonEscapeInput'];
  if (handler === undefined) throw new Error('onNonEscapeInput handler not installed');
  (handler as () => void)();
}

describe('EditorKeyboardController double-Esc undo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the undo selector when Esc is pressed twice within the window while idle', () => {
    const { editor, openUndoSelector } = createHarness();

    pressEscape(editor);
    expect(openUndoSelector).not.toHaveBeenCalled();

    pressEscape(editor);
    expect(openUndoSelector).toHaveBeenCalledOnce();
  });

  it('does nothing for a single Esc while idle', () => {
    const { editor, openUndoSelector } = createHarness();

    pressEscape(editor);

    expect(openUndoSelector).not.toHaveBeenCalled();
  });

  it('does not trigger when the second Esc arrives after the window expires', () => {
    const { editor, openUndoSelector } = createHarness();

    pressEscape(editor);
    vi.advanceTimersByTime(DOUBLE_ESC_WINDOW_MS + 1);
    pressEscape(editor);

    expect(openUndoSelector).not.toHaveBeenCalled();
  });

  it('does not trigger when another key is pressed between the two Esc presses', () => {
    const { editor, openUndoSelector } = createHarness();

    pressEscape(editor);
    pressNonEscape(editor);
    pressEscape(editor);

    expect(openUndoSelector).not.toHaveBeenCalled();
  });

  it('does not trigger undo while streaming; Esc cancels the stream instead', () => {
    const { editor, openUndoSelector, cancelOngoingWork } = createHarness({
      streamingPhase: 'waiting',
    });

    pressEscape(editor);
    pressEscape(editor);

    expect(openUndoSelector).not.toHaveBeenCalled();
    expect(cancelOngoingWork).toHaveBeenCalled();
  });
});

describe('EditorKeyboardController compaction cancel', () => {
  it('Esc cancels compaction while compacting', () => {
    const { editor, cancelCurrentCompaction } = createHarness({ isCompacting: true });

    pressEscape(editor);

    expect(cancelCurrentCompaction).toHaveBeenCalledOnce();
  });

  it('Ctrl+C cancels compaction while compacting', () => {
    const { editor, cancelCurrentCompaction } = createHarness({ isCompacting: true });

    pressCtrlC(editor);

    expect(cancelCurrentCompaction).toHaveBeenCalledOnce();
  });
});

describe('EditorKeyboardController shell history recall', () => {
  type Recall = (entry: string, direction: 1 | -1) => string | undefined;
  type Mock = ReturnType<typeof vi.fn>;

  it('installs a filter that allows shell entries only in bash mode', () => {
    const { editor } = createHarness();
    const setHistoryFilter = editor['setHistoryFilter'] as unknown as Mock;
    expect(setHistoryFilter).toHaveBeenCalledOnce();
    const [filter] = setHistoryFilter.mock.calls[0] as [(entry: string) => boolean];

    (editor as unknown as { inputMode: string }).inputMode = 'prompt';
    expect(filter('!cmd')).toBe(true);
    expect(filter('hello')).toBe(true);

    (editor as unknown as { inputMode: string }).inputMode = 'bash';
    expect(filter('!cmd')).toBe(true);
    expect(filter('hello')).toBe(false);
  });

  it('locks the filter to the browse-entry mode once browsing starts', () => {
    const { editor } = createHarness();
    const setHistoryFilter = editor['setHistoryFilter'] as unknown as Mock;
    const [filter] = setHistoryFilter.mock.calls[0] as [(entry: string) => boolean];
    const save = editor['onHistoryDraftSave'] as unknown as () => unknown;

    // Enter browse from prompt mode, then simulate landing on a shell entry
    // (which flips inputMode to bash). The filter should stay locked to prompt
    // and keep allowing plain entries.
    (editor as unknown as { inputMode: string }).inputMode = 'prompt';
    save();
    (editor as unknown as { inputMode: string }).inputMode = 'bash';

    expect(filter('hello')).toBe(true);
    expect(filter('!cmd')).toBe(true);
  });

  it('strips the leading ! and switches to bash mode when recalling a shell entry', () => {
    const { editor } = createHarness();
    const onRecall = editor['onRecall'] as unknown as Recall;

    const result = onRecall('!cmd', -1);

    expect(result).toBe('cmd');
    expect(editor['setInputMode'] as unknown as Mock).toHaveBeenCalledWith('bash');
  });

  it('keeps plain entries as-is and switches to prompt mode', () => {
    const { editor } = createHarness();
    const onRecall = editor['onRecall'] as unknown as Recall;

    const result = onRecall('hello', -1);

    expect(result).toBeUndefined();
    expect(editor['setInputMode'] as unknown as Mock).toHaveBeenCalledWith('prompt');
  });

  it('saves the current input mode as the history draft host state', () => {
    const { editor } = createHarness();
    const save = editor['onHistoryDraftSave'] as unknown as () => unknown;

    (editor as unknown as { inputMode: string }).inputMode = 'prompt';
    expect(save()).toBe('prompt');

    (editor as unknown as { inputMode: string }).inputMode = 'bash';
    expect(save()).toBe('bash');
  });

  it('restores the input mode from the saved draft host state', () => {
    const { editor } = createHarness();
    const restore = editor['onHistoryDraftRestore'] as unknown as (state: unknown) => void;

    restore('prompt');

    expect(editor['setInputMode'] as unknown as Mock).toHaveBeenCalledWith('prompt');
  });
});

describe('EditorKeyboardController input changes', () => {
  function installExpandedText(
    editor: Harness['editor'],
    expanded: string,
  ): ReturnType<typeof vi.fn> {
    const getExpandedText = vi.fn(() => expanded);
    editor['getExpandedText'] = getExpandedText as unknown as (...args: never[]) => unknown;
    return getExpandedText;
  }

  it('forwards text changes to the border highlight and goal length warning', () => {
    const { host, editor } = createHarness();
    installExpandedText(editor, '/goal Ship feature X');
    const onChange = editor['onChange'] as unknown as (text: string) => void;

    onChange('/goal Ship feature X');

    expect(host.updateEditorBorderHighlight).toHaveBeenCalledWith('/goal Ship feature X');
    expect(host.updateGoalLengthWarning).toHaveBeenCalledWith('/goal Ship feature X');
  });

  it('measures the goal length warning on paste-expanded text, not the collapsed marker', () => {
    const { host, editor } = createHarness();
    const expanded = `/goal ${'x'.repeat(4001)}`;
    installExpandedText(editor, expanded);
    const onChange = editor['onChange'] as unknown as (text: string) => void;

    // The visible text only holds the collapsed paste marker.
    onChange('/goal [paste #1 +4000 chars]');

    expect(host.updateGoalLengthWarning).toHaveBeenCalledWith(expanded);
  });

  it('expands a leading paste marker because its content may start with /goal', () => {
    const { host, editor } = createHarness();
    const expanded = `/goal ${'x'.repeat(4001)}`;
    const getExpandedText = installExpandedText(editor, expanded);
    const onChange = editor['onChange'] as unknown as (text: string) => void;

    onChange('[paste #1 +4000 chars]');

    expect(getExpandedText).toHaveBeenCalled();
    expect(host.updateGoalLengthWarning).toHaveBeenCalledWith(expanded);
  });

  it('expands a paste that can complete a partially typed /goal command', () => {
    const { host, editor } = createHarness();
    const expanded = `/goal ${'x'.repeat(4001)}`;
    const getExpandedText = installExpandedText(editor, expanded);
    const onChange = editor['onChange'] as unknown as (text: string) => void;

    // Visible text is `/go[paste #1 …]`; the paste completes the command.
    onChange('/go[paste #1 +3999 chars]');

    expect(getExpandedText).toHaveBeenCalled();
    expect(host.updateGoalLengthWarning).toHaveBeenCalledWith(expanded);
  });

  it('skips paste expansion entirely for non-goal input', () => {
    const { host, editor } = createHarness();
    const getExpandedText = installExpandedText(editor, 'whatever');
    const onChange = editor['onChange'] as unknown as (text: string) => void;

    onChange('just a normal prompt');
    onChange('/help');

    expect(getExpandedText).not.toHaveBeenCalled();
    expect(host.updateGoalLengthWarning).toHaveBeenCalledWith(undefined);
  });

  it('gates on trimmed text because submit trims leading whitespace', () => {
    const { host, editor } = createHarness();
    const expanded = `/goal ${'x'.repeat(4001)}`;
    const getExpandedText = installExpandedText(editor, expanded);
    const onChange = editor['onChange'] as unknown as (text: string) => void;

    onChange(`  /goal ${'x'.repeat(4001)}`);

    expect(getExpandedText).toHaveBeenCalled();
    expect(host.updateGoalLengthWarning).toHaveBeenCalledWith(expanded);
  });

  it('skips the goal length warning in bash mode', () => {
    const { host, editor } = createHarness();
    const getExpandedText = installExpandedText(editor, '/goal x');
    (editor as unknown as { inputMode: string }).inputMode = 'bash';
    const onChange = editor['onChange'] as unknown as (text: string) => void;

    onChange('/goal x');

    expect(getExpandedText).not.toHaveBeenCalled();
    expect(host.updateGoalLengthWarning).toHaveBeenCalledWith(undefined);
  });
});

describe('EditorKeyboardController Shift-Tab plan toggle', () => {
  function createShiftTabHarness(options: { sessionless?: boolean } = {}) {
    const editor: Record<string, ((...args: never[]) => unknown) | undefined> = {
      setHistoryFilter: vi.fn() as unknown as (...args: never[]) => unknown,
    };
    const handlePlanToggle = vi.fn();
    const track = vi.fn();
    const showError = vi.fn();
    const ensureSession = vi.fn(async (): Promise<{ id: string } | undefined> => ({ id: 'ses-lazy' }));
    const host = {
      state: {
        editor,
        activeDialog: null,
        appState: { streamingPhase: 'idle', isCompacting: false, planMode: false },
        footer: { setTransientHint: vi.fn() },
        ui: { requestRender: vi.fn() },
      },
      session: options.sessionless ? undefined : { id: 's1' },
      ensureSession,
      handlePlanToggle,
      track,
      showError,
    } as unknown as EditorKeyboardHost;

    new EditorKeyboardController(host, undefined as unknown as ImageAttachmentStore).install();
    const onShiftTab = editor['onShiftTab'] as unknown as () => void;
    return { onShiftTab, handlePlanToggle, track, showError, ensureSession };
  }

  it('toggles plan mode directly with an active session', () => {
    const { onShiftTab, handlePlanToggle, ensureSession } = createShiftTabHarness();

    onShiftTab();

    expect(ensureSession).not.toHaveBeenCalled();
    expect(handlePlanToggle).toHaveBeenCalledWith(true);
  });

  it('lazy-creates the session before toggling on v2 when session-less', async () => {
    const { onShiftTab, ensureSession, handlePlanToggle, track } = createShiftTabHarness({
      sessionless: true,
    });

    onShiftTab();
    expect(handlePlanToggle).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(handlePlanToggle).toHaveBeenCalledWith(true);
    });
    expect(ensureSession).toHaveBeenCalledOnce();
    expect(track).toHaveBeenCalledWith('shortcut_plan_toggle', { enabled: true });
  });

  it('does not toggle when the lazy creation fails on v2', async () => {
    const { onShiftTab, ensureSession, handlePlanToggle } = createShiftTabHarness({
      sessionless: true,
    });
    ensureSession.mockResolvedValue(undefined);

    onShiftTab();
    await new Promise((resolve) => setImmediate(resolve));

    expect(handlePlanToggle).not.toHaveBeenCalled();
  });
});

describe('EditorKeyboardController Ctrl-S steering', () => {
  function createCtrlSHarness(options: { editorText: string; inputMode?: 'prompt' | 'bash' }) {
    const steerQueuedAndDraft = vi.fn();
    const updateQueueDisplay = vi.fn();
    const setText = vi.fn();
    const editor: Record<string, ((...args: never[]) => unknown) | undefined> = {
      setHistoryFilter: vi.fn() as unknown as (...args: never[]) => unknown,
      setInputMode: vi.fn() as unknown as (...args: never[]) => unknown,
      getText: vi.fn(() => options.editorText) as unknown as (...args: never[]) => unknown,
      setText: setText as unknown as (...args: never[]) => unknown,
      inputMode: (options.inputMode ?? 'prompt') as unknown as (...args: never[]) => unknown,
    };
    const host = {
      state: {
        editor,
        activeDialog: null,
        appState: { streamingPhase: 'waiting', isCompacting: false, model: 'k2' },
        footer: { setTransientHint: vi.fn() },
        ui: { requestRender: vi.fn() },
      },
      session: { id: 's1' },
      skillCommandMap: new Map(),
      steerQueuedAndDraft,
      updateQueueDisplay,
      showError: vi.fn(),
      track: vi.fn(),
    } as unknown as EditorKeyboardHost;
    const controller = new EditorKeyboardController(
      host,
      undefined as unknown as ImageAttachmentStore,
    );
    controller.install();
    const onCtrlS = editor['onCtrlS'];
    if (onCtrlS === undefined) throw new Error('onCtrlS handler not installed');
    return {
      editor,
      setText,
      steerQueuedAndDraft,
      updateQueueDisplay,
      onCtrlS: onCtrlS as () => void,
    };
  }

  it('steers the queued prompts and clears the editor draft', () => {
    const { setText, steerQueuedAndDraft, updateQueueDisplay, onCtrlS } = createCtrlSHarness({
      editorText: 'focus on tests',
    });

    onCtrlS();

    expect(steerQueuedAndDraft).toHaveBeenCalledWith('focus on tests');
    expect(setText).toHaveBeenCalledWith('');
    expect(updateQueueDisplay).toHaveBeenCalled();
  });

  it('steers the queue without touching an empty editor draft', () => {
    const { setText, steerQueuedAndDraft, onCtrlS } = createCtrlSHarness({
      editorText: '',
    });

    onCtrlS();

    expect(steerQueuedAndDraft).toHaveBeenCalledWith(undefined);
    expect(setText).not.toHaveBeenCalled();
  });

  it('does not steer a bash-mode draft', () => {
    const { steerQueuedAndDraft, onCtrlS } = createCtrlSHarness({
      editorText: 'ls -la',
      inputMode: 'bash',
    });

    onCtrlS();

    expect(steerQueuedAndDraft).not.toHaveBeenCalled();
  });
});

describe('EditorKeyboardController survey wiring', () => {
  it('clears the pending undo-escape sequence only when the survey consumes Escape', () => {
    const { editor, openUndoSelector, survey } = createHarness();
    const onPreInput = editor['onPreInput'] as unknown as (data: string) => boolean;

    pressEscape(editor);
    survey.handlePreInput.mockReturnValueOnce(true);
    onPreInput('\u001B');
    pressEscape(editor);
    expect(openUndoSelector).not.toHaveBeenCalled();

    pressEscape(editor);
    pressEscape(editor);
    expect(openUndoSelector).toHaveBeenCalledOnce();
  });

  it('clears a pending exit when Escape arrives through the survey pre-input hook', () => {
    const { host, editor } = createHarness();
    const onPreInput = editor['onPreInput'] as unknown as (data: string) => boolean;

    pressCtrlD(editor);
    onPreInput('\u001B');
    pressCtrlD(editor);

    expect(host.stop).not.toHaveBeenCalled();
  });

  it('routes raw keys to the survey pre-input hook first', () => {
    const { editor, survey } = createHarness();
    const onPreInput = editor['onPreInput'] as unknown as (data: string) => boolean;

    survey.handlePreInput.mockReturnValueOnce(true);
    expect(onPreInput('\u001B[D')).toBe(true);
    expect(survey.handlePreInput).toHaveBeenCalledWith('\u001B[D');

    survey.handlePreInput.mockReturnValueOnce(false);
    expect(onPreInput('x')).toBe(false);
  });

  it('forwards editor text changes to the survey', () => {
    const { editor, survey } = createHarness();
    const onChange = editor['onChange'] as unknown as (text: string) => void;

    onChange('1');

    expect(survey.handleEditorChange).toHaveBeenCalledWith('1');
  });

  it('lets the survey intercept a submit instead of sending it', () => {
    const { host, editor, survey } = createHarness();
    const onSubmit = editor['onSubmit'] as unknown as (text: string) => void;

    survey.handleSubmit.mockReturnValueOnce(true);
    onSubmit('1');

    expect(survey.handleSubmit).toHaveBeenCalledWith('1');
    expect(host.handleUserInput).not.toHaveBeenCalled();
  });

  it('sends the submit when the survey passes it through', () => {
    const { host, editor, survey } = createHarness();
    const onSubmit = editor['onSubmit'] as unknown as (text: string) => void;

    survey.handleSubmit.mockReturnValueOnce(false);
    onSubmit('hello');

    expect(host.handleUserInput).toHaveBeenCalledWith('hello');
  });

  it('closes the survey silently when the external editor opens', () => {
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', '');
    try {
      const { editor, survey } = createHarness();
      const onOpenExternalEditor = editor['onOpenExternalEditor'] as unknown as () => void;

      onOpenExternalEditor();

      expect(survey.closeSilently).toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
