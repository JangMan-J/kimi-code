import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveStartupWorkDir, resumeCommand } from '#/cli/startup-work-dir';

describe('resolveStartupWorkDir', () => {
  let launchDir: string;
  let target: string;

  beforeEach(async () => {
    launchDir = process.cwd();
    target = await realpath(await mkdtemp(join(tmpdir(), 'kimi-startup-work-dir-')));
  });

  afterEach(async () => {
    process.chdir(launchDir);
    await rm(target, { recursive: true, force: true });
  });

  it('keeps the launch directory without the flag', async () => {
    const ensure = vi.fn(async () => target);

    expect(await resolveStartupWorkDir({ defaultWorkspace: false }, ensure)).toBe(launchDir);
    expect(ensure).not.toHaveBeenCalled();
    expect(process.cwd()).toBe(launchDir);
  });

  it('moves into the default workspace with the flag', async () => {
    expect(await resolveStartupWorkDir({ defaultWorkspace: true }, async () => target)).toBe(
      target,
    );
    expect(process.cwd()).toBe(target);
  });

  it('stays put when the default workspace cannot be prepared', async () => {
    const failure = new Error('default workspace is unavailable: permission denied');

    await expect(
      resolveStartupWorkDir({ defaultWorkspace: true }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(process.cwd()).toBe(launchDir);
  });
});

describe('resumeCommand', () => {
  it('repeats the flag so the session resumes from any directory', () => {
    expect(resumeCommand({ defaultWorkspace: true }, 'ses_1')).toBe(
      'kimi --default-workspace -r ses_1',
    );
    expect(resumeCommand({}, 'ses_1')).toBe('kimi -r ses_1');
  });
});
