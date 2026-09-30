/**
 * Scenario: persisted v3 sessions are reopened and rendered by the VS Code replay adapter.
 * Responsibilities: restored tool displays and child-agent steps from the durable history.
 * Wiring: Node SDK harness, engine, storage, and the fake provider are real; only the remote provider is local.
 * Run: pnpm --filter kimi-code exec vitest run --config vitest.config.ts test/replay-resume.integration.test.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { MAIN_AGENT_ID, createUserMessage } from "@moonshot-ai/agent-core";
import { PermissionRef, TokenCountingRef } from "@moonshot-ai/harness-core";
import {
  createKimiHarness,
  type KimiHarness,
  type KimiSession,
} from "@moonshot-ai/kimi-code-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  createFakeProviderHarness,
  type FakeProviderHarness,
} from "./fake-provider-harness";
import {
  replaySessionToWebviewEvents,
  type ReplayAgentSource,
  type ReplaySessionSource,
} from "../src/runtime/replay-adapter";

const MODEL_ALIAS = "vscode-replay-test";

interface ReplayRig {
  readonly rootDir: string;
  readonly workDir: string;
  readonly harness: KimiHarness;
  readonly provider: FakeProviderHarness;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function createReplayRig(): Promise<ReplayRig> {
  const rootDir = await mkdtemp(join(tmpdir(), "kimi-vscode-replay-"));
  const homeDir = join(rootDir, "home");
  const workDir = join(rootDir, "workspace");
  await Promise.all([mkdir(homeDir), mkdir(workDir)]);
  const provider = await createFakeProviderHarness();
  await writeFile(
    join(homeDir, "config.toml"),
    `default_model = "local/mock-model"

[providers.local]
type = "kimi"
base_url = "${provider.baseUrl}/v1"
api_key = "sk-test"

[models."${MODEL_ALIAS}"]
provider = "local"
model = "mock-model"
max_context_size = 128000

[loop_control]
max_attempts_per_step = 1
`,
    "utf8",
  );
  const harness = await createKimiHarness({ homeDir, workDir });
  cleanups.push(async () => {
    try {
      await harness.close();
    } finally {
      try {
        await provider.close();
      } finally {
        await removeTempDir(rootDir);
      }
    }
  });
  return { rootDir, workDir, harness, provider };
}

async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EBUSY" && code !== "EPERM") {
        throw error;
      }
      await delay(10);
    }
  }

  await rm(dir, { recursive: true, force: true });
}

function completionChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id: "chatcmpl-vscode-replay",
    object: "chat.completion.chunk",
    created: 1,
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function runTurn(session: KimiSession, prompt: string): Promise<void> {
  const result = await session.main.run(createUserMessage(prompt));
  if (result.outcome.type !== "done") {
    throw new Error(`Turn did not complete: ${JSON.stringify(result.outcome)}`);
  }
}

async function replaySourceOf(session: KimiSession): Promise<ReplaySessionSource> {
  const stores = session.handle.stores;
  const rosterState = stores.session.getState().roster;
  const agents: Record<string, ReplayAgentSource> = {};
  const roster: Record<string, { source?: string }> = {};
  for (const [agentId, entry] of Object.entries(rosterState.agents)) {
    const store = stores.get(agentId) ?? (await stores.open(agentId));
    agents[agentId] = { history: store.getState().history };
    roster[agentId] = { source: entry.source };
  }
  let contextTokens = 0;
  let maxContextTokens = 0;
  const tokenCounting = session.main.resolve(TokenCountingRef);
  if (tokenCounting !== undefined) {
    contextTokens = tokenCounting.status.value;
    maxContextTokens = session.main.model?.spec.maxContextSize ?? 0;
  }
  return {
    agents,
    roster,
    status: { contextTokens, maxContextTokens },
  };
}

describe("VS Code replay from a resumed v3 session", () => {
  it("restores persisted file and todo displays", async () => {
    const rig = await createReplayRig();
    const filePath = join(rig.workDir, "sample.txt");
    await writeFile(filePath, "before\n", "utf8");
    let requestCount = 0;
    rig.provider.route("POST", "/v1/chat/completions", async (_request, reply) => {
      requestCount += 1;
      if (requestCount === 1) {
        await reply.sseJson(200, [
          completionChunk({
            tool_calls: [
              {
                index: 0,
                id: "edit-call-1",
                type: "function",
                function: {
                  name: "Edit",
                  arguments: JSON.stringify({
                    path: "sample.txt",
                    old_string: "before",
                    new_string: "after",
                  }),
                },
              },
              {
                index: 1,
                id: "write-call-1",
                type: "function",
                function: {
                  name: "Write",
                  arguments: JSON.stringify({
                    path: "created.txt",
                    content: "created content\n",
                  }),
                },
              },
              {
                index: 2,
                id: "todo-call-1",
                type: "function",
                function: {
                  name: "TodoList",
                  arguments: JSON.stringify({
                    todos: [{ title: "Verify resume", status: "done" }],
                  }),
                },
              },
            ],
          }),
          completionChunk({}, "tool_calls"),
        ]);
        return;
      }
      await reply.sseJson(200, [
        completionChunk({ content: "Changes complete." }),
        completionChunk({}, "stop"),
      ]);
    });
    const session = await rig.harness.createSession();
    const permission = session.main.resolve(PermissionRef);
    if (permission === undefined) throw new Error("permission feature is not installed");
    await permission.setMode("yolo");
    await runTurn(session, "Update the file and checklist");
    await session.close();

    const resumed = await rig.harness.resumeSession(session.id);
    const events = replaySessionToWebviewEvents(await replaySourceOf(resumed), resumed.id);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ToolResult",
        payload: expect.objectContaining({
          tool_call_id: "write-call-1",
          return_value: expect.objectContaining({
            display: [{
              type: "diff",
              path: "created.txt",
              old_text: "",
              new_text: "created content\n",
            }],
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ToolResult",
        payload: expect.objectContaining({
          tool_call_id: "edit-call-1",
          return_value: expect.objectContaining({
            display: [{ type: "diff", path: "sample.txt", old_text: "before", new_text: "after" }],
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ToolResult",
        payload: expect.objectContaining({
          tool_call_id: "todo-call-1",
          return_value: expect.objectContaining({
            display: [{
              type: "todo",
              items: [{ title: "Verify resume", status: "done" }],
            }],
          }),
        }),
      }),
    );
  });

  it("restores a child step under its original Agent tool call", async () => {
    const rig = await createReplayRig();
    const childAnswer = `Subagent restored evidence. ${"Detailed persisted finding. ".repeat(10)}`;
    let requestCount = 0;
    rig.provider.route("POST", "/v1/chat/completions", async (_request, reply) => {
      requestCount += 1;
      if (requestCount === 1) {
        await reply.sseJson(200, [
          completionChunk({
            tool_calls: [{
              index: 0,
              id: "agent-call-1",
              type: "function",
              function: {
                name: "Agent",
                arguments: JSON.stringify({
                  prompt: "Inspect the workspace and report one finding.",
                  description: "inspect workspace",
                  subagent_type: "coder",
                  run_in_background: false,
                }),
              },
            }],
          }),
          completionChunk({}, "tool_calls"),
        ]);
        return;
      }
      if (requestCount === 2) {
        await reply.sseJson(200, [
          completionChunk({ content: childAnswer }),
          completionChunk({}, "stop"),
        ]);
        return;
      }
      await reply.sseJson(200, [
        completionChunk({ content: "Parent received the finding." }),
        completionChunk({}, "stop"),
      ]);
    });
    const session = await rig.harness.createSession();
    const permission = session.main.resolve(PermissionRef);
    if (permission === undefined) throw new Error("permission feature is not installed");
    await permission.setMode("yolo");
    await runTurn(session, "Delegate this inspection");
    await session.close();

    const resumed = await rig.harness.resumeSession(session.id);
    const source = await replaySourceOf(resumed);
    const events = replaySessionToWebviewEvents(source, resumed.id);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "SubagentEvent",
        payload: {
          parent_tool_call_id: "agent-call-1",
          event: { type: "StepBegin", payload: { n: 1 } },
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "SubagentEvent",
        payload: {
          parent_tool_call_id: "agent-call-1",
          event: { type: "ContentPart", payload: { type: "text", text: childAnswer } },
        },
      }),
    );
    expect(Object.keys(source.agents)).toContain(MAIN_AGENT_ID);
  });
});
