import { isUserActivatableSkillType, type SkillSummary } from '@moonshot-ai/harness-core';

import { BUILTIN_SLASH_COMMANDS } from './registry';
import type { KimiSlashCommand } from './types';

export interface SkillSlashCommands {
  readonly commands: readonly KimiSlashCommand[];
  readonly commandMap: ReadonlyMap<string, string>;
}

const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_SLASH_COMMANDS.flatMap((command) => [command.name, ...command.aliases]),
);

export function buildSkillSlashCommands(skills: readonly SkillSummary[]): SkillSlashCommands {
  const commandMap = new Map<string, string>();
  const sorted = [...skills].toSorted(
    (a, b) =>
      (a.source === 'builtin' ? 0 : 1) - (b.source === 'builtin' ? 0 : 1) ||
      a.name.localeCompare(b.name),
  );
  const commands: KimiSlashCommand[] = [];
  for (const skill of sorted) {
    if (!isUserActivatableSkillType(skill.type)) continue;
    const commandName =
      skill.source === 'builtin' || skill.isSubSkill === true
        ? skill.name
        : `skill:${skill.name}`;
    if (RESERVED_COMMAND_NAMES.has(commandName)) continue;
    commandMap.set(commandName, skill.name);
    commands.push({
      name: commandName,
      aliases: [],
      description: skill.description,
    });
  }
  return { commands, commandMap };
}
