import {
  compressImageForModel,
  ImageLimits,
  type KimiHarness,
  type KimiSession,
} from '@moonshot-ai/kimi-code-sdk';

import {
  ClipboardMediaError,
  readClipboardMedia,
} from '#/utils/clipboard/clipboard-image';
import { parseImageMeta } from '#/utils/image/image-mime';
import { editInExternalEditor, resolveEditorCommand } from '#/utils/process/external-editor';

import {
  CTRL_C_HINT,
  CTRL_D_HINT,
  DOUBLE_ESC_WINDOW_MS,
  EXIT_CONFIRM_WINDOW_MS,
} from '../constant/kimi-tui';
import { Key, matchesKey } from '@moonshot-ai/pi-tui';
import { formatErrorMessage } from '../utils/errors';
import type {
  ImageAttachment,
  ImageAttachmentStore,
} from '../utils/image-attachment-store';
import type { PendingExit } from '../types';
import type { TUIState } from '../tui-state';
import type { BtwPanelController } from './btw-panel';
import type { SurveyController } from './survey-controller';

export interface EditorKeyboardHost {
  state: TUIState;
  session: KimiSession | undefined;
  cancelInFlight: (() => void) | undefined;
  readonly btwPanelController: BtwPanelController;
  /**
   * The host's harness (KimiTUI always has one). Its `image` config section
   * drives paste-time image compression; hosts without one fall back to the
   * env/built-in default.
   */
  harness?: KimiHarness | undefined;

  handleUserInput(text: string): void;
  readonly surveyController: SurveyController;
  readonly skillCommandMap: Map<string, string>;
  steerQueuedAndDraft(draft: string | undefined): void;
  cancelOngoingWork(): void;
  cancelCurrentCompaction(): void;
  validateMediaCapabilities(extraction: {
    hasMedia: boolean;
    imageAttachmentIds: readonly number[];
  }): boolean;
  recallLastQueued(): { text: string; mode?: 'prompt' | 'bash' } | undefined;
  showError(msg: string): void;
  track(event: string, props?: Record<string, unknown>): void;
  updateEditorBorderHighlight(text?: string): void;
  updateGoalLengthWarning(text: string | undefined): void;
  updateQueueDisplay(): void;
  toggleToolOutputExpansion(): void;
  toggleTodoPanelExpansion(): void;
  /** Returns true when the Updates panel grabbed or released focus. */
  toggleNotifyPanelFocus(): boolean;
  handleNotifyPanelKey(key: 'left' | 'right' | 'up' | 'down' | 'escape'): boolean;
  detachCurrentForegroundTask(): void;
  cancelRunningShellCommand(): void;
  hideSessionPicker(): void;
  openUndoSelector(): void;
  stop(exitCode?: number): Promise<void>;
  ensureSession(): Promise<KimiSession | undefined>;
  handlePlanToggle(next: boolean): void;
  handleInputModeChange(mode: 'prompt' | 'bash'): void;
  setExternalEditorRunning(running: boolean): void;
  updateActivityPane(): void;
}

