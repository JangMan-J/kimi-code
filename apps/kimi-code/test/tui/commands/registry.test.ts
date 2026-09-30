import {
  BUILTIN_SLASH_COMMANDS,
  findBuiltInSlashCommand,
  parseSlashInput,
  resolveSlashCommandAvailability,
  sortSlashCommands,
  type KimiSlashCommand,
} from '#/tui/commands/index';
import { describe, expect, it } from 'vitest';

describe('parseSlashInput', () => {
  it('parses command names and trimmed args', () => {
    expect(parseSlashInput('/help')).toEqual({ name: 'help', args: '' });
    expect(parseSlashInput('/model   kimi-k2  ')).toEqual({
      name: 'model',
      args: 'kimi-k2',
    });
  });

  it('returns null for non-commands and path-like input', () => {
    expect(parseSlashInput('hello')).toBeNull();
    expect(parseSlashInput('/')).toBeNull();
    expect(parseSlashInput('/   ')).toBeNull();
    expect(parseSlashInput('/some/path')).toBeNull();
    expect(parseSlashInput('/some/path with args')).toBeNull();
  });
});

describe('built-in slash command registry', () => {
  it('finds built-ins by name or alias', () => {
    expect(findBuiltInSlashCommand('exit')?.name).toBe('exit');
    expect(findBuiltInSlashCommand('quit')?.name).toBe('exit');
    expect(findBuiltInSlashCommand('q')?.name).toBe('exit');
    expect(findBuiltInSlashCommand('clear')?.name).toBe('new');
    expect(findBuiltInSlashCommand('bug')?.name).toBe('feedback');
    expect(findBuiltInSlashCommand('status')?.name).toBe('status');
    expect(findBuiltInSlashCommand('usage')?.aliases).not.toContain('status');
    expect(findBuiltInSlashCommand('unknown')).toBeUndefined();
  });

  it('marks plan clear as idle-only while normal plan toggles are always available', () => {
    const plan = findBuiltInSlashCommand('plan');
    expect(plan).toBeDefined();
    expect(resolveSlashCommandAvailability(plan!, '')).toBe('always');
    expect(resolveSlashCommandAvailability(plan!, 'on')).toBe('always');
    expect(resolveSlashCommandAvailability(plan!, 'clear')).toBe('idle-only');
  });

  it('defaults commands without explicit availability to idle-only', () => {
    const command: KimiSlashCommand = {
      name: 'example',
      aliases: [],
      description: 'Example command',
    };

    expect(resolveSlashCommandAvailability(command, '')).toBe('idle-only');
  });

  it('sorts commands by priority descending and name ascending', () => {
    const commands: KimiSlashCommand[] = [
      { name: 'zebra', aliases: [], description: 'Z', priority: 100 },
      { name: 'alpha', aliases: [], description: 'A', priority: 100 },
      { name: 'middle', aliases: [], description: 'M', priority: 50 },
      { name: 'plain', aliases: [], description: 'P' },
    ];

    expect(sortSlashCommands(commands).map((command) => command.name)).toEqual([
      'alpha',
      'zebra',
      'middle',
      'plain',
    ]);
  });

  it('contains the expected command names once', () => {
    const names = BUILTIN_SLASH_COMMANDS.map((command) => command.name);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        'compact',
        'editor',
        'exit',
        'help',
        'login',
        'logout',
        'model',
        'new',
        'permission',
        'plan',
        'reload-tui',
        'sessions',
        'settings',
        'status',
        'theme',
        'title',
        'undo',
        'usage',
        'version',
        'yolo',
        'auto',
      ]),
    );
  });

  it('keeps TUI reload always available', () => {
    const reloadTui = findBuiltInSlashCommand('reload-tui');

    expect(reloadTui).toBeDefined();
    expect(resolveSlashCommandAvailability(reloadTui!, '')).toBe('always');
  });
});

describe('dynamic skill and plugin slash commands', () => {
  it('builds skill commands with bare names for builtin and skill: prefix otherwise', async () => {
    const { buildSkillSlashCommands } = await import('#/tui/commands/skills');

    const { commands, commandMap } = buildSkillSlashCommands([
      { name: 'write-goal', description: 'builtin skill', path: '/b', source: 'builtin' },
      { name: 'deploy', description: 'workspace skill', path: '/w', source: 'project' },
      { name: 'helper', description: 'sub skill', path: '/s', source: 'project', isSubSkill: true },
      { name: 'ref', description: 'reference skill', path: '/r', source: 'user', type: 'reference' },
    ]);

    expect(commandMap.get('write-goal')).toBe('write-goal');
    expect(commandMap.get('skill:deploy')).toBe('deploy');
    expect(commandMap.get('helper')).toBe('helper');
    expect(commandMap.has('ref')).toBe(false);
    expect(commandMap.has('skill:write-goal')).toBe(false);
    expect(commands.map((command) => command.name)).toEqual([
      'write-goal',
      'skill:deploy',
      'helper',
    ]);
  });

  it('drops bare-named skill commands that collide with builtin command names', async () => {
    const { buildSkillSlashCommands } = await import('#/tui/commands/skills');

    const { commandMap } = buildSkillSlashCommands([
      { name: 'goal', description: 'collides with /goal', path: '/g', source: 'builtin' },
      { name: 'compact', description: 'namespaced form survives', path: '/c', source: 'project' },
    ]);

    expect(commandMap.has('goal')).toBe(false);
    expect(commandMap.get('skill:compact')).toBe('compact');
  });

  it('builds plugin commands under the plugin:command namespace', async () => {
    const { buildPluginSlashCommands, pluginCommandName } = await import(
      '#/tui/commands/plugin-commands'
    );

    expect(pluginCommandName('demo', 'deploy')).toBe('demo:deploy');
    const { commands, commandMap } = buildPluginSlashCommands([
      {
        pluginId: 'demo',
        name: 'deploy',
        description: 'deploy it',
        body: 'Deploy $ARGUMENTS',
        path: '/p/deploy.md',
      },
    ]);

    expect(commandMap.get('demo:deploy')).toBe('Deploy $ARGUMENTS');
    expect(commands[0]?.name).toBe('demo:deploy');
    expect(commands[0]?.description).toBe('deploy it');
  });
});
