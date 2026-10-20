import { writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_KIMI_CODE_OAUTH_HOST } from '#/constants';
import { KIMI_CODE_OAUTH_KEY } from '#/managed-kimi-code';
import { DEFAULT_KIMI_CODE_BASE_URL } from '#/managed-usage';
import {
  ensureKimiRegionMarker,
  KIMI_REGION_JUDGMENT_FILENAME,
  KIMI_REGION_MARKER_FILENAME,
  KIMI_REGION_PROFILES,
  kimiRegionLoginHosts,
  kimiRegionProfile,
  kimiRegionSchema,
  resolveKimiRegion,
  resolveKimiRegionDetailed,
  resolveKimiRemoteControlAuth,
} from '#/region';
import { detectKimiRegionFromLocalSignals } from '#/region-local';

import { createTempWorkDir, type TempDirHandle } from './helpers';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    linkSync: vi.fn(actual.linkSync),
    readFileSync: vi.fn(actual.readFileSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

const linkSyncMock = vi.mocked(linkSync);
const readFileSyncMock = vi.mocked(readFileSync);
const unlinkSyncMock = vi.mocked(unlinkSync);
const writeFileSyncMock = vi.mocked(writeFileSync);

describe('KIMI_REGION_PROFILES', () => {
  it('keeps the mainland-cn profile aligned with the shared defaults', () => {
    expect(KIMI_REGION_PROFILES['mainland-cn'].oauthHost).toBe(DEFAULT_KIMI_CODE_OAUTH_HOST);
    expect(KIMI_REGION_PROFILES['mainland-cn'].baseUrl).toBe(DEFAULT_KIMI_CODE_BASE_URL);
    expect(KIMI_REGION_PROFILES['mainland-cn'].relayOrigin).toBe('https://code-rc.kimi.com');
  });

  it('kimiRegionProfile returns the requested profile', () => {
    expect(kimiRegionProfile('global').oauthHost).toBe('https://auth.kimi.ai');
    expect(kimiRegionProfile('global').relayOrigin).toBe('https://code-rc.kimi.ai');
    expect(kimiRegionProfile('global').telemetryEndpoint).toBeUndefined();
    expect(kimiRegionProfile('mainland-cn').telemetryEndpoint).toBe(
      'https://telemetry-logs.kimi.com/v1/event',
    );
    expect(kimiRegionProfile('mainland-cn')).toBe(KIMI_REGION_PROFILES['mainland-cn']);
  });
});

describe('resolveKimiRegion', () => {
  let workDir: TempDirHandle | undefined;

  afterEach(async () => {
    await workDir?.cleanup();
    workDir = undefined;
  });

  async function markerDir(contents?: string): Promise<string> {
    workDir = await createTempWorkDir();
    if (contents !== undefined) {
      await writeFile(join(workDir.path, KIMI_REGION_MARKER_FILENAME), contents, 'utf-8');
    }
    return workDir.path;
  }

  it('defaults to mainland-cn when nothing points anywhere', async () => {
    expect(resolveKimiRegion({ env: {}, homeDir: await markerDir() })).toBe('mainland-cn');
  });

  it('resolves a known env oauth host, KIMI_CODE_OAUTH_HOST first', () => {
    expect(resolveKimiRegion({ env: { KIMI_CODE_OAUTH_HOST: 'https://auth.kimi.ai' } })).toBe(
      'global',
    );
    expect(resolveKimiRegion({ env: { KIMI_OAUTH_HOST: 'https://auth.kimi.ai' } })).toBe(
      'global',
    );
    expect(
      resolveKimiRegion({
        env: {
          KIMI_CODE_OAUTH_HOST: 'https://auth.kimi.com',
          KIMI_OAUTH_HOST: 'https://auth.kimi.ai',
        },
      }),
    ).toBe('mainland-cn');
  });

  it('treats an unknown env host as a custom environment and falls back to cn', async () => {
    // ...even when the persisted login or marker says otherwise: the custom
    // env overrides every endpoint anyway.
    expect(
      resolveKimiRegion({
        env: { KIMI_CODE_OAUTH_HOST: 'https://auth.internal.example.com' },
        configuredOAuthHost: 'https://auth.kimi.ai',
        homeDir: await markerDir('global\n'),
      }),
    ).toBe('mainland-cn');
  });

  it('resolves the persisted login host, tolerating trailing slashes', () => {
    expect(resolveKimiRegion({ env: {}, configuredOAuthHost: 'https://auth.kimi.ai/' })).toBe(
      'global',
    );
    expect(resolveKimiRegion({ env: {}, configuredOAuthHost: 'https://auth.kimi.com' })).toBe('mainland-cn');
  });

  it('ignores an unrecognized persisted host and continues down the chain', async () => {
    expect(
      resolveKimiRegion({
        env: {},
        configuredOAuthHost: 'https://auth.legacy.example.com',
        homeDir: await markerDir('global'),
      }),
    ).toBe('global');
  });

  it('reads the install-channel marker when nothing else decides', async () => {
    expect(resolveKimiRegion({ env: {}, homeDir: await markerDir('global\n') })).toBe('global');
    expect(resolveKimiRegion({ env: {}, homeDir: await markerDir('  mainland-cn  ') })).toBe('mainland-cn');
  });

  it('ignores a malformed or missing marker', async () => {
    expect(resolveKimiRegion({ env: {}, homeDir: await markerDir('apac') })).toBe('mainland-cn');
    expect(resolveKimiRegion({ env: {}, homeDir: await markerDir('') })).toBe('mainland-cn');
  });

  it('skips the marker entirely when readMarker is false', async () => {
    expect(
      resolveKimiRegion({ env: {}, homeDir: await markerDir('global'), readMarker: false }),
    ).toBe('mainland-cn');
  });

  it('honors KIMI_CODE_HOME when homeDir is not passed explicitly', async () => {
    const dir = await markerDir('global');
    expect(resolveKimiRegion({ env: { KIMI_CODE_HOME: dir } })).toBe('global');
  });

  it('env beats persisted login beats marker', async () => {
    const dir = await markerDir('global');
    expect(
      resolveKimiRegion({
        env: { KIMI_CODE_OAUTH_HOST: 'https://auth.kimi.com' },
        configuredOAuthHost: 'https://auth.kimi.ai',
        homeDir: dir,
      }),
    ).toBe('mainland-cn');
    expect(
      resolveKimiRegion({
        env: {},
        configuredOAuthHost: 'https://auth.kimi.ai',
        homeDir: dir,
      }),
    ).toBe('global');
  });

  it('treats the persisted default-slot key as explicit mainland-cn, beating the marker', async () => {
    const dir = await markerDir('global');
    expect(
      resolveKimiRegion({ env: {}, configuredOAuthKey: KIMI_CODE_OAUTH_KEY, homeDir: dir }),
    ).toBe('mainland-cn');
  });

  it('still follows the marker when no key or host is persisted', async () => {
    expect(resolveKimiRegion({ env: {}, homeDir: await markerDir('global') })).toBe('global');
  });

  it('lets an unknown scoped key fall through to the marker', async () => {
    const dir = await markerDir('global');
    const key = 'oauth/kimi-code-env-0123456789abcdef';
    expect(
      resolveKimiRegion({
        env: {},
        configuredOAuthKey: key,
        homeDir: dir,
      }),
    ).toBe('global');
    expect(resolveKimiRemoteControlAuth({ env: {}, configuredOAuthKey: key, homeDir: dir })).toEqual({
      region: 'global',
      oauthKey: key,
      relayOrigin: 'https://code-rc.kimi.com',
    });
  });

  it('resolves a recognized persisted host before consulting the key', () => {
    expect(
      resolveKimiRegion({
        env: {},
        configuredOAuthHost: 'https://auth.kimi.ai',
        configuredOAuthKey: KIMI_CODE_OAUTH_KEY,
      }),
    ).toBe('global');
    expect(
      resolveKimiRemoteControlAuth({
        env: {},
        configuredOAuthHost: 'https://auth.kimi.ai',
        configuredOAuthKey: 'oauth/kimi-code-env-0123456789abcdef',
      }).relayOrigin,
    ).toBe('https://code-rc.kimi.ai');
  });
});

describe('kimiRegionLoginHosts', () => {
  it('returns both profile hosts, mainland-cn included (explicit beats stale config)', () => {
    expect(kimiRegionLoginHosts('mainland-cn', {})).toEqual({
      oauthHost: 'https://auth.kimi.com',
      baseUrl: 'https://api.kimi.com/coding/v1',
    });
    expect(kimiRegionLoginHosts('global', {})).toEqual({
      oauthHost: 'https://auth.kimi.ai',
      baseUrl: 'https://api.kimi.ai/coding/v1',
    });
  });

  it('yields to env overrides', () => {
    expect(kimiRegionLoginHosts('global', { KIMI_CODE_OAUTH_HOST: 'https://auth.x.com' })).toBe(
      undefined,
    );
    expect(kimiRegionLoginHosts('global', { KIMI_OAUTH_HOST: 'https://auth.x.com' })).toBe(
      undefined,
    );
    expect(
      kimiRegionLoginHosts('global', { KIMI_CODE_BASE_URL: 'https://api.x.com/coding/v1' }),
    ).toBe(undefined);
  });
});

describe('kimiRegionSchema', () => {
  it('parses valid regions and rejects others', () => {
    expect(kimiRegionSchema.parse('mainland-cn')).toBe('mainland-cn');
    expect(kimiRegionSchema.parse('global')).toBe('global');
    expect(kimiRegionSchema.safeParse('apac').success).toBe(false);
  });
});

describe('detectKimiRegionFromLocalSignals', () => {
  it('judges mainland from a CN time zone and a simplified-Chinese locale', () => {
    expect(
      detectKimiRegionFromLocalSignals({ timeZone: 'Asia/Shanghai', locale: 'zh-Hans-CN' }),
    ).toEqual({ region: 'mainland-cn', confident: true });
    expect(
      detectKimiRegionFromLocalSignals({ timeZone: 'Asia/Urumqi', locale: 'zh-CN' }),
    ).toEqual({ region: 'mainland-cn', confident: true });
  });

  it('judges mainland from a lone CN signal', () => {
    expect(detectKimiRegionFromLocalSignals({ timeZone: 'Asia/Shanghai' })).toEqual({
      region: 'mainland-cn',
      confident: true,
    });
    expect(detectKimiRegionFromLocalSignals({ locale: 'zh' })).toEqual({
      region: 'mainland-cn',
      confident: true,
    });
    expect(detectKimiRegionFromLocalSignals({ locale: 'zh-Hant-TW', timeZone: 'Asia/Shanghai' })).toEqual({
      region: 'mainland-cn',
      confident: false,
    });
  });

  it('judges global from a non-CN time zone without a contradicting locale', () => {
    expect(
      detectKimiRegionFromLocalSignals({ timeZone: 'America/New_York', locale: 'en-US' }),
    ).toEqual({ region: 'global', confident: true });
    expect(
      detectKimiRegionFromLocalSignals({ timeZone: 'Asia/Taipei', locale: 'zh-Hant-TW' }),
    ).toEqual({ region: 'global', confident: true });
    expect(detectKimiRegionFromLocalSignals({ timeZone: 'Asia/Hong_Kong' })).toEqual({
      region: 'global',
      confident: true,
    });
  });

  it('falls back to mainland when signals conflict', () => {
    expect(
      detectKimiRegionFromLocalSignals({ timeZone: 'Asia/Shanghai', locale: 'en-US' }),
    ).toEqual({ region: 'mainland-cn', confident: false });
    expect(
      detectKimiRegionFromLocalSignals({ timeZone: 'Europe/Berlin', locale: 'zh-Hans' }),
    ).toEqual({ region: 'mainland-cn', confident: false });
  });

  it('falls back to mainland when signals are missing or uninformative', () => {
    expect(detectKimiRegionFromLocalSignals({})).toEqual({
      region: 'mainland-cn',
      confident: false,
    });
    expect(detectKimiRegionFromLocalSignals({ timeZone: 'UTC', locale: 'en-US' })).toEqual({
      region: 'mainland-cn',
      confident: false,
    });
    expect(detectKimiRegionFromLocalSignals({ locale: 'en-US' })).toEqual({
      region: 'mainland-cn',
      confident: false,
    });
  });

  it('treats non-geographic time zones as abstentions, not as non-CN votes', () => {
    expect(detectKimiRegionFromLocalSignals({ timeZone: 'Etc/GMT-8', locale: 'en-US' })).toEqual({
      region: 'mainland-cn',
      confident: false,
    });
    expect(detectKimiRegionFromLocalSignals({ timeZone: 'Etc/Unknown', locale: 'en-US' })).toEqual({
      region: 'mainland-cn',
      confident: false,
    });
    expect(detectKimiRegionFromLocalSignals({ timeZone: '+08:00', locale: 'en-US' })).toEqual({
      region: 'mainland-cn',
      confident: false,
    });
    expect(detectKimiRegionFromLocalSignals({ timeZone: 'CST-8', locale: 'en-US' })).toEqual({
      region: 'mainland-cn',
      confident: false,
    });
    expect(detectKimiRegionFromLocalSignals({ timeZone: 'Etc/GMT-8', locale: 'zh-CN' })).toEqual({
      region: 'mainland-cn',
      confident: true,
    });
    expect(detectKimiRegionFromLocalSignals({ timeZone: 'CST6CDT', locale: 'en-US' })).toEqual({
      region: 'global',
      confident: true,
    });
  });
});

describe('resolveKimiRegionDetailed', () => {
  let workDir: TempDirHandle | undefined;

  afterEach(async () => {
    await workDir?.cleanup();
    workDir = undefined;
  });

  it('labels each resolution step with its source', async () => {
    workDir = await createTempWorkDir();
    await writeFile(join(workDir.path, KIMI_REGION_MARKER_FILENAME), 'global\n', 'utf-8');
    expect(
      resolveKimiRegionDetailed({ env: { KIMI_CODE_OAUTH_HOST: 'https://auth.kimi.ai' } }).source,
    ).toBe('env');
    expect(
      resolveKimiRegionDetailed({ env: {}, configuredOAuthHost: 'https://auth.kimi.ai' }).source,
    ).toBe('login');
    expect(
      resolveKimiRegionDetailed({ env: {}, configuredOAuthKey: KIMI_CODE_OAUTH_KEY }).source,
    ).toBe('login');
    expect(resolveKimiRegionDetailed({ env: {}, homeDir: workDir.path })).toEqual({
      region: 'global',
      source: 'marker',
    });
    await workDir.cleanup();
    workDir = await createTempWorkDir();
    expect(resolveKimiRegionDetailed({ env: {}, homeDir: workDir.path })).toEqual({
      region: 'mainland-cn',
      source: 'default',
    });
  });
});

describe('ensureKimiRegionMarker', () => {
  let workDir: TempDirHandle | undefined;

  afterEach(async () => {
    await workDir?.cleanup();
    workDir = undefined;
  });

  async function freshDir(): Promise<string> {
    workDir = await createTempWorkDir();
    return workDir.path;
  }

  it('writes a mainland marker from CN signals and serves it as marker afterwards', async () => {
    const dir = await freshDir();
    const signals = { timeZone: 'Asia/Shanghai', locale: 'zh-Hans-CN' };
    expect(ensureKimiRegionMarker({ env: {}, homeDir: dir, signals })).toEqual({
      region: 'mainland-cn',
      source: 'local-signals',
    });
    expect(readFileSync(join(dir, KIMI_REGION_MARKER_FILENAME), 'utf-8')).toBe('mainland-cn\n# local-signals\n');
    expect(
      ensureKimiRegionMarker({
        env: {},
        homeDir: dir,
        signals: { timeZone: 'America/New_York', locale: 'en-US' },
      }),
    ).toEqual({ region: 'mainland-cn', source: 'marker' });
    expect(resolveKimiRegion({ env: {}, homeDir: dir })).toBe('mainland-cn');
  });

  it('writes a global marker from non-CN signals', async () => {
    const dir = await freshDir();
    expect(
      ensureKimiRegionMarker({
        env: {},
        homeDir: dir,
        signals: { timeZone: 'America/New_York', locale: 'en-US' },
      }),
    ).toEqual({ region: 'global', source: 'local-signals' });
    expect(readFileSync(join(dir, KIMI_REGION_MARKER_FILENAME), 'utf-8')).toBe('global\n# local-signals\n');
  });

  it('marks a missing-signal judgment as fallback and still caches mainland', async () => {
    const dir = await freshDir();
    expect(ensureKimiRegionMarker({ env: {}, homeDir: dir, signals: {} })).toEqual({
      region: 'mainland-cn',
      source: 'fallback',
    });
    expect(readFileSync(join(dir, KIMI_REGION_MARKER_FILENAME), 'utf-8')).toBe('mainland-cn\n# fallback\n');
  });

  it('never overwrites an existing marker', async () => {
    workDir = await createTempWorkDir();
    await writeFile(join(workDir.path, KIMI_REGION_MARKER_FILENAME), 'global\n', 'utf-8');
    expect(
      ensureKimiRegionMarker({
        env: {},
        homeDir: workDir.path,
        signals: { timeZone: 'Asia/Shanghai', locale: 'zh-Hans-CN' },
      }),
    ).toEqual({ region: 'global', source: 'marker' });
    expect(readFileSync(join(workDir.path, KIMI_REGION_MARKER_FILENAME), 'utf-8')).toBe('global\n');
  });

  it('writes nothing when env or a persisted login decides the region', async () => {
    const dir = await freshDir();
    const signals = { timeZone: 'Asia/Shanghai', locale: 'zh-Hans-CN' };
    expect(
      ensureKimiRegionMarker({
        env: { KIMI_CODE_OAUTH_HOST: 'https://auth.kimi.ai' },
        homeDir: dir,
        signals,
      }).source,
    ).toBe('env');
    expect(
      ensureKimiRegionMarker({
        env: {},
        configuredOAuthHost: 'https://auth.kimi.ai',
        homeDir: dir,
        signals,
      }).source,
    ).toBe('login');
    expect(
      ensureKimiRegionMarker({
        env: {},
        configuredOAuthKey: KIMI_CODE_OAUTH_KEY,
        homeDir: dir,
        signals,
      }).source,
    ).toBe('login');
    expect(existsSync(join(dir, KIMI_REGION_MARKER_FILENAME))).toBe(false);
  });

  it('stays on the default and writes nothing when the marker is skipped', async () => {
    const dir = await freshDir();
    expect(
      ensureKimiRegionMarker({
        env: {},
        homeDir: dir,
        readMarker: false,
        signals: { timeZone: 'America/New_York', locale: 'en-US' },
      }),
    ).toEqual({ region: 'mainland-cn', source: 'default' });
    expect(existsSync(join(dir, KIMI_REGION_MARKER_FILENAME))).toBe(false);
  });

  it('never infers when any persisted login ref exists, even a scoped or unrecognized one', async () => {
    const dir = await freshDir();
    const signals = { timeZone: 'America/New_York', locale: 'en-US' };
    expect(
      ensureKimiRegionMarker({
        env: {},
        configuredOAuthKey: 'oauth/kimi-code-env-0123456789abcdef',
        homeDir: dir,
        signals,
      }),
    ).toEqual({ region: 'mainland-cn', source: 'default' });
    expect(
      ensureKimiRegionMarker({
        env: {},
        configuredOAuthHost: 'https://auth.legacy.example.com',
        homeDir: dir,
        signals,
      }),
    ).toEqual({ region: 'mainland-cn', source: 'default' });
    expect(existsSync(join(dir, KIMI_REGION_MARKER_FILENAME))).toBe(false);
  });

  it('ignores an inferred marker once a custom scoped login appears', async () => {
    const dir = await freshDir();
    expect(
      ensureKimiRegionMarker({
        env: {},
        homeDir: dir,
        signals: { timeZone: 'America/New_York', locale: 'en-US' },
      }),
    ).toEqual({ region: 'global', source: 'local-signals' });
    expect(
      resolveKimiRegionDetailed({
        env: {},
        configuredOAuthKey: 'oauth/kimi-code-env-0123456789abcdef',
        homeDir: dir,
      }),
    ).toEqual({ region: 'mainland-cn', source: 'default' });

    const installDir = join(dir, 'second');
    await mkdir(installDir, { recursive: true });
    await writeFile(join(installDir, KIMI_REGION_MARKER_FILENAME), 'global\n', 'utf-8');
    expect(
      resolveKimiRegionDetailed({
        env: {},
        configuredOAuthKey: 'oauth/kimi-code-env-0123456789abcdef',
        homeDir: installDir,
      }),
    ).toEqual({ region: 'global', source: 'marker' });
  });

  it('keeps the inferred verdict process-wide when the marker cannot be persisted', async () => {
    const dir = await freshDir();
    writeFileSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
    });
    const signals = { timeZone: 'America/New_York', locale: 'en-US' };
    expect(ensureKimiRegionMarker({ env: {}, homeDir: dir, signals })).toEqual({
      region: 'global',
      source: 'local-signals',
    });
    expect(existsSync(join(dir, KIMI_REGION_MARKER_FILENAME))).toBe(false);
    expect(resolveKimiRegionDetailed({ env: {}, homeDir: dir })).toEqual({
      region: 'global',
      source: 'local-signals',
    });
  });

  it('lets a later marker file outrank the in-memory inferred verdict', async () => {
    const dir = await freshDir();
    writeFileSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
    });
    ensureKimiRegionMarker({
      env: {},
      homeDir: dir,
      signals: { timeZone: 'Asia/Shanghai', locale: 'zh-Hans-CN' },
    });
    await writeFile(join(dir, KIMI_REGION_MARKER_FILENAME), 'global\n', 'utf-8');
    expect(resolveKimiRegionDetailed({ env: {}, homeDir: dir })).toEqual({
      region: 'global',
      source: 'marker',
    });
  });

  it('repairs a malformed existing marker with the fresh judgment', async () => {
    workDir = await createTempWorkDir();
    await writeFile(join(workDir.path, KIMI_REGION_MARKER_FILENAME), 'apac', 'utf-8');
    const dir = workDir.path;
    expect(
      ensureKimiRegionMarker({
        env: {},
        homeDir: dir,
        signals: { timeZone: 'America/New_York', locale: 'en-US' },
      }),
    ).toEqual({ region: 'global', source: 'local-signals' });
    expect(readFileSync(join(dir, KIMI_REGION_MARKER_FILENAME), 'utf-8')).toBe('global\n# local-signals\n');
    expect(resolveKimiRegionDetailed({ env: {}, homeDir: dir })).toEqual({
      region: 'global',
      source: 'marker',
    });
  });

  it('creates the home directory when persisting the first judgment', async () => {
    workDir = await createTempWorkDir();
    const dir = join(workDir.path, 'nested', 'kimi-home');
    expect(
      ensureKimiRegionMarker({
        env: {},
        homeDir: dir,
        signals: { timeZone: 'Asia/Shanghai', locale: 'zh-Hans-CN' },
      }),
    ).toEqual({ region: 'mainland-cn', source: 'local-signals' });
    expect(readFileSync(join(dir, KIMI_REGION_MARKER_FILENAME), 'utf-8')).toBe('mainland-cn\n# local-signals\n');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('yields the malformed-marker repair to the process holding the lock', async () => {
    workDir = await createTempWorkDir();
    const dir = workDir.path;
    await writeFile(join(dir, KIMI_REGION_MARKER_FILENAME), 'apac', 'utf-8');
    await writeFile(join(dir, `${KIMI_REGION_MARKER_FILENAME}.lock`), '999999\n', 'utf-8');
    const signals = { timeZone: 'America/New_York', locale: 'en-US' };
    expect(ensureKimiRegionMarker({ env: {}, homeDir: dir, signals, lockWaitMs: 0 })).toEqual({
      region: 'global',
      source: 'local-signals',
    });
    expect(readFileSync(join(dir, KIMI_REGION_MARKER_FILENAME), 'utf-8')).toBe('apac');
    await rm(join(dir, `${KIMI_REGION_MARKER_FILENAME}.lock`));
    expect(ensureKimiRegionMarker({ env: {}, homeDir: dir, signals, lockWaitMs: 0 })).toEqual({
      region: 'global',
      source: 'local-signals',
    });
    expect(readFileSync(join(dir, KIMI_REGION_MARKER_FILENAME), 'utf-8')).toBe('global\n# local-signals\n');
  });

  it('returns the winner without waiting when the locked marker is already valid', async () => {
    workDir = await createTempWorkDir();
    const dir = workDir.path;
    await writeFile(join(dir, KIMI_REGION_MARKER_FILENAME), 'global\n', 'utf-8');
    await writeFile(join(dir, `${KIMI_REGION_MARKER_FILENAME}.lock`), '999999\n', 'utf-8');
    expect(
      ensureKimiRegionMarker({
        env: {},
        homeDir: dir,
        signals: { timeZone: 'Asia/Shanghai', locale: 'zh-Hans-CN' },
      }),
    ).toEqual({ region: 'global', source: 'marker' });
  });

  it('recovers a stale repair lock instead of waiting it out', async () => {
    workDir = await createTempWorkDir();
    const dir = workDir.path;
    await writeFile(join(dir, KIMI_REGION_MARKER_FILENAME), 'apac', 'utf-8');
    const lockPath = join(dir, `${KIMI_REGION_MARKER_FILENAME}.lock`);
    await writeFile(lockPath, '999999\n', 'utf-8');
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lockPath, longAgo, longAgo);
    expect(
      ensureKimiRegionMarker({
        env: {},
        homeDir: dir,
        signals: { timeZone: 'America/New_York', locale: 'en-US' },
      }),
    ).toEqual({ region: 'global', source: 'local-signals' });
    expect(readFileSync(join(dir, KIMI_REGION_MARKER_FILENAME), 'utf-8')).toBe('global\n# local-signals\n');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('keeps the inferred verdict without waiting when the stale lock cannot be cleared', async () => {
    workDir = await createTempWorkDir();
    const dir = workDir.path;
    await writeFile(join(dir, KIMI_REGION_MARKER_FILENAME), 'apac', 'utf-8');
    const lockPath = join(dir, `${KIMI_REGION_MARKER_FILENAME}.lock`);
    mkdirSync(lockPath);
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lockPath, longAgo, longAgo);
    const signals = { timeZone: 'America/New_York', locale: 'en-US' };
    const startedAt = Date.now();
    expect(ensureKimiRegionMarker({ env: {}, homeDir: dir, signals })).toEqual({
      region: 'global',
      source: 'local-signals',
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(
      ensureKimiRegionMarker({ env: {}, homeDir: dir, signals }),
    ).toEqual({ region: 'global', source: 'local-signals' });
    expect(readFileSync(join(dir, KIMI_REGION_MARKER_FILENAME), 'utf-8')).toBe('apac');
  });

  it('yields to a verdict repaired by another process before the lock was acquired', async () => {
    workDir = await createTempWorkDir();
    const dir = workDir.path;
    await writeFile(join(dir, KIMI_REGION_MARKER_FILENAME), 'global\n', 'utf-8');
    readFileSyncMock
      .mockImplementationOnce(() => 'apac')
      .mockImplementationOnce(() => 'apac');
    expect(
      ensureKimiRegionMarker({
        env: {},
        homeDir: dir,
        signals: { timeZone: 'Asia/Shanghai', locale: 'zh-Hans-CN' },
      }),
    ).toEqual({ region: 'global', source: 'marker' });
    expect(readFileSync(join(dir, KIMI_REGION_MARKER_FILENAME), 'utf-8')).toBe('global\n');
  });

  it('falls back to an exclusive create on filesystems without hard links', async () => {
    const dir = await freshDir();
    linkSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOTSUP: operation not supported'), { code: 'ENOTSUP' });
    });
    const signals = { timeZone: 'America/New_York', locale: 'en-US' };
    expect(ensureKimiRegionMarker({ env: {}, homeDir: dir, signals })).toEqual({
      region: 'global',
      source: 'local-signals',
    });
    expect(readFileSync(join(dir, KIMI_REGION_MARKER_FILENAME), 'utf-8')).toBe('global\n# local-signals\n');
  });

  it('keeps the marker and writes the sidecar when temp cleanup fails after linking', async () => {
    const dir = await freshDir();
    unlinkSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    expect(
      ensureKimiRegionMarker({
        env: {},
        homeDir: dir,
        signals: { timeZone: 'America/New_York', locale: 'en-US' },
      }),
    ).toEqual({ region: 'global', source: 'local-signals' });
    expect(readFileSync(join(dir, KIMI_REGION_MARKER_FILENAME), 'utf-8')).toBe('global\n# local-signals\n');
    const sidecar = JSON.parse(
      readFileSync(join(dir, KIMI_REGION_JUDGMENT_FILENAME), 'utf-8'),
    ) as { source?: string };
    expect(sidecar.source).toBe('local-signals');
  });

  it('records the judgment provenance in a region.json sidecar', async () => {
    const dir = await freshDir();
    expect(
      ensureKimiRegionMarker({
        env: {},
        homeDir: dir,
        signals: { timeZone: 'America/New_York', locale: 'en-US' },
      }),
    ).toEqual({ region: 'global', source: 'local-signals' });
    const sidecar = JSON.parse(
      readFileSync(join(dir, KIMI_REGION_JUDGMENT_FILENAME), 'utf-8'),
    ) as { region?: string; source?: string; detectedAt?: string };
    expect(sidecar.region).toBe('global');
    expect(sidecar.source).toBe('local-signals');
    expect(typeof sidecar.detectedAt).toBe('string');

    const fallbackDir = join(dir, 'second');
    expect(ensureKimiRegionMarker({ env: {}, homeDir: fallbackDir, signals: {} })).toEqual({
      region: 'mainland-cn',
      source: 'fallback',
    });
    const fallbackSidecar = JSON.parse(
      readFileSync(join(fallbackDir, KIMI_REGION_JUDGMENT_FILENAME), 'utf-8'),
    ) as { region?: string; source?: string };
    expect(fallbackSidecar).toMatchObject({ region: 'mainland-cn', source: 'fallback' });
  });

  it('persists the marker with its provenance even when the measurement sidecar fails', async () => {
    const dir = await freshDir();
    mkdirSync(join(dir, KIMI_REGION_JUDGMENT_FILENAME));
    expect(
      ensureKimiRegionMarker({
        env: {},
        homeDir: dir,
        signals: { timeZone: 'America/New_York', locale: 'en-US' },
      }),
    ).toEqual({ region: 'global', source: 'local-signals' });
    expect(readFileSync(join(dir, KIMI_REGION_MARKER_FILENAME), 'utf-8')).toBe(
      'global\n# local-signals\n',
    );
  });

  it('parses an inferred marker with its provenance comment as its first-line region', async () => {
    const dir = await freshDir();
    await writeFile(join(dir, KIMI_REGION_MARKER_FILENAME), 'global\n# local-signals\n', 'utf-8');
    expect(resolveKimiRegion({ env: {}, homeDir: dir })).toBe('global');
  });

  it('never infers when only a base URL environment override is set', async () => {
    const dir = await freshDir();
    expect(
      ensureKimiRegionMarker({
        env: { KIMI_CODE_BASE_URL: 'https://api.example.com/coding/v1' },
        homeDir: dir,
        signals: { timeZone: 'America/New_York', locale: 'en-US' },
      }),
    ).toEqual({ region: 'mainland-cn', source: 'default' });
    expect(existsSync(join(dir, KIMI_REGION_MARKER_FILENAME))).toBe(false);
  });

  it('ignores a locally inferred marker when ignoreInferredMarker is set', async () => {
    const dir = await freshDir();
    expect(
      ensureKimiRegionMarker({
        env: {},
        homeDir: dir,
        signals: { timeZone: 'America/New_York', locale: 'en-US' },
      }),
    ).toEqual({ region: 'global', source: 'local-signals' });
    expect(
      resolveKimiRegionDetailed({ env: {}, homeDir: dir, ignoreInferredMarker: true }),
    ).toEqual({ region: 'mainland-cn', source: 'default' });
    expect(resolveKimiRegionDetailed({ env: {}, homeDir: dir })).toEqual({
      region: 'global',
      source: 'marker',
    });
  });
});
