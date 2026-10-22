import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import type { ILogService } from '#/_base/log/log';
import type { IEventService } from '#/app/event/event';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { FileWorkspacePersistence } from '#/app/workspace/fileWorkspacePersistence';
import { WorkspaceService } from '#/app/workspace/workspaceService';
import { WorkspaceStateService } from '#/workspace/state/workspaceStateService';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { WorkspaceDirsService } from '#/workspace/workspaceDirs/workspaceDirsService';

import { stubBootstrap } from '../../app/bootstrap/stubs';

const noopLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
} as unknown as ILogService;

const noopEvent = {
  publish: () => {},
  subscribe: () => ({ dispose: () => {} }),
} as unknown as IEventService;

describe('WorkspaceDirsService (registry source)', () => {
  let homeDir: string;
  let dirA: string;
  let dirB: string;
  let dirC: string;
  let disposables: DisposableStore;
  let persistence: FileWorkspacePersistence;
  let workspaces: WorkspaceService;

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'ws-dirs-home-'));
    dirA = mkdtempSync(join(tmpdir(), 'ws-dirs-a-'));
    dirB = mkdtempSync(join(tmpdir(), 'ws-dirs-b-'));
    dirC = mkdtempSync(join(tmpdir(), 'ws-dirs-c-'));
    disposables = new DisposableStore();
    const storage = new FileStorageService(homeDir);
    const hostFs = new HostFileSystem();
    const bootstrap = stubBootstrap(homeDir);
    persistence = disposables.add(
      new FileWorkspacePersistence(new JsonAtomicDocumentStore(storage), bootstrap),
    );
    const localConfig = new FileProjectLocalConfigService(bootstrap, hostFs);
    workspaces = new WorkspaceService(
      persistence,
      storage,
      new AppendLogStore(storage, noopLog),
      hostFs,
      localConfig,
      noopLog,
      noopEvent,
    );
  });

  afterEach(async () => {
    disposables.dispose();
    await Promise.all(
      [homeDir, dirA, dirB, dirC].map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  function createDirs(cwd: string, workspaceId: string): WorkspaceDirsService {
    const bootstrap = stubBootstrap(homeDir);
    const hostFs = new HostFileSystem();
    return disposables.add(
      new WorkspaceDirsService(
        {
          _serviceBrand: undefined,
          workspaceId,
          cwd,
          root: cwd,
          source: 'local',
          persistenceScope: `sessions/${workspaceId}`,
        } as unknown as IWorkspaceContext,
        new FileProjectLocalConfigService(bootstrap, hostFs),
        workspaces,
        persistence,
        noopLog,
        new WorkspaceStateService(),
      ),
    );
  }

  it('injects the registry dir set minus cwd for both primary and member scopes', async () => {
    const project = await workspaces.create({ root: dirA, additionalDirs: [dirB], name: 'proj' });

    const primary = createDirs(dirA, project.id);
    await primary.ready;
    expect(primary.additionalDirs).toEqual([dirB]);

    const member = createDirs(dirB, 'wd_other_000000000000');
    await member.ready;
    expect(member.additionalDirs).toEqual([dirA]);

    const outsider = createDirs(dirC, 'wd_else_000000000000');
    await outsider.ready;
    expect(outsider.additionalDirs).toEqual([]);
  });

  it('merges registry dirs with local.toml dirs and ephemeral dirs', async () => {
    await mkdir(join(dirA, '.kimi-code'), { recursive: true });
    await writeFile(
      join(dirA, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = ["${dirC.replaceAll('\\', '\\\\')}"]\n`,
      'utf8',
    );
    const project = await workspaces.create({ root: dirA, additionalDirs: [dirB], name: 'proj' });

    const dirs = createDirs(dirA, project.id);
    await dirs.ready;
    expect(dirs.additionalDirs).toEqual([dirC, dirB]);

    await dirs.addDir({ path: dirB, persist: false });
    expect(dirs.additionalDirs).toEqual([dirC, dirB]);
  });

  it('pushes registry updates live through the persistence change event', async () => {
    const project = await workspaces.create({ root: dirA, name: 'proj' });
    const dirs = createDirs(dirA, project.id);
    await dirs.ready;
    expect(dirs.additionalDirs).toEqual([]);

    let fired = 0;
    dirs.onDidChange(() => {
      fired += 1;
    });
    await workspaces.update(project.id, { additionalDirs: [dirB] });
    await vi.waitFor(() => {
      expect(dirs.additionalDirs).toEqual([dirB]);
    });
    expect(fired).toBeGreaterThan(0);
  });
});
