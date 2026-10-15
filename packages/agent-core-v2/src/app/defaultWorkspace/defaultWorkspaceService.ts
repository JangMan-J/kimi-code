import { join } from 'pathe';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { workspaceRootKey } from '#/_base/utils/workdir-slug';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import { ErrorCodes, Error2 } from '#/errors';
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

const WINDOWS_DOCUMENTS_TIMEOUT_MS = 15_000;

const BLOCKED_PATH_CODES: ReadonlySet<string> = new Set([
  OsFsErrors.codes.OS_FS_ALREADY_EXISTS,
  OsFsErrors.codes.OS_FS_NOT_DIRECTORY,
]);

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
      if (error instanceof HostFsError && BLOCKED_PATH_CODES.has(error.code)) {
        throw new Error2(
          ErrorCodes.FS_PATH_NOT_FOUND,
          `default workspace ${root} is not a usable directory`,
          { cause: error },
        );
      }
      throw error;
    }
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
      throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, 'cannot locate the Windows Documents folder', {
        cause,
      });
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
