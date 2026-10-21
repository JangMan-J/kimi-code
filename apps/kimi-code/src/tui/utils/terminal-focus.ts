import {
  DISABLE_TERMINAL_FOCUS_REPORTING,
  ENABLE_TERMINAL_FOCUS_REPORTING,
  TERMINAL_FOCUS_IN,
  TERMINAL_FOCUS_OUT,
} from '#/tui/constant/terminal';
import type { TUIState } from '#/tui/tui-state';
import type { TerminalState } from '#/tui/utils/terminal-state';

export {
  DISABLE_TERMINAL_FOCUS_REPORTING,
  ENABLE_TERMINAL_FOCUS_REPORTING,
  TERMINAL_FOCUS_IN,
  TERMINAL_FOCUS_OUT,
} from '#/tui/constant/terminal';

/**
 * A click that lands this soon after the terminal regained focus is most
 * likely the click that focused the window, not a deliberate choice.
 */
const FOCUS_CLICK_GUARD_MS = 300;

export function isFocusingClick(
  state: Pick<TerminalState, 'focusedAt'>,
  now = Date.now(),
): boolean {
  return now - state.focusedAt < FOCUS_CLICK_GUARD_MS;
}

export function installTerminalFocusTracking(state: TUIState): () => void {
  state.terminalState.focused = true;
  const disposeInputListener = state.ui.addInputListener((data) =>
    handleTerminalFocusInput(state.terminalState, data),
  );
  state.terminal.write(ENABLE_TERMINAL_FOCUS_REPORTING);

  return () => {
    disposeInputListener();
    state.terminal.write(DISABLE_TERMINAL_FOCUS_REPORTING);
    state.terminalState.focused = true;
  };
}

export function handleTerminalFocusInput(
  state: Pick<TerminalState, 'focused' | 'focusedAt'>,
  data: string,
  now = Date.now(),
): { consume: true } | undefined {
  if (data === TERMINAL_FOCUS_IN) {
    state.focused = true;
    state.focusedAt = now;
    return { consume: true };
  }
  if (data === TERMINAL_FOCUS_OUT) {
    state.focused = false;
    return { consume: true };
  }
  return undefined;
}
