import { Spacer } from '@moonshot-ai/pi-tui';
import { createUserMessage, type AgentHandle, type TurnOutcome } from '@moonshot-ai/agent-core';
import type { KimiSession } from '@moonshot-ai/kimi-code-sdk';

import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { BtwPanelComponent } from '../components/panes/btw-panel';
import { createMarkdownTheme } from '../theme/pi-tui-theme';
import type { TUIState } from '../tui-state';

const BTW_BUSY_NOTICE = 'Wait for /btw to finish before sending another question.';

export interface BtwPanelHost {
  state: TUIState;
  session: KimiSession | undefined;

  showError(msg: string): void;
}

export class BtwPanelController {
  private active:
    | {
        readonly agentId: string;
        readonly panel: BtwPanelComponent;
      }
    | undefined;
  private readonly panelsByAgentId = new Map<string, BtwPanelComponent>();
  private readonly subscriptionsByAgentId = new Map<string, () => void>();

  constructor(private readonly host: BtwPanelHost) {}

  open(agentId: string, initialPrompt: string): void {
    const panel = new BtwPanelComponent({
      markdownTheme: createMarkdownTheme(),
      canUseScrollKeys: () => this.host.state.editor.getText().length === 0,
      terminalRows: () => this.host.state.terminal.rows,
      onPrompt: (prompt) => {
        this.promptAgent(agentId, prompt, panel);
      },
    });
    this.active = { agentId, panel };
    this.panelsByAgentId.set(agentId, panel);
    this.subscribeAgent(agentId);
    this.mount(panel);
    panel.submit(initialPrompt);
  }

  isActive(): boolean {
    return this.active !== undefined;
  }

  clear(): void {
    const active = this.active;
    if (active !== undefined && this.shouldCancelOnUnmount(active.panel)) {
      void this.cancelAgent(active.agentId);
    }
    this.active = undefined;
    this.panelsByAgentId.clear();
    for (const unsubscribe of this.subscriptionsByAgentId.values()) unsubscribe();
    this.subscriptionsByAgentId.clear();
    this.host.state.btwPanelContainer.clear();
    this.host.state.editor.connectedAbove = false;
  }

  closeOrCancel(): boolean {
    const active = this.active;
    if (active === undefined) return false;
    const shouldCancel = this.shouldCancelOnUnmount(active.panel);
    this.close(active.panel);
    if (shouldCancel) {
      void this.cancelAgent(active.agentId);
    }
    return true;
  }

  cancelRunning(): boolean {
    const active = this.active;
    if (active === undefined || !active.panel.isRunning()) return false;
    void this.cancelAgent(active.agentId);
    return true;
  }

  sendUserInput(text: string): boolean {
    const active = this.active;
    if (active === undefined) return false;
    if (active.panel.isRunning()) {
      this.host.state.editor.setText(text);
      active.panel.addTransientNotice(BTW_BUSY_NOTICE);
      this.host.state.ui.requestRender();
      return true;
    }
    active.panel.submit(text);
    this.host.state.ui.setFocus(this.host.state.editor);
    this.host.state.ui.requestRender();
    return true;
  }

  scroll(direction: 'up' | 'down'): boolean {
    const panel = this.active?.panel;
    if (panel === undefined || !panel.scroll(direction)) return false;
    this.host.state.ui.requestRender();
    return true;
  }

  private subscribeAgent(agentId: string): void {
    if (this.subscriptionsByAgentId.has(agentId)) return;
    const target = this.host.session?.handle.get(agentId);
    if (target === undefined) return;
    const off: Array<() => void> = [];
    const use = (subscription: { unsubscribe(): void }): void => {
      off.push(() => subscription.unsubscribe());
    };
    use(
      target.on('llm.streaming.part', (event) => {
        const panel = this.panelsByAgentId.get(agentId);
        if (panel === undefined) return;
        if (event.part.type === 'text') panel.appendAnswer(event.part.text);
        else if (event.part.type === 'think') panel.appendThinking(event.part.think);
        this.host.state.ui.requestRender();
      }),
    );
    use(
      target.on('turn.done', (event) => {
        const panel = this.panelsByAgentId.get(agentId);
        if (panel === undefined) return;
        if (event.outcome.type === 'done') {
          panel.markDone();
        } else {
          panel.markFailed(formatBtwTurnFailure(event.outcome));
        }
        this.host.state.ui.requestRender();
      }),
    );
    this.subscriptionsByAgentId.set(agentId, () => {
      for (const unsubscribe of off) unsubscribe();
    });
  }

  private mount(panel: BtwPanelComponent): void {
    this.host.state.btwPanelContainer.clear();
    this.host.state.btwPanelContainer.addChild(new Spacer(1));
    this.host.state.btwPanelContainer.addChild(panel);
    this.host.state.editor.connectedAbove = true;
    this.host.state.ui.setFocus(this.host.state.editor);
    this.host.state.ui.requestRender();
  }

  private close(panel: BtwPanelComponent): void {
    if (!this.host.state.btwPanelContainer.children.includes(panel)) return;
    this.unregister(panel);
    this.host.state.btwPanelContainer.clear();
    this.host.state.editor.connectedAbove = false;
    this.host.state.ui.setFocus(this.host.state.editor);
    this.host.state.ui.requestRender(true);
  }

  private unregister(panel: BtwPanelComponent): void {
    for (const [agentId, candidate] of this.panelsByAgentId) {
      if (candidate === panel) {
        this.panelsByAgentId.delete(agentId);
        this.subscriptionsByAgentId.get(agentId)?.();
        this.subscriptionsByAgentId.delete(agentId);
      }
    }
    if (this.active?.panel === panel) this.active = undefined;
  }

  private promptAgent(agentId: string, prompt: string, panel: BtwPanelComponent): void {
    const target: AgentHandle | undefined = this.host.session?.handle.get(agentId);
    if (target === undefined) {
      panel.markFailed(NO_ACTIVE_SESSION_MESSAGE);
      this.host.state.ui.requestRender();
      return;
    }
    const ack = target.submit(createUserMessage(prompt), {
      origin: { kind: 'user' },
      tracked: true,
    });
    if (ack === undefined) {
      panel.markFailed('Failed to send /btw prompt: the agent is not running.');
      this.host.state.ui.requestRender();
    }
  }

  private async cancelAgent(agentId: string): Promise<void> {
    const target = this.host.session?.handle.get(agentId);
    if (target === undefined) return;
    target.abort();
  }

  private shouldCancelOnUnmount(panel: BtwPanelComponent): boolean {
    return panel.isRunning() || panel.isEmpty();
  }
}

function formatBtwTurnFailure(outcome: Extract<TurnOutcome, { type: 'failed' | 'aborted' }>): string {
  if (outcome.type === 'aborted') {
    return 'Interrupted by user';
  }
  const failure = outcome.failure;
  if (failure.reason === 'max_steps') {
    return `reached per-turn step limit (max_steps): ${failure.message}`;
  }
  const error = failure.error;
  return error instanceof Error ? error.message : String(error);
}
