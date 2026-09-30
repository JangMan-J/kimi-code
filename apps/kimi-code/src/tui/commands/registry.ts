import type { AutocompleteItem } from '@moonshot-ai/pi-tui';

import type { KimiSlashCommand, SlashCommandAvailability } from './types';

export const BUILTIN_SLASH_COMMANDS = [
  {
    name: 'yolo',
    aliases: ['yes'],
    description: 'Ask When Needed mode: routine edits and commands run automatically; risky actions, questions, and plans still ask.',
    priority: 101,
    availability: 'always',
  },
  {
    name: 'auto',
    aliases: [],
    description: 'Never Ask mode: never interrupts you; everything runs and is decided automatically.',
    priority: 99,
    availability: 'always',
  },
  {
    name: 'permission',
    aliases: [],
    description: 'Select permission mode',
    priority: 100,
    availability: 'always',
  },
  {
    name: 'settings',
    aliases: ['config'],
    description: 'Open TUI settings',
    priority: 100,
    availability: 'always',
  },
  {
    name: 'plan',
    aliases: [],
    description: 'Toggle plan mode',
    priority: 100,
    availability: (args) => (args.trim().toLowerCase() === 'clear' ? 'idle-only' : 'always'),
  },
  {
    name: 'model',
    aliases: [],
    description: 'Switch LLM model',
    priority: 100,
    availability: 'always',
  },
  {
    name: 'effort',
    aliases: ['thinking'],
    description: 'Switch thinking effort',
    priority: 95,
    availability: 'always',
  },
  {
    name: 'help',
    aliases: ['h', '?'],
    description: 'Show available commands and shortcuts',
    priority: 80,
    availability: 'always',
  },
  {
    name: 'new',
    aliases: ['clear'],
    description: 'Start a fresh session in the current workspace',
    priority: 80,
  },
  {
    name: 'sessions',
    aliases: ['resume'],
    description: 'Browse and resume sessions',
    priority: 80,
  },
  {
    name: 'tasks',
    aliases: ['task'],
    description: 'Browse background tasks',
    priority: 80,
    availability: 'always',
  },
  {
    name: 'mcp',
    aliases: [],
    description: 'Show MCP server status',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'goal',
    aliases: [],
    description: 'Start or manage a goal (status/pause/resume/cancel)',
    priority: 80,
    argumentHint: '<objective>',
  },
  {
    name: 'btw',
    aliases: [],
    description: 'Ask a side question in a read-only fork',
    priority: 60,
    argumentHint: '<question>',
    availability: 'always',
  },
  {
    name: 'swarm',
    aliases: [],
    description: 'Toggle swarm mode or start a swarm task',
    priority: 60,
    argumentHint: 'on|off|<task>',
  },
  {
    name: 'fork',
    aliases: [],
    description: 'Fork the current session and switch to the fork',
    priority: 60,
    availability: 'idle-only',
  },
  {
    name: 'export-md',
    aliases: ['export'],
    description: 'Export the current session as Markdown',
    priority: 50,
    argumentHint: '[output-path]',
    availability: 'always',
  },
  {
    name: 'export-debug-zip',
    aliases: [],
    description: 'Export the current session as a debug zip',
    priority: 50,
    availability: 'always',
  },
  {
    name: 'init',
    aliases: [],
    description: 'Generate an AGENTS.md for this workspace',
    priority: 60,
    availability: 'idle-only',
  },
  {
    name: 'reload',
    aliases: [],
    description: 'Reload config, skills, profiles, plugins, and MCP servers',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'provider',
    aliases: [],
    description: 'Manage providers and models',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'plugins',
    aliases: ['plugin'],
    description: 'Manage installed plugins',
    priority: 50,
    availability: 'always',
  },
  {
    name: 'compact',
    aliases: [],
    description: 'Compact the conversation context',
    priority: 80,
    argumentHint: '<instruction>',
  },
  {
    name: 'title',
    aliases: ['rename'],
    description: 'Set or show session title',
    priority: 60,
    argumentHint: '<title>',
    availability: 'always',
  },
  {
    name: 'usage',
    aliases: [],
    description: 'Show session tokens + context window + plan quotas',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'status',
    aliases: [],
    description: 'Show current session and runtime status',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'feedback',
    aliases: ['bug'],
    description: 'Send feedback to make Kimi Code better',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'undo',
    aliases: [],
    description: 'Withdraw the last prompt from the transcript',
    priority: 80,
    availability: 'idle-only',
  },
  {
    name: 'editor',
    aliases: [],
    description: 'Set the external editor for Ctrl-G',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'theme',
    aliases: [],
    description: 'Set the terminal UI theme',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'reload-tui',
    aliases: [],
    description: 'Reload only tui.toml UI preferences',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'logout',
    aliases: ['disconnect'],
    description: 'Log out of a configured provider',
    priority: 40,
  },
  {
    name: 'login',
    aliases: [],
    description: 'Select a platform and authenticate',
    priority: 40,
  },
  {
    name: 'copy',
    aliases: [],
    description: 'Copy the last assistant message to the clipboard',
    priority: 40,
  },
  {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: 'Exit the application',
    priority: 20,
  },
  {
    name: 'version',
    aliases: [],
    description: 'Show version information',
    priority: 20,
    availability: 'always',
  },
] as const satisfies readonly KimiSlashCommand[];

export type BuiltinSlashCommand = (typeof BUILTIN_SLASH_COMMANDS)[number];
export type BuiltinSlashCommandName = BuiltinSlashCommand['name'];

export function findBuiltInSlashCommand(commandName: string): BuiltinSlashCommand | undefined {
  const commands = BUILTIN_SLASH_COMMANDS as readonly KimiSlashCommand<BuiltinSlashCommandName>[];
  return commands.find(
    (command) => command.name === commandName || command.aliases.includes(commandName),
  ) as BuiltinSlashCommand | undefined;
}

export function resolveSlashCommandAvailability(
  command: KimiSlashCommand,
  args: string,
): SlashCommandAvailability {
  const availability = command.availability ?? 'idle-only';
  return typeof availability === 'function' ? availability(args) : availability;
}

export function sortSlashCommands(commands: readonly KimiSlashCommand[]): KimiSlashCommand[] {
  return [...commands].toSorted(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name),
  );
}

export type { AutocompleteItem };
