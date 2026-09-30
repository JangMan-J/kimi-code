import * as vscode from "vscode";

import { Methods } from "../../shared/bridge";
import type {
  KimiConfig as WebviewKimiConfig,
  SlashCommandInfo,
} from "../../shared/legacy-sdk";
import type { ExtensionConfig, SessionConfig } from "../../shared/types";
import { VSCodeSettings } from "../config/vscode-settings";
import type { Handler } from "./types";

const SLASH_COMMANDS: SlashCommandInfo[] = [
  { name: "init", aliases: [], description: "Analyze the codebase and generate AGENTS.md" },
  { name: "compact", aliases: [], description: "Compact the conversation context" },
  { name: "clear", aliases: ["reset"], description: "Clear the context" },
  { name: "yolo", aliases: [], description: "Toggle YOLO mode (auto-approve tool actions; may still ask questions)" },
  {
    name: "auto",
    aliases: ["afk"],
    description: "Toggle Auto mode (fully autonomous; the agent will not ask questions)",
  },
  { name: "plan", aliases: [], description: "Toggle plan mode. Usage: /plan [on|off|view|clear]" },
  {
    name: "add-dir",
    aliases: [],
    description: "Add a directory to the workspace. Usage: /add-dir <path>",
  },
  { name: "export", aliases: [], description: "Export current session context to a markdown file" },
  { name: "import", aliases: [], description: "Import context from a file or session ID" },
];

const saveConfig: Handler<SessionConfig, { ok: boolean }> = async (params, ctx) => {
  const effort = sessionConfigEffort(params);
  const effortChanged = params.effortChanged !== false;
  const current = await ctx.runtime.getModels();
  const model = current.models.find((entry) => entry.id === params.model);
  const full = thinkingConfig(
    effort,
    model === undefined
      ? undefined
      : { supportEfforts: model.support_efforts, defaultEffort: model.default_effort },
  );
  const patch = effortChanged ? full : { enabled: full.enabled };
  if (
    current.defaultModel !== params.model
    || current.thinking?.enabled !== patch.enabled
    || (effortChanged && current.thinking?.effort !== patch.effort)
  ) {
    await ctx.runtime.setConfig({
      defaultModel: params.model,
      thinking: patch,
    });
  }

  const runtime = ctx.getSession();
  if (runtime !== undefined) {
    const status = runtime.getStatus();
    if (status.model !== params.model) await runtime.setModel(params.model);
    if (status.thinkingEffort !== effort) await runtime.setThinking(effort);
  }
  return { ok: true };
};

const getExtensionConfig: Handler<void, ExtensionConfig> = async () => {
  return VSCodeSettings.getExtensionConfig();
};

const openSettings: Handler<void, { ok: boolean }> = async () => {
  await vscode.commands.executeCommand("workbench.action.openSettings", "kimi");
  return { ok: true };
};

const getModels: Handler<void, WebviewKimiConfig> = async (_, ctx) => {
  return ctx.runtime.getModels();
};

const getSlashCommands: Handler<void, SlashCommandInfo[]> = async (_, ctx) => {
  if (!ctx.workDir) return SLASH_COMMANDS;
  try {
    const skills = await ctx.runtime.listWorkspaceSkills(ctx.workDir);
    const skillCommands = skills
      .filter((skill) => isUserActivatableSkill(skill.type) && skill.isSubSkill !== true)
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map((skill) => ({
        name: `skill:${skill.name}`,
        aliases: [],
        description: skill.description ?? "",
      }));
    return [...SLASH_COMMANDS, ...skillCommands];
  } catch (error) {
    ctx.logError("Unable to list workspace skills", error);
    return SLASH_COMMANDS;
  }
};

const showLogs: Handler<void, { ok: boolean }> = async (_, ctx) => {
  ctx.showLogs();
  return { ok: true };
};

const reloadWebview: Handler<void, { ok: boolean }> = async (_, ctx) => {
  await ctx.closeSession();
  ctx.fileManager.clearTracked(ctx.webviewId);
  ctx.reloadWebview();
  return { ok: true };
};

export const configHandlers = {
  [Methods.SaveConfig]: saveConfig,
  [Methods.GetExtensionConfig]: getExtensionConfig,
  [Methods.OpenSettings]: openSettings,
  [Methods.GetModels]: getModels,
  [Methods.GetSlashCommands]: getSlashCommands,
  [Methods.ShowLogs]: showLogs,
  [Methods.ReloadWebview]: reloadWebview,
} as Record<string, Handler<any, any>>;

function sessionConfigEffort(config: SessionConfig): string {
  if (config.effort !== undefined) return config.effort;
  return config.thinking === true ? "on" : "off";
}

function thinkingConfig(
  effort: string,
  model?: { readonly supportEfforts?: readonly string[]; readonly defaultEffort?: string },
): { enabled: boolean; effort?: string } {
  if (effort === "off") return { enabled: false };
  if (effort === "on") return { enabled: true };
  const efforts = model?.supportEfforts;
  if (efforts !== undefined && efforts.includes(effort)) {
    const declared = model?.defaultEffort;
    const ceiling =
      declared !== undefined && efforts.includes(declared)
        ? efforts.indexOf(declared)
        : efforts.length - 2;
    if (efforts.indexOf(effort) > ceiling) return { enabled: true };
  }
  return { enabled: true, effort };
}

function isUserActivatableSkill(type: string | undefined): boolean {
  return type === undefined || type === "prompt" || type === "inline" || type === "flow";
}
