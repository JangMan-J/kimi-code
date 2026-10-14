import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { resolveProgramPath } from '#/environment/programPath';

import { resolveLauncher } from '#/remote/client/launchers';

describe('launcher lowering', () => {
  it('lowers ssh to the fixed argv shape', () => {
    expect(resolveLauncher({ type: 'ssh', host: 'dev-box' })).toEqual({
      program: 'ssh',
      args: [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'ServerAliveInterval=15',
        '-o',
        'ServerAliveCountMax=3',
        '-o',
        'StrictHostKeyChecking=accept-new',
        'dev-box',
        `~'/.kimi-code/bin/kimi' 'exec-server' '--listen' 'stdio'`,
      ],
    });
  });
});

describe('launcher operand validation', () => {
  it('rejects an ssh host that would be parsed as an option', () => {
    expect(() => resolveLauncher({ type: 'ssh', host: '-oProxyCommand=./pwn' })).toThrow(
      /ssh host must not start with '-'/,
    );
    expect(() => resolveLauncher({ type: 'ssh', host: '' })).toThrow(/ssh host must not be empty/);
  });

  it('rejects a docker container that would be parsed as a flag', () => {
    expect(() => resolveLauncher({ type: 'docker', container: '-v' })).toThrow(
      /docker container must not start with '-'/,
    );
    expect(() => resolveLauncher({ type: 'docker', container: '' })).toThrow(
      /docker container must not be empty/,
    );
  });
});

describe('ssh remote command quoting', () => {
  it('quotes shell metacharacters in remoteBin against remote re-parsing', () => {
    const resolved = resolveLauncher({ type: 'ssh', host: 'dev-box', remoteBin: '/opt/$(whoami)/kimi' });
    expect(resolved.args.at(-1)).toBe(`'/opt/$(whoami)/kimi' 'exec-server' '--listen' 'stdio'`);
  });

  it('keeps tilde prefixes expandable while quoting the remainder', () => {
    expect(resolveLauncher({ type: 'ssh', host: 'dev-box', remoteBin: '~/bin/kimi' }).args.at(-1)).toBe(
      `~'/bin/kimi' 'exec-server' '--listen' 'stdio'`,
    );
    expect(resolveLauncher({ type: 'ssh', host: 'dev-box', remoteBin: '~deploy/bin/kimi' }).args.at(-1)).toBe(
      `~deploy'/bin/kimi' 'exec-server' '--listen' 'stdio'`,
    );
    expect(resolveLauncher({ type: 'ssh', host: 'dev-box', remoteBin: '~' }).args.at(-1)).toBe(
      `~ 'exec-server' '--listen' 'stdio'`,
    );
  });

  it('escapes single quotes inside remoteBin', () => {
    const resolved = resolveLauncher({ type: 'ssh', host: 'dev-box', remoteBin: `/opt/it's/kimi` });
    expect(resolved.args.at(-1)).toBe(`'/opt/it'\\''s/kimi' 'exec-server' '--listen' 'stdio'`);
  });
});

describe('command launcher environment', () => {
  it('drops host secrets from the resolved command launcher env', () => {
    vi.stubEnv('REMOTE_EXEC_TEST_LLM_KEY', 'secret');
    try {
      const resolved = resolveLauncher({ type: 'command', program: process.execPath });
      expect(resolved.env?.['REMOTE_EXEC_TEST_LLM_KEY']).toBeUndefined();
      expect(resolved.env?.['PATH']).toBe(process.env['PATH']);
      expect(resolved.env?.['HOME']).toBe(process.env['HOME']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('command program PATH resolution', () => {
  let sandbox: string;
  let pathDir: string;
  let cwdDir: string;

  beforeAll(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'remote-exec-path-'));
    pathDir = join(sandbox, 'path-dir');
    cwdDir = join(sandbox, 'cwd-dir');
    await mkdir(pathDir);
    await mkdir(cwdDir);
    await writeFile(join(pathDir, 'sandbox'), '#!/bin/sh\nexit 0\n');
    await chmod(join(pathDir, 'sandbox'), 0o755);
    await writeFile(join(pathDir, 'not-executable'), 'x');
    await chmod(join(pathDir, 'not-executable'), 0o644);
    await writeFile(join(cwdDir, 'smuggled'), '#!/bin/sh\nexit 0\n');
    await chmod(join(cwdDir, 'smuggled'), 0o755);
  });

  afterAll(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('skips relative PATH entries', () => {
    expect(resolveProgramPath('sandbox', { cwd: cwdDir, pathEnv: `relative:${pathDir}` })).toBe(
      join(pathDir, 'sandbox'),
    );
  });

  it('refuses a PATH hit inside the working directory', () => {
    expect(() => resolveProgramPath('smuggled', { cwd: cwdDir, pathEnv: cwdDir })).toThrow(
      /refusing cwd match/,
    );
    expect(() => resolveProgramPath('./sandbox', { cwd: cwdDir, pathEnv: pathDir })).toThrow(
      /must be an absolute path/,
    );
    expect(() =>
      resolveProgramPath(join(cwdDir, 'smuggled'), { cwd: cwdDir, pathEnv: pathDir }),
    ).toThrow(/refusing cwd match/);
  });
});
