import { McpRef, ProfileCatalogRef, SkillCatalogRef } from '@moonshot-ai/harness-core';
import { PluginRef } from '@moonshot-ai/harness-core/features/plugin/index';

import { currentTheme, lightColors } from '#/tui/theme';
import { loadTuiConfig, type TuiConfig } from '../config';
import { setMarkdownRenderLatex } from '../utils/markdown-options';
import type { SlashCommandHost } from './dispatch';

export async function handleReloadTuiCommand(host: SlashCommandHost): Promise<void> {
  const tuiConfig = await loadTuiConfig(undefined, (message) =>
    host.showStatus(message, 'warning'),
  );
  await applyReloadedTuiConfig(host, tuiConfig);
  host.showStatus('TUI config reloaded.', 'success');
}

export async function handleReloadCommand(host: SlashCommandHost): Promise<void> {
  const reloaded: string[] = [];

  await host.harness.config.reload();
  reloaded.push('config');

  const skillCatalog = host.harness.app.resolve(SkillCatalogRef);
  if (skillCatalog !== undefined) {
    try {
      await skillCatalog.reload();
      reloaded.push('skills');
    } catch {}
  }

  const profileCatalog = host.harness.app.resolve(ProfileCatalogRef);
  if (profileCatalog !== undefined) {
    try {
      await profileCatalog.reload();
      reloaded.push('profiles');
    } catch {}
  }

  const plugin = host.harness.app.resolve(PluginRef);
  if (plugin !== undefined) {
    try {
      await plugin.reloadPlugins();
      reloaded.push('plugins');
    } catch {}
  }

  const mcp = host.harness.app.resolve(McpRef);
  if (mcp !== undefined) {
    try {
      await mcp.reload();
      reloaded.push('mcp');
    } catch {}
  }

  host.refreshAvailableModels();
  host.hydrateLazyConfigDefaults();
  await host.refreshDynamicCommands();

  const tuiConfig = await loadTuiConfig(undefined, (message) =>
    host.showStatus(message, 'warning'),
  );
  await applyReloadedTuiConfig(host, tuiConfig);

  host.showStatus(`Reloaded: ${reloaded.join(', ')}.`, 'success');
}

export async function applyReloadedTuiConfig(
  host: SlashCommandHost,
  config: TuiConfig,
): Promise<void> {
  // Set the LaTeX toggle before applyTheme: theme application invalidates the
  // transcript components, which rebuild their Markdown children and copy the
  // options at construction — so the new value must be live by then.
  setMarkdownRenderLatex(config.renderLatex ?? true);
  const resolved = config.theme === 'auto'
    ? (currentTheme.palette === lightColors ? 'light' : 'dark')
    : undefined;
  await host.applyTheme(config.theme, resolved);
  host.refreshTerminalThemeTracking();
  host.setAppState({
    editorCommand: config.editorCommand,
    disablePasteBurst: config.disablePasteBurst,
    renderLatex: config.renderLatex,
    cacheExpiryHint: config.cacheExpiryHint,
    disableFeedbackSurvey: config.disableFeedbackSurvey,
    notifications: config.notifications,
    upgrade: config.upgrade,
    statusLine: config.statusLine,
  });
  host.state.editor.setDisablePasteBurst(config.disablePasteBurst);
}
