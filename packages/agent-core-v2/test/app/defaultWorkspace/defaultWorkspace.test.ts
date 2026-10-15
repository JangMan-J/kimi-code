import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { LifecycleScope } from '#/app/scopes';
import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IDefaultWorkspace } from '#/app/defaultWorkspace/defaultWorkspace';
import { DefaultWorkspaceService } from '#/app/defaultWorkspace/defaultWorkspaceService';
import {
  parseWindowsPersonalFolder,
  parseXdgDocumentsDir,
} from '#/app/defaultWorkspace/defaultWorkspacePaths';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { stubBootstrap } from '../bootstrap/stubs';

describe('default workspace paths', () => {
  it('reads XDG_DOCUMENTS_DIR and treats the bare home directory as unset', () => {
    const home = '/home/alice';
    expect(parseXdgDocumentsDir('XDG_DOCUMENTS_DIR="$HOME/Dokumente"\n', home)).toBe(
      '/home/alice/Dokumente',
    );
    expect(parseXdgDocumentsDir('XDG_DOCUMENTS_DIR="/data/docs"', home)).toBe('/data/docs');
    expect(parseXdgDocumentsDir('XDG_DOCUMENTS_DIR="$HOME/"', home)).toBeUndefined();
    expect(parseXdgDocumentsDir('XDG_DESKTOP_DIR="$HOME/Desktop"', home)).toBeUndefined();
  });

  it('expands the registered Windows documents folder and rejects unresolved variables', () => {
    const env: Record<string, string> = { USERPROFILE: 'C:\\Users\\alice' };
    const getEnv = (name: string): string | undefined => env[name];
    const expandable = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
      '    Personal    REG_EXPAND_SZ    %USERPROFILE%\\Documents',
      '',
    ].join('\r\n');
    expect(parseWindowsPersonalFolder(expandable, getEnv)).toBe('C:\\Users\\alice\\Documents');
    expect(
      parseWindowsPersonalFolder('    Personal    REG_SZ    D:\\OneDrive\\Docs', getEnv),
    ).toBe('D:\\OneDrive\\Docs');
    expect(
      parseWindowsPersonalFolder('    Personal    REG_EXPAND_SZ    %MISSING%\\Docs', getEnv),
    ).toBeUndefined();
  });
});

