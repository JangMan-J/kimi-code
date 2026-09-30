import {
  PluginRef,
  type PluginFace,
  type PluginSummary,
} from '@moonshot-ai/harness-core/features/plugin/index';

import { PluginsSelectorComponent } from '../components/dialogs/plugins-selector';
import { formatErrorMessage } from '../utils/errors';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// /plugins command
// ---------------------------------------------------------------------------

export async function handlePluginsCommand(host: SlashCommandHost, rawArgs: string): Promise<void> {
  const args = rawArgs.trim().split(/\s+/).filter((part) => part.length > 0);
  const sub = args[0];
  const plugin = resolvePlugin(host);
  if (plugin === undefined) {
    host.showError('Plugins are not available in this build.');
    return;
  }

  try {
    if (sub === undefined) {
      await showPluginsSelector(host, plugin);
      return;
    }
    if (sub === 'list') {
      await renderPluginsList(host, plugin);
      return;
    }
    if (sub === 'enable' || sub === 'disable') {
      const id = args[1];
      if (id === undefined) {
        host.showError(`Usage: /plugins ${sub} <id>`);
        return;
      }
      await applyPluginEnabled(host, plugin, id, sub === 'enable');
      return;
    }
    if (sub === 'remove') {
      const id = args[1];
      if (id === undefined) {
        host.showError('Usage: /plugins remove <id>');
        return;
      }
      await plugin.removePlugin(id);
      host.showStatus(`Removed ${id}.`);
      return;
    }
    if (sub === 'reload') {
      await reloadPlugins(host, plugin);
      return;
    }
    host.showError(`Unknown /plugins action: ${sub}. Run /plugins to manage interactively.`);
  } catch (error) {
    host.showError(`/plugins ${sub ?? ''} failed: ${formatErrorMessage(error)}`);
  }
}

function resolvePlugin(host: SlashCommandHost): PluginFace | undefined {
  try {
    return host.harness.app.resolve(PluginRef);
  } catch {
    return undefined;
  }
}

async function showPluginsSelector(host: SlashCommandHost, plugin: PluginFace): Promise<void> {
  let summaries: readonly PluginSummary[];
  try {
    summaries = await plugin.listPlugins();
  } catch (error) {
    host.showError(`Failed to load plugins: ${formatErrorMessage(error)}`);
    return;
  }

  let selector: PluginsSelectorComponent;
  const callbacks = {
    onToggle: (id: string, enabled: boolean) => {
      void applyPluginEnabled(host, plugin, id, enabled, false)
        .catch((error: unknown) => {
          host.showError(`Failed to update ${id}: ${formatErrorMessage(error)}`);
        })
        .then(() => refreshSelector());
    },
    onRemove: (id: string) => {
      void plugin
        .removePlugin(id)
        .then(() => {
          host.showStatus(`Removed ${id}.`);
        })
        .catch((error: unknown) => {
          host.showError(`Failed to remove ${id}: ${formatErrorMessage(error)}`);
        })
        .then(() => refreshSelector());
    },
    onReload: () => {
      void reloadPlugins(host, plugin).then(() => refreshSelector());
    },
    onClose: () => {
      host.restoreEditor();
    },
  };
  const refreshSelector = async (): Promise<void> => {
    try {
      const fresh = await plugin.listPlugins();
      selector.setOptions({ plugins: fresh, ...callbacks });
      host.state.ui.requestRender();
    } catch {
      // The selector keeps rendering its last snapshot.
    }
  };
  selector = new PluginsSelectorComponent({ plugins: summaries, ...callbacks });
  host.mountEditorReplacement(selector);
}

async function applyPluginEnabled(
  host: SlashCommandHost,
  plugin: PluginFace,
  id: string,
  enabled: boolean,
  showStatus = true,
): Promise<void> {
  await plugin.setPluginEnabled(id, enabled);
  if (showStatus) {
    host.showStatus(
      `${enabled ? 'Enabled' : 'Disabled'} ${id}. Run /reload or /new to apply.`,
    );
  }
}

async function reloadPlugins(host: SlashCommandHost, plugin: PluginFace): Promise<void> {
  const summary = await plugin.reloadPlugins();
  const parts: string[] = [];
  if (summary.added.length > 0) parts.push(`added: ${summary.added.join(', ')}`);
  if (summary.removed.length > 0) parts.push(`removed: ${summary.removed.join(', ')}`);
  if (summary.errors.length > 0) {
    parts.push(`errors: ${summary.errors.map((entry) => `${entry.id} (${entry.message})`).join(', ')}`);
  }
  host.showStatus(parts.length > 0 ? `Plugins reloaded — ${parts.join('; ')}.` : 'Plugins reloaded.');
}

async function renderPluginsList(host: SlashCommandHost, plugin: PluginFace): Promise<void> {
  const summaries = await plugin.listPlugins();
  if (summaries.length === 0) {
    host.showStatus('No plugins installed.');
    return;
  }
  const lines = summaries.map(
    (summary) =>
      `  ${summary.id} — ${summary.enabled ? 'enabled' : 'disabled'} · ${String(summary.skillCount)} skills`,
  );
  host.showStatus(['Installed plugins:', ...lines].join('\n'));
}