export class EditorKeyboardController {
  private pendingExit: PendingExit | null = null;
  private pendingUndoEsc: { readonly timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(
    private readonly host: EditorKeyboardHost,
    private readonly imageStore: ImageAttachmentStore,
  ) {}

  install(): void {
    const { host } = this;
    const editor = host.state.editor;

    editor.onSubmit = (text: string) => {
      if (host.surveyController.handleSubmit(text)) return;
      host.handleUserInput(text);
    };

    editor.onPreInput = (data: string) => {
      if (matchesKey(data, Key.escape)) this.clearPendingExit();
      const consumed = host.surveyController.handlePreInput(data);
      if (consumed) this.clearPendingUndoEsc();
      return consumed;
    };

    editor.onChange = (text: string) => {
      if (this.pendingExit) this.clearPendingExit();
      host.surveyController.handleEditorChange(text);
      host.updateEditorBorderHighlight(text);
      // Expanding paste markers costs a full-text pass, and only `/goal`
      // input can trip the objective length limit — so skip the expansion
      // for ordinary prompts. Submitted text is trimmed before dispatch, so
      // gate on the trimmed text too. A paste marker may itself expand into
      // part of the command (`[paste #…]` → `/goal …`, or completing a
      // partial prefix like `/go[paste #1 …]` → `/goal …`), so any input
      // containing a marker that can still become a `/goal` command must
      // pass the gate as well.
      const trimmed = text.trimStart();
      const mightBeGoal =
        trimmed.startsWith('/goal') ||
        trimmed.startsWith('[paste #') ||
        (trimmed.startsWith('/') && trimmed.includes('[paste #'));
      if (editor.inputMode !== 'bash' && mightBeGoal) {
        host.updateGoalLengthWarning(editor.getExpandedText());
      } else {
        host.updateGoalLengthWarning(undefined);
      }
    };

    // bash mode recalls only shell (`!`-prefixed) history entries; prompt mode
    // recalls everything. The filter is locked to the mode captured when the
    // user first enters history browsing (see onHistoryDraftSave), so landing on
    // a shell entry mid-browse doesn't switch the filter to shell-only.
    let browseMode: 'prompt' | 'bash' | null = null;
    editor.setHistoryFilter((entry: string) => {
      const mode = browseMode ?? editor.inputMode;
      return mode === 'bash' ? entry.startsWith('!') : true;
    });

    // Recalling a `!`-prefixed entry strips the marker and returns to bash
    // mode; recalling a plain entry returns to prompt mode. The filter above
    // guarantees bash mode only ever lands on `!` entries, so this never
    // misfires on commands typed in bash mode.
    editor.onRecall = (entry: string) => {
      if (entry.startsWith('!')) {
        editor.setInputMode('bash');
        return entry.slice(1);
      }
      editor.setInputMode('prompt');
      return undefined;
    };

    // Save/restore the input mode alongside pi-tui's history draft. Without
    // this, recalling a shell entry and then pressing Down back to an empty
    // draft would leave the editor stuck in bash mode, so the next typed
    // message would be submitted as a shell command. Also locks the history
    // filter (browseMode) for the duration of the browse session.
    editor.onHistoryDraftSave = () => {
      browseMode = editor.inputMode;
      return editor.inputMode;
    };
    editor.onHistoryDraftRestore = (state: unknown) => {
      editor.setInputMode(state as 'prompt' | 'bash');
      browseMode = null;
    };

    editor.onNonEscapeInput = () => {
      this.clearPendingUndoEsc();
    };

    editor.onCtrlC = () => {
      if (host.cancelInFlight !== undefined) {
        const cancel = host.cancelInFlight;
        host.cancelInFlight = undefined;
        this.clearPendingExit();
        cancel();
        return;
      }

      // The btw panel stacks above the transcript, so Ctrl+C cancels/closes it
      // before any turn-level handling.
      if (host.btwPanelController.cancelRunning()) {
        this.clearPendingExit();
        return;
      }
      if (host.btwPanelController.closeOrCancel()) {
        this.clearPendingExit();
        return;
      }

      if (host.state.appState.isCompacting) {
        this.clearPendingExit();

        if (this.clearEditorTextIfPresent()) return;

        host.cancelCurrentCompaction();
        return;
      }

      if (host.state.appState.streamingPhase !== 'idle') {
        this.clearPendingExit();

        if (this.clearEditorTextIfPresent()) return;

        host.cancelOngoingWork();
        return;
      }

      if (this.pendingExit?.kind === 'ctrl-c') {
        this.clearPendingExit();
        void host.stop();
        return;
      }

      if (editor.getText().length > 0) {
        editor.setText('');
      }
      this.armPendingExit('ctrl-c', CTRL_C_HINT);
    };

    editor.onCtrlD = () => {
      if (this.pendingExit?.kind === 'ctrl-d') {
        this.clearPendingExit();
        void host.stop();
        return;
      }
      this.armPendingExit('ctrl-d', CTRL_D_HINT);
    };

    editor.onEscape = () => {
      if (this.pendingExit) this.clearPendingExit();
      // The btw panel stacks above the transcript, so Esc dismisses it before
      // any session-level handling.
      if (host.btwPanelController.closeOrCancel()) {
        this.clearPendingUndoEsc();
        return;
      }
      if (host.state.activeDialog === 'session-picker') {
        host.hideSessionPicker();
        this.clearPendingUndoEsc();
        return;
      }
      if (host.state.appState.isCompacting) {
        host.cancelCurrentCompaction();
        this.clearPendingUndoEsc();
        return;
      }
      if (host.state.appState.streamingPhase !== 'idle') {
        host.cancelOngoingWork();
        this.clearPendingUndoEsc();
        return;
      }
      // Idle: a second Esc within the double-tap window opens the undo selector.
      if (this.pendingUndoEsc !== null) {
        this.clearPendingUndoEsc();
        host.openUndoSelector();
        return;
      }
      this.armPendingUndoEsc();
    };

    editor.onShiftTab = () => {
      const togglePlan = (): void => {
        const next = !host.state.appState.planMode;
        host.track('shortcut_plan_toggle', { enabled: next });
        host.track('shortcut_mode_switch', { to_mode: next ? 'plan' : 'agent' });
        host.handlePlanToggle(next);
      };
      if (host.session === undefined) {
        // Session-less: lazy-create the session, then toggle — the same
        // path /plan takes.
        void host.ensureSession().then((session) => {
          if (session !== undefined) togglePlan();
        });
        return;
      }
      togglePlan();
    };

    editor.onInputModeChange = (mode) => {
      host.handleInputModeChange(mode);
    };

    editor.onOpenExternalEditor = () => {
      host.surveyController.closeSilently();
      host.track('shortcut_editor');
      void this.openExternalEditor();
    };

    editor.onToggleToolExpand = () => {
      host.track('shortcut_expand');
      host.toggleToolOutputExpansion();
    };

    editor.onToggleTodoExpand = (): boolean => {
      if (!host.state.todoPanel.hasOverflow()) return false;
      // Disarm a pending double-press exit confirmation so expanding the
      // todo list in between two Ctrl-C presses does not accidentally exit.
      this.clearPendingExit();
      host.track('shortcut_todo_expand');
      host.toggleTodoPanelExpansion();
      return true;
    };

    editor.onPageNotify = (): boolean => {
      if (!host.toggleNotifyPanelFocus()) return false;
      this.clearPendingExit();
      host.track('shortcut_notify_page');
      return true;
    };

    editor.onNotifyPanelKey = (key) => host.handleNotifyPanelKey(key);

    editor.onCtrlS = () => {
      if (
        host.state.appState.streamingPhase === 'idle' ||
        host.state.appState.streamingPhase === 'shell' ||
        host.state.appState.isCompacting
      )
        return;
      if (host.session === undefined) return;
      const text = editor.getText().trim();
      if (editor.inputMode === 'bash') return;
      // Steering sends every queued prompt into the running turn, then the
      // editor draft (submitted and steered immediately). Queued bash
      // commands are not steerable: they stay queued.
      host.steerQueuedAndDraft(text.length > 0 ? text : undefined);
      if (text.length > 0) editor.setText('');
      host.updateQueueDisplay();
      host.state.ui.requestRender();
    };

    editor.onCtrlB = (): boolean => {
      // Shell command execution is treated as a streaming phase ('shell'), so
      // this gate already covers it; only idle + not-compacting falls through.
      if (host.state.appState.streamingPhase === 'idle' || host.state.appState.isCompacting) {
        return false;
      }
      host.track('shortcut_background_task');
      void host.detachCurrentForegroundTask();
      return true;
    };

    editor.onUndo = () => {
      host.track('undo');
    };

    editor.onTextPaste = () => {
      host.track('shortcut_paste', { kind: 'text' });
    };

    editor.onUpArrowEmpty = () => {
      if (host.btwPanelController.scroll('up')) return true;
      if (host.state.appState.streamingPhase === 'idle' && !host.state.appState.isCompacting) return false;
      const recalled = host.recallLastQueued();
      if (recalled !== undefined) {
        editor.setText(recalled.text);
        // Restore the queued item's mode so a recalled `!` command runs as a
        // shell command again instead of being submitted as a normal prompt.
        const mode = recalled.mode === 'bash' ? 'bash' : 'prompt';
        if (editor.inputMode !== mode) {
          editor.inputMode = mode;
          editor.onInputModeChange?.(mode);
        }
        host.updateQueueDisplay();
        host.state.ui.requestRender();
        return true;
      }
      return false;
    };

    editor.onDownArrowEmpty = () => host.btwPanelController.scroll('down');

    editor.onPasteImage = async () => this.handleClipboardImagePaste();
  }

  clearPendingExit(): void {
    if (!this.pendingExit) return;
    clearTimeout(this.pendingExit.timer);
    this.host.state.footer.setTransientHint(null);
    this.pendingExit = null;
  }

  dispose(): void {
    this.clearPendingExit();
    this.clearPendingUndoEsc();
  }

  private armPendingUndoEsc(): void {
    this.clearPendingUndoEsc();
    const timer = setTimeout(() => {
      if (this.pendingUndoEsc?.timer === timer) {
        this.pendingUndoEsc = null;
      }
    }, DOUBLE_ESC_WINDOW_MS);
    this.pendingUndoEsc = { timer };
  }

  private clearPendingUndoEsc(): void {
    if (!this.pendingUndoEsc) return;
    clearTimeout(this.pendingUndoEsc.timer);
    this.pendingUndoEsc = null;
  }

  private armPendingExit(kind: 'ctrl-c' | 'ctrl-d', hint: string): void {
    this.clearPendingExit();
    this.host.state.footer.setTransientHint(hint);

    const timer = setTimeout(() => {
      if (this.pendingExit?.timer === timer) {
        this.clearPendingExit();
        this.host.state.ui.requestRender();
      }
    }, EXIT_CONFIRM_WINDOW_MS);

    this.pendingExit = { kind, timer };
    this.host.state.ui.requestRender();
  }

  private clearEditorTextIfPresent(): boolean {
    const editor = this.host.state.editor;
    if (editor.getText().length === 0) return false;
    editor.setText('');
    return true;
  }

  private async handleClipboardImagePaste(): Promise<boolean> {
    let media;
    try {
      media = await readClipboardMedia();
    } catch (error) {
      if (error instanceof ClipboardMediaError) {
        this.host.showError(error.message);
        return true;
      }
      return false;
    }
    if (media === null) return false;

    if (media.kind === 'video') {
      this.host.showError(
        'Pasted videos are not supported yet in this build — paste an image instead.',
      );
      return true;
    }

    const meta = parseImageMeta(media.bytes);
    if (meta === null) return false;

    // Register the attachment and put its placeholder in the editor before
    // the asynchronous compression below. CustomEditor only holds keystrokes
    // until this handler settles, so the callback returns right after the
    // placeholder lands and ingestion continues in the background — typing
    // never waits on compression. Submit gives a pending ingestion a bounded
    // wait (`pendingMediaIngestions`).
    const attachment = this.imageStore.addImage(
      media.bytes,
      meta.mime,
      meta.width,
      meta.height,
    );
    this.host.state.editor.insertTextAtCursor?.(`${attachment.placeholder} `);
    this.host.state.ui.requestRender();
    this.host.track('shortcut_paste', { kind: 'image' });

    attachment.pending = this.finishClipboardImagePaste(
      attachment,
      media.bytes,
      meta.mime,
      meta.width,
      meta.height,
    ).catch((error: unknown) => {
      // The raw attachment and its already-visible placeholder are still a
      // valid fallback when optional ingestion work fails.
      this.host.showError(`Failed to process pasted image: ${formatErrorMessage(error)}`);
    });
    return true;
  }

  private async finishClipboardImagePaste(
    attachment: ImageAttachment,
    originalBytes: Uint8Array,
    originalMime: string,
    originalWidth: number,
    originalHeight: number,
  ): Promise<void> {
    // Compress at ingestion — a pure data step while building the attachment,
    // so the stored bytes, the inline thumbnail, the `[image #N (W×H)]`
    // placeholder, and the submitted image all agree. Best effort: originals
    // pass through on failure. The edge cap comes from the harness's [image]
    // config (resolved per paste so a config reload applies immediately).
    const imageConfig = this.host.harness?.config.get<{ maxEdgePx?: number }>('image');
    const maxEdge = new ImageLimits(process.env, imageConfig).maxEdgePx();
    const compressed = await compressImageForModel(originalBytes, originalMime, {
      maxEdge,
    });
    this.imageStore.completeImage(attachment, {
      bytes: compressed.changed ? compressed.data : originalBytes,
      mime: compressed.changed ? compressed.mimeType : originalMime,
      width: compressed.width || originalWidth,
      height: compressed.height || originalHeight,
    });
    this.host.state.ui.requestRender();
  }

  private async openExternalEditor(): Promise<void> {
    const { state } = this.host;
    if (state.externalEditorRunning) return;
    const cmd = resolveEditorCommand(state.appState.editorCommand);
    if (cmd === undefined) {
      this.host.showError('No editor configured. Set $VISUAL / $EDITOR, or run /editor <command>.');
      return;
    }
    this.host.setExternalEditorRunning(true);
    const seed = state.editor.getExpandedText?.() ?? state.editor.getText();
    // Fullscreen: a plain stop() would replay the whole transcript into the
    // main screen on exit; the external editor only needs the alternate
    // screen released, so preserve the screen instead.
    state.ui.stop({ preserveScreen: state.ui.mode === 'fullscreen' ? true : undefined });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    try {
      const result = await editInExternalEditor(seed, cmd);
      if (result !== undefined) {
        state.editor.setText(result.replaceAll('\r\n', '\n').replace(/\n$/, ''));
      }
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.host.showError(`External editor failed: ${msg}`);
    } finally {
      if (typeof process.stdin.pause === 'function') {
        process.stdin.pause();
      }
      state.ui.start();
      state.ui.setFocus(state.editor);
      state.ui.requestRender(true);
      // terminal.stop() cleared the OSC 9;4 progress indicator while the
      // app-side progressActive flag still reads true; resync so a turn that
      // was streaming while the editor was open gets its progress back.
      state.terminalState.progressActive = false;
      this.host.updateActivityPane();
      this.host.setExternalEditorRunning(false);
    }
  }
}
