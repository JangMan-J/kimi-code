import { describe, expect, it, vi } from 'vitest';

import type { IConfigService } from '#/app/config/config';
import { EnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclarationService';
import { Emitter } from '#/_base/event';
import type { EnvironmentsSection, EnvironmentDeclarationSet } from '#/environment/remoteEnvironmentDeclaration';

function fakeConfig(initial: EnvironmentsSection | undefined) {
  let section = initial;
  let failure: Error | undefined;
  const changes = new Emitter<{ domain: string }>();
  const config = {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    get: (domain: string) => {
      if (failure !== undefined) throw failure;
      return domain === 'environments' ? section : undefined;
    },
    onDidSectionChange: changes.event,
  } as unknown as IConfigService;
  return {
    config,
    set: (next: EnvironmentsSection | undefined) => {
      section = next;
      failure = undefined;
      changes.fire({ domain: 'environments' });
    },
    fail: (error: Error) => {
      failure = error;
      changes.fire({ domain: 'environments' });
    },
  };
}

const DEV = { type: 'ssh', host: 'dev.example.test', defaultCwd: '/remote/project' } as const;

describe('environment declarations', () => {
  it('resolves user [environments] entries and the configured default', async () => {
    const { config } = fakeConfig({ default: 'dev', dev: DEV } as unknown as EnvironmentsSection);
    const service = new EnvironmentDeclarationService(config, { warn: vi.fn() } as never);
    expect(await service.declarations()).toEqual({
      entries: [{ id: 'dev', entry: DEV }],
      default: { environmentId: 'dev', cwd: '/remote/project' },
    });
    service.dispose();
  });

  it('fires a change only when the declared catalog changes', async () => {
    const source = fakeConfig({ dev: DEV } as unknown as EnvironmentsSection);
    const service = new EnvironmentDeclarationService(source.config, { warn: vi.fn() } as never);
    const changed: EnvironmentDeclarationSet[] = [];
    service.onDidChange((event) => { changed.push(event); });
    await service.declarations();
    source.set({ dev: DEV } as unknown as EnvironmentsSection);
    await service.declarations();
    source.set({ dev: { ...DEV, host: 'new.example.test' } } as unknown as EnvironmentsSection);
    await service.declarations();
    expect(changed.map((event) => event.entries[0]?.entry)).toEqual([
      DEV,
      { ...DEV, host: 'new.example.test' },
    ]);
    service.dispose();
  });

  it('reports resolution failures as unresolved until the config resolves again', async () => {
    const warn = vi.fn();
    const source = fakeConfig({ dev: DEV } as unknown as EnvironmentsSection);
    const service = new EnvironmentDeclarationService(source.config, { warn } as never);
    await service.declarations();
    source.fail(new Error('broken config'));
    expect(await service.declarations()).toBeUndefined();
    source.set({ dev: DEV } as unknown as EnvironmentsSection);
    expect((await service.declarations())?.entries).toEqual([{ id: 'dev', entry: DEV }]);
    expect(warn).toHaveBeenCalledWith('remote environment declaration resolution failed', expect.anything());
    service.dispose();
  });

  it('keeps registration errors until the declaration goes away', async () => {
    const source = fakeConfig({ dev: DEV } as unknown as EnvironmentsSection);
    const service = new EnvironmentDeclarationService(source.config, { warn: vi.fn() } as never);
    await service.declarations();
    service.reportRegistration('dev', new Error('bad launcher'));
    expect(service.registrationError('dev')?.message).toContain('bad launcher');
    source.set(undefined);
    await service.declarations();
    expect(service.registrationError('dev')).toBeUndefined();
    service.dispose();
  });
});
