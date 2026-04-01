// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { EventEmitter } from 'events';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const { getFetchGitMetadataMock, resolveRawPackageJsonObjectMock, spawnMock } =
  vi.hoisted(() => ({
    getFetchGitMetadataMock: vi.fn(),
    resolveRawPackageJsonObjectMock: vi.fn(),
    spawnMock: vi.fn(),
  }));

vi.mock('../src/analyzer.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../src/analyzer.ts')>(
      '../src/analyzer.ts'
    );
  return {
    ...actual,
    getFetchGitMetadata: getFetchGitMetadataMock,
  };
});

vi.mock('../src/internal.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../src/internal.ts')>(
      '../src/internal.ts'
    );
  return {
    ...actual,
    resolveRawPackageJsonObject: resolveRawPackageJsonObjectMock,
  };
});

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import { packAssets } from '../src/cli-internal.ts';
import { cliMain } from '../src/cli.ts';
import { createConsoleLogger } from '../src/internal';

describe('CLI nullability regressions', () => {
  let tempDir: string;

  beforeEach((context) => {
    tempDir = join(
      tmpdir(),
      'screw-up',
      'cli-nullability-test',
      context.task.name
    );
    mkdirSync(tempDir, { recursive: true });

    getFetchGitMetadataMock.mockReset();
    resolveRawPackageJsonObjectMock.mockReset();
    spawnMock.mockReset();

    getFetchGitMetadataMock.mockReturnValue(async () => ({}));
  });

  it('should fail when package.json readme source directory is unknown', async () => {
    const targetDir = join(tempDir, 'source');
    const outputDir = join(tempDir, 'output');
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });

    resolveRawPackageJsonObjectMock.mockResolvedValue({
      metadata: {
        name: 'test-package',
        version: '1.0.0',
        readme: 'README_pack.md',
      },
      sourceMap: new Map<string, string>(),
    });

    await expect(
      packAssets(
        targetDir,
        outputDir,
        true,
        true,
        new Set(['readme']),
        undefined,
        true,
        '^',
        createConsoleLogger()
      )
    ).rejects.toThrow(
      'README replacement source directory is unknown: README_pack.md'
    );
  });

  it('should treat npm publish termination without an exit code as failure', async () => {
    const tarballPath = join(tempDir, 'package.tgz');
    writeFileSync(tarballPath, 'dummy tarball');

    spawnMock.mockImplementation(() => {
      const publishProcess = new EventEmitter();
      setTimeout(() => {
        publishProcess.emit('close', null, 'SIGTERM');
      }, 0);
      return publishProcess;
    });

    const errors: string[] = [];
    const logger = {
      debug: (_msg: string) => {},
      info: (_msg: string) => {},
      warn: (_msg: string) => {},
      error: (msg: string) => errors.push(msg),
    };

    const result = await cliMain(['publish', tarballPath], logger);
    const resolvedTarballPath = resolve(tarballPath);

    expect(spawnMock).toHaveBeenCalledWith(
      'npm',
      ['publish', resolvedTarballPath],
      {
        stdio: 'inherit',
      }
    );
    expect(result).toBe(1);
    expect(errors).toContain(
      `publish: npm publish terminated by signal SIGTERM: ${resolvedTarballPath}`
    );
  }, 10000);
});
