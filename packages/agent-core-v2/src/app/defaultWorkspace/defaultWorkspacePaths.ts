import { join } from 'pathe';

export const DEFAULT_WORKSPACE_RELATIVE_ROOT = ['KimiCode', 'Default'] as const;

export function parseXdgDocumentsDir(content: string, osHomeDir: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*XDG_DOCUMENTS_DIR\s*=\s*"(.*)"\s*$/.exec(line);
    if (match === null) continue;
    const raw = match[1]!;
    const expanded = raw.replace(/^\$HOME(?=\/|$)/, osHomeDir);
    if (!expanded.startsWith('/') || expanded === osHomeDir || expanded === `${osHomeDir}/`) {
      return undefined;
    }
    return expanded;
  }
  return undefined;
}

export function parseWindowsPersonalFolder(
  regOutput: string,
  getEnv: (name: string) => string | undefined,
): string | undefined {
  for (const line of regOutput.split(/\r?\n/)) {
    const match = /^\s*Personal\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    let unresolved = false;
    const expanded = match[1]!.replaceAll(/%([^%]+)%/g, (whole, name: string) => {
      const value = getEnv(name);
      if (value === undefined) unresolved = true;
      return value ?? whole;
    });
    return unresolved ? undefined : expanded;
  }
  return undefined;
}

export function defaultDocumentsDir(osHomeDir: string): string {
  return join(osHomeDir, 'Documents');
}