describe('DefaultWorkspaceService', () => {
  let osHomeDir: string;
  let currentHost: ReturnType<typeof createScopedTestHost> | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IDefaultWorkspace,
      DefaultWorkspaceService,
      ScopeActivation.OnDemand,
      'defaultWorkspace',
    );
    osHomeDir = await fsp.mkdtemp(join(os.tmpdir(), 'default-workspace-home-'));
  });

  afterEach(async () => {
    currentHost?.dispose();
    currentHost = undefined;
    await fsp.chmod(join(osHomeDir, 'Documents'), 0o755).catch(() => undefined);
    await fsp.rm(osHomeDir, { recursive: true, force: true });
  });

  function build(
    env: NodeJS.ProcessEnv = {},
    windows?: { spawn: IHostProcessService['spawn'] },
  ): IDefaultWorkspace {
    const bootstrap = stubBootstrap('/tmp/kimi-home', env, {}, osHomeDir);
    currentHost = createScopedTestHost([
      stubPair(
        IBootstrapService,
        windows === undefined ? bootstrap : { ...bootstrap, platform: 'win32' },
      ),
      stubPair(IHostFileSystem, new HostFileSystem()),
      stubPair(IHostProcessService, (windows ?? {}) as IHostProcessService),
    ]);
    return currentHost.app.accessor.get(IDefaultWorkspace);
  }

  function registryReply(documentsDir: string): IHostProcessService['spawn'] {
    const output = `    Personal    REG_SZ    ${documentsDir}\r\n`;
    return (async () => ({
      stdout: (async function* () {
        yield output;
      })(),
      wait: async () => 0,
      dispose: () => undefined,
    })) as unknown as IHostProcessService['spawn'];
  }

  const registryUnavailable = (async () => {
    throw new Error('spawn reg ENOENT');
  }) as unknown as IHostProcessService['spawn'];

  it('places the directory under the Windows registered documents folder', async () => {
    const documentsDir = join(osHomeDir, 'OneDrive', 'Docs');

    const root = await build({}, { spawn: registryReply(documentsDir) }).ensure();

    expect(root).toBe(join(documentsDir, 'KimiCode', 'Default'));
  });

  it('fails instead of falling back when the Windows documents folder cannot be resolved', async () => {
    const service = build({}, { spawn: registryUnavailable });

    await expect(service.ensure()).rejects.toMatchObject({ code: 'fs.path_not_found' });
    expect(await service.isDefault(join(osHomeDir, 'Documents', 'KimiCode', 'Default'))).toBe(
      false,
    );
    await expect(fsp.stat(join(osHomeDir, 'Documents'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('retries the Windows documents lookup after a failure', async () => {
    const documentsDir = join(osHomeDir, 'Docs');
    let attempts = 0;
    const spawn = ((...args: Parameters<IHostProcessService['spawn']>) => {
      attempts += 1;
      return attempts === 1 ? registryUnavailable(...args) : registryReply(documentsDir)(...args);
    }) as IHostProcessService['spawn'];
    const service = build({}, { spawn });

    await expect(service.ensure()).rejects.toMatchObject({ code: 'fs.path_not_found' });
    expect(await service.ensure()).toBe(join(documentsDir, 'KimiCode', 'Default'));
  });

  it('creates the directory on first use and reuses it afterwards', async () => {
    const service = build();
    const root = join(osHomeDir, 'Documents', 'KimiCode', 'Default');

    expect(await service.ensure()).toBe(root);
    await fsp.writeFile(join(root, 'notes.md'), 'kept', 'utf8');
    expect(await service.ensure()).toBe(root);

    expect(await fsp.readFile(join(root, 'notes.md'), 'utf8')).toBe('kept');
  });

  it('recreates the directory after it has been removed', async () => {
    const service = build();
    const root = await service.ensure();
    await fsp.rm(join(osHomeDir, 'Documents', 'KimiCode'), { recursive: true });

    expect(await service.ensure()).toBe(root);
    expect((await fsp.stat(root)).isDirectory()).toBe(true);
  });

  it('places the directory under the configured XDG documents directory', async () => {
    const configHome = join(osHomeDir, 'config');
    await fsp.mkdir(configHome, { recursive: true });
    await fsp.writeFile(
      join(configHome, 'user-dirs.dirs'),
      'XDG_DOCUMENTS_DIR="$HOME/Dokumente"\n',
      'utf8',
    );

    const root = await build({ XDG_CONFIG_HOME: configHome }).ensure();

    expect(root).toBe(join(osHomeDir, 'Dokumente', 'KimiCode', 'Default'));
  });

  it('recognizes the default root regardless of a trailing separator', async () => {
    const service = build();
    const root = join(osHomeDir, 'Documents', 'KimiCode', 'Default');

    expect(await service.isDefault(root)).toBe(true);
    expect(await service.isDefault(`${root}/`)).toBe(true);
    expect(await service.isDefault(join(osHomeDir, 'Documents', 'KimiCode'))).toBe(false);
  });

  it.each([
    ['the default folder', ['KimiCode', 'Default']],
    ['a parent folder', ['KimiCode']],
  ])('reports a path blocked by a file at %s', async (_label, segments) => {
    const blocked = join(osHomeDir, 'Documents', ...segments);
    await fsp.mkdir(join(blocked, '..'), { recursive: true });
    await fsp.writeFile(blocked, 'not a folder', 'utf8');

    await expect(build().ensure()).rejects.toMatchObject({ code: 'fs.path_not_found' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a permission failure as is',
    async () => {
      const documents = join(osHomeDir, 'Documents');
      await fsp.mkdir(documents, { recursive: true });
      await fsp.chmod(documents, 0o500);

      await expect(build().ensure()).rejects.toMatchObject({ code: 'os.fs.permission_denied' });
    },
  );
});
