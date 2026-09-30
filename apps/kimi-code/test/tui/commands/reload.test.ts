import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleReloadTuiCommand } from '#/tui/commands/reload';
import type { SlashCommandHost } from '#/tui/commands';
import {
  createMarkdownOptions,
  setMarkdownRenderLatex,
} from '#/tui/utils/markdown-options';

const tempDirs: string[] = [];
const originalKimiCodeHome = process.env['KIMI_CODE_HOME'];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  if (originalKimiCodeHome === undefined) {
    delete process.env['KIMI_CODE_HOME'];
  } else {
    process.env['KIMI_CODE_HOME'] = originalKimiCodeHome;
  }
});

describe('reload-tui slash command', () => {
  it('reloads tui.toml without touching engine state', async () => {
    await writeTuiConfig(`
theme = "light"
cache_expiry_hint = false

[editor]
command = "vim"

[notifications]
enabled = false
notification_condition = "always"

[upgrade]
auto_install = false
`);
    const host = makeHost();

    await handleReloadTuiCommand(host);

    expect(host.state.appState).toMatchObject({
      theme: 'light',
      editorCommand: 'vim',
      cacheExpiryHint: false,
      notifications: { enabled: false, condition: 'always' },
      upgrade: { autoInstall: false },
    });
    expect(host.showStatus).toHaveBeenCalledWith(
      'TUI config reloaded.',
      'success',
    );
  });

  it('awaits the async theme application before refreshing terminal tracking', async () => {
    await writeTuiConfig('theme = "auto"\n');
    const host = makeHost();
    const mutable = host as unknown as {
      applyTheme: (theme: string) => Promise<void>;
      refreshTerminalThemeTracking: () => void;
      state: { appState: { theme: string } };
    };

    let themeWhenTracked: string | undefined;
    // Theme application resolves on a later microtask, mirroring the real
    // async palette load; tracking must observe the *new* theme.
    mutable.applyTheme = vi.fn(async (theme: string) => {
      await Promise.resolve();
      mutable.state.appState.theme = theme;
    });
    mutable.refreshTerminalThemeTracking = vi.fn(() => {
      themeWhenTracked = mutable.state.appState.theme;
    });

    await handleReloadTuiCommand(host);

    expect(themeWhenTracked).toBe('auto');
  });

  it('applies the render_latex toggle before theme application rebuilds Markdown', async () => {
    await writeTuiConfig('render_latex = false\n');
    const host = makeHost();

    // applyTheme invalidates transcript components, which rebuild their
    // Markdown children by copying the shared options — the reloaded value
    // must already be live at that point.
    let latexWhenThemeApplied: boolean | undefined;
    const mutable = host as unknown as { applyTheme: unknown };
    mutable.applyTheme = vi.fn(() => {
      latexWhenThemeApplied = createMarkdownOptions().renderLatex;
    });

    try {
      await handleReloadTuiCommand(host);
      expect(latexWhenThemeApplied).toBe(false);
    } finally {
      setMarkdownRenderLatex(true);
    }
  });
});

async function writeTuiConfig(text: string): Promise<void> {
  const dir = join(tmpdir(), `kimi-tui-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  process.env['KIMI_CODE_HOME'] = dir;
  await writeFile(join(dir, 'tui.toml'), text, 'utf-8');
}

function makeHost() {
  const state = {
    appState: {
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
      availableModels: {},
      availableProviders: {},
    },
    editor: {
      setDisablePasteBurst: vi.fn(),
    },
    theme: {
      palette: {
        success: '#00ff00',
      },
    },
  };
  return {
    state,
    setAppState: vi.fn((patch: Record<string, unknown>) => {
      Object.assign(state.appState, patch);
    }),
    applyTheme: vi.fn(async (theme: string) => {
      state.appState.theme = theme;
    }),
    refreshTerminalThemeTracking: vi.fn(),
    showStatus: vi.fn(),
  } as unknown as SlashCommandHost & {
    state: typeof state;
    setAppState: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
  };
}
