import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ProjectAdditionalDirsLoadResult {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly additionalDirs: readonly string[];
}

export interface IProjectLocalConfigService {
  readonly _serviceBrand: undefined;

  readAdditionalDirs(workDir: string): Promise<ProjectAdditionalDirsLoadResult>;
  resolveAdditionalDirs(baseDir: string, additionalDirs: readonly string[]): Promise<string[]>;
  removeAdditionalDirs(workDir: string, dirs: readonly string[]): Promise<void>;
}

export const IProjectLocalConfigService: ServiceIdentifier<IProjectLocalConfigService> =
  createDecorator<IProjectLocalConfigService>('projectLocalConfigService');
