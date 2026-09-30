import type { AgentHandle, SessionHandle } from '@moonshot-ai/agent-core';

export class KimiSession {
  constructor(
    readonly id: string,
    readonly handle: SessionHandle,
    readonly main: AgentHandle,
    private readonly onClose: (id: string) => Promise<void>,
  ) {}

  async close(): Promise<void> {
    await this.onClose(this.id);
  }
}
