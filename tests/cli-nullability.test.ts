// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { EventEmitter } from 'events';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const {
  createReadStreamMock,
  createTarExtractorMock,
  createEntryItemGeneratorMock,
  createTarPackerMock,
  extractToMock,
  getFetchGitMetadataMock,
  resolveRawPackageJsonObjectMock,
  spawnMock,
  storeReaderToFileMock,
} = vi.hoisted(() => ({
  createReadStreamMock: vi.fn(),
  createTarExtractorMock: vi.fn(),
  createEntryItemGeneratorMock: vi.fn(),
  createTarPackerMock: vi.fn(),
  extractToMock: vi.fn(),
  getFetchGitMetadataMock: vi.fn(),
  resolveRawPackageJsonObjectMock: vi.fn(),
  spawnMock: vi.fn(),
  storeReaderToFileMock: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    createReadStream: createReadStreamMock,
  };
});

vi.mock('tar-vern', async () => {
  const actual = await vi.importActual<typeof import('tar-vern')>('tar-vern');
  return {
    ...actual,
    createTarExtractor: createTarExtractorMock,
    createEntryItemGenerator: createEntryItemGeneratorMock,
    createTarPacker: createTarPackerMock,
    extractTo: extractToMock,
    storeReaderToFile: storeReaderToFileMock,
  };
});

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

const createMockSpawnProcess = (
  stdoutChunks: string[] = [],
  stderrChunks: string[] = [],
  exitCode: number | null = 0,
  signal: NodeJS.Signals | null = null
) => {
  const childProcess = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  childProcess.stdout = new EventEmitter();
  childProcess.stderr = new EventEmitter();

  setTimeout(() => {
    for (const chunk of stdoutChunks) {
      childProcess.stdout.emit('data', chunk);
    }
    for (const chunk of stderrChunks) {
      childProcess.stderr.emit('data', chunk);
    }
    childProcess.emit('close', exitCode, signal);
  }, 0);

  return childProcess;
};

const setupPackAssetsTarget = (targetDir: string, outputDir: string) => {
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    join(targetDir, 'package.json'),
    JSON.stringify({ name: 'test-package', version: '1.0.0' }, null, 2)
  );

  resolveRawPackageJsonObjectMock.mockResolvedValue({
    metadata: {
      name: 'test-package',
      version: '1.0.0',
    },
    sourceMap: new Map<string, string>(),
  });
};

const mockPackSpawn = (
  tarballNames: string[],
  stdoutChunks: string[] = [],
  stderrChunks: string[] = [],
  exitCode: number | null = 0,
  signal: NodeJS.Signals | null = null
) => {
  spawnMock.mockImplementation((_command, args: string[]) => {
    const packDestDir = args[args.length - 1];
    for (const tarballName of tarballNames) {
      writeFileSync(join(packDestDir, tarballName), 'dummy tarball');
    }
    return createMockSpawnProcess(stdoutChunks, stderrChunks, exitCode, signal);
  });
};

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
    createReadStreamMock.mockReset();
    createTarExtractorMock.mockReset();
    createEntryItemGeneratorMock.mockReset();
    createTarPackerMock.mockReset();
    extractToMock.mockReset();
    storeReaderToFileMock.mockReset();

    getFetchGitMetadataMock.mockReturnValue(async () => ({}));
    createReadStreamMock.mockReturnValue(new EventEmitter() as any);
    createTarExtractorMock.mockReturnValue({} as any);
    createEntryItemGeneratorMock.mockReturnValue((async function* () {})());
    createTarPackerMock.mockReturnValue({} as any);
    extractToMock.mockResolvedValue(undefined);
    storeReaderToFileMock.mockResolvedValue(undefined);
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

  it('should use the sole generated tarball instead of stdout filename logs', async () => {
    const targetDir = join(tempDir, 'source');
    const outputDir = join(tempDir, 'output');
    setupPackAssetsTarget(targetDir, outputDir);

    mockPackSpawn(
      ['test-package-1.0.0.tgz'],
      [
        '> test-package@1.0.0 prepack C:\\temp\\source\n',
        '{"filename":"fake-from-script.tgz"}\n',
        '{\n',
        '  "name": "test-package",\n',
        '  "version": "1.0.0",\n',
        '  "filename": "test-package-1.0.0.tgz"\n',
        '}\n',
      ]
    );

    const result = await packAssets(
      targetDir,
      outputDir,
      true,
      true,
      new Set(['version']),
      undefined,
      true,
      '^',
      createConsoleLogger(),
      true,
      'pnpm'
    );

    expect(result).toMatchObject({
      packageFileName: 'test-package-1.0.0.tgz',
      metadata: {
        name: 'test-package',
        version: '1.0.0',
      },
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0];
    expect(command).toBe('pnpm');
    expect(args).toEqual([
      '--reporter=ndjson',
      'pack',
      '--json',
      '--pack-destination',
      expect.any(String),
    ]);
    const packDestDir = args[args.length - 1];
    expect(options).toMatchObject({
      cwd: targetDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(createReadStreamMock).toHaveBeenCalledWith(
      join(packDestDir, 'test-package-1.0.0.tgz')
    );
    expect(storeReaderToFileMock).toHaveBeenCalledTimes(1);
  });

  it('should fail when pack destination does not contain a tarball', async () => {
    const targetDir = join(tempDir, 'source');
    const outputDir = join(tempDir, 'output');
    setupPackAssetsTarget(targetDir, outputDir);

    mockPackSpawn([], ['{"filename":"missing-from-stdout.tgz"}\n']);

    await expect(
      packAssets(
        targetDir,
        outputDir,
        true,
        true,
        new Set(['version']),
        undefined,
        true,
        '^',
        createConsoleLogger(),
        true,
        'pnpm'
      )
    ).rejects.toThrow(/did not produce a \.tgz file/);

    expect(createReadStreamMock).not.toHaveBeenCalled();
    expect(storeReaderToFileMock).not.toHaveBeenCalled();
  });

  it('should fail when pack destination contains multiple tarballs', async () => {
    const targetDir = join(tempDir, 'source');
    const outputDir = join(tempDir, 'output');
    setupPackAssetsTarget(targetDir, outputDir);

    mockPackSpawn(
      ['first-package.tgz', 'second-package.tgz'],
      ['{"filename":"test-package-1.0.0.tgz"}\n']
    );

    await expect(
      packAssets(
        targetDir,
        outputDir,
        true,
        true,
        new Set(['version']),
        undefined,
        true,
        '^',
        createConsoleLogger(),
        true,
        'pnpm'
      )
    ).rejects.toThrow(/produced multiple \.tgz files/);

    expect(createReadStreamMock).not.toHaveBeenCalled();
    expect(storeReaderToFileMock).not.toHaveBeenCalled();
  });

  it('should treat npm publish termination without an exit code as failure', async () => {
    const tarballPath = join(tempDir, 'package.tgz');
    writeFileSync(tarballPath, 'dummy tarball');

    spawnMock.mockImplementation(() =>
      createMockSpawnProcess([], [], null, 'SIGTERM')
    );

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
