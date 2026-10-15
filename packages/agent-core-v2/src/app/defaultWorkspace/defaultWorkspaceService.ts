import { randomUUID } from 'node:crypto';

import { join } from 'pathe';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { workspaceRootKey } from '#/_base/utils/workdir-slug';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import { IHostProcessService } from '#/os/interface/hostProcess';

import { IDefaultWorkspace } from './defaultWorkspace';
import {
  DEFAULT_WORKSPACE_RELATIVE_ROOT,
  WINDOWS_DOCUMENTS_COMMAND,
  defaultDocumentsDir,
  parseWindowsDocumentsOutput,
  parseXdgDocumentsDir,
  windowsPowerShellPath,
} from './defaultWorkspacePaths';
import {
  DEFAULT_WORKSPACE_PROBLEM_MESSAGES,
  DefaultWorkspaceUnavailableError,
  type DefaultWorkspaceUnavailableReason,
} from './errors';

const WINDOWS_DOCUMENTS_TIMEOUT_MS = 15_000;

export class DefaultWorkspaceService implements IDefaultWorkspace {
  declare readonly _serviceBrand: undefined;

  private rootPromise: Promise<string> | undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostProcessService private readonly processes: IHostProcessService,
  ) {}

  async ensure(): Promise<string> {
    const root = await this.root();
    try {
      await this.fs.mkdir(root, { recursive: true });
    } catch (error) {
      throw unavailable(root, reasonOf(error), error);
    }
    const problem = await this.writeProblem(root);
    if (problem !== undefined) throw unavailable(root, problem);
    return root;
  }

  async isDefault(root: string): Promise<boolean> {
    const defaultRoot = await this.root().catch(() => undefined);
    return defaultRoot !== undefined && workspaceRootKey(root) === workspaceRootKey(defaultRoot);
  }

  private root(): Promise<string> {
    if (this.rootPromise === undefined) {
      const pending = this.documentsDir().then((dir) =>
        join(dir, ...DEFAULT_WORKSPACE_RELATIVE_ROOT),
      );
      this.rootPromise = pending;
      pending.catch(() => {
        if (this.rootPromise === pending) this.rootPromise = undefined;
      });
    }
    return this.rootPromise;
  }

  private async writeProblem(dir: string): Promise<DefaultWorkspaceUnavailableReason | undefined> {
    const probe = join(dir, `.kimi-code-write-test-${randomUUID()}`);
    let problem: DefaultWorkspaceUnavailableReason | undefined;
    try {
      if (!(await this.fs.createExclusive(probe, new Uint8Array()))) return 'unknown';
    } catch (error) {
      problem = reasonOf(error);
    }
    try {
      await this.fs.remove(probe);
    } catch (error) {
      if (!isNotFound(error)) problem ??= reasonOf(error);
    }
    return problem;
  }

  private async documentsDir(): Promise<string> {
    if (this.bootstrap.platform === 'win32') return this.windowsDocumentsDir();
    const fallback = defaultDocumentsDir(this.bootstrap.osHomeDir);
    if (this.bootstrap.platform === 'darwin') return fallback;
    return (await this.xdgDocumentsDir()) ?? fallback;
  }

  private async windowsDocumentsDir(): Promise<string> {
    let dir: string | undefined;
    let cause: unknown;
    try {
      dir = await this.queryWindowsDocumentsDir();
      if (dir !== undefined && !(await this.isDirectory(dir))) dir = undefined;
    } catch (error) {
      cause = error;
    }
    if (dir === undefined) {
      throw new DefaultWorkspaceUnavailableError(
        { path: undefined, reason: 'documents_unavailable' },
        'cannot locate the Windows Documents folder',
        cause,
      );
    }
    return dir;
  }

  private async queryWindowsDocumentsDir(): Promise<string | undefined> {
    const proc = await this.processes.spawn(
      windowsPowerShellPath(this.bootstrap.getEnv('SystemRoot') ?? this.bootstrap.getEnv('windir')),
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_DOCUMENTS_COMMAND],
      { windowsHide: true, timeout: WINDOWS_DOCUMENTS_TIMEOUT_MS },
    );
    try {
      const [stdout, exitCode] = await Promise.all([collect(proc.stdout), proc.wait()]);
      if (exitCode !== 0) return undefined;
      return parseWindowsDocumentsOutput(stdout);
    } finally {
      void proc.dispose();
    }
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      return (await this.fs.stat(path)).isDirectory;
    } catch {
      return false;
    }
  }

  private async xdgDocumentsDir(): Promise<string | undefined> {
    const configHome =
      this.bootstrap.getEnv('XDG_CONFIG_HOME') ?? join(this.bootstrap.osHomeDir, '.config');
    try {
      const content = await this.fs.readText(join(configHome, 'user-dirs.dirs'));
      return parseXdgDocumentsDir(content, this.bootstrap.osHomeDir);
    } catch {
      return undefined;
    }
  }
}

function unavailable(
  path: string | undefined,
  reason: DefaultWorkspaceUnavailableReason,
  cause?: unknown,
): DefaultWorkspaceUnavailableError {
  const where = path === undefined ? '' : ` ${path}`;
  return new DefaultWorkspaceUnavailableError(
    { path, reason },
    `default workspace${where} is unavailable: ${DEFAULT_WORKSPACE_PROBLEM_MESSAGES[reason]}`,
    cause,
  );
}

const REASON_BY_FS_CODE: ReadonlyMap<string, DefaultWorkspaceUnavailableReason> = new Map([
  [OsFsErrors.codes.OS_FS_ALREADY_EXISTS, 'blocked_by_file'],
  [OsFsErrors.codes.OS_FS_NOT_DIRECTORY, 'blocked_by_file'],
  [OsFsErrors.codes.OS_FS_PERMISSION_DENIED, 'permission_denied'],
  [OsFsErrors.codes.OS_FS_NOT_FOUND, 'missing_parent'],
]);

const REASON_BY_ERRNO: ReadonlyMap<unknown, DefaultWorkspaceUnavailableReason> = new Map([
  ['ENOSPC', 'no_space'],
  ['EDQUOT', 'no_space'],
  ['EROFS', 'read_only'],
  ['ENAMETOOLONG', 'invalid_path'],
]);

function reasonOf(error: unknown): DefaultWorkspaceUnavailableReason {
  if (error instanceof DefaultWorkspaceUnavailableError) return error.details.reason;
  if (!(error instanceof HostFsError)) return 'unknown';
  return (
    REASON_BY_FS_CODE.get(error.code) ??
    REASON_BY_ERRNO.get(error.details?.['errno']) ??
    'unknown'
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof HostFsError && error.code === OsFsErrors.codes.OS_FS_NOT_FOUND;
}

async function collect(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of stream) {
    out += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  }
  out += decoder.decode();
  return out;
}

registerScopedService(
  LifecycleScope.App,
  IDefaultWorkspace,
  DefaultWorkspaceService,
  ScopeActivation.OnDemand,
  'defaultWorkspace',
);
