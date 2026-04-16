// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { simpleGit } from 'simple-git';
import { getFetchGitMetadata } from '../src/analyzer';
import { createConsoleLogger } from '../src/internal';
import { screwUp } from '../src/vite-plugin';

const execFileAsync = promisify(execFile);

interface WorktreeFixture {
  readonly rootPath: string;
  readonly repoPath: string;
  readonly worktreePath: string;
  readonly commitHash: string;
}

const createWorktreeFixture = async (): Promise<WorktreeFixture> => {
  const rootPath = await mkdtemp(join(tmpdir(), 'screw-up-worktree-test-'));
  const repoPath = join(rootPath, 'repo');
  const worktreePath = join(rootPath, 'worktree');

  await mkdir(join(repoPath, 'src'), { recursive: true });
  await writeFile(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        name: 'worktree-fixture',
        version: '0.0.1',
        description: 'Fixture for screw-up worktree tests',
        author: 'Test User',
        license: 'MIT',
      },
      null,
      2
    )
  );
  await writeFile(
    join(repoPath, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2020',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          declaration: true,
          outDir: './dist',
        },
        include: ['src'],
      },
      null,
      2
    )
  );
  await writeFile(
    join(repoPath, 'src', 'index.ts'),
    'export const fixture = "worktree";\n'
  );

  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');
  await git.checkoutLocalBranch('main');
  await git.add('.');
  await git.commit('Initial commit');
  const commitHash = (await git.revparse(['HEAD'])).trim();
  await git.tag(['v1.2.3']);

  await execFileAsync('git', ['worktree', 'add', worktreePath, 'HEAD'], {
    cwd: repoPath,
  });

  return {
    rootPath,
    repoPath,
    worktreePath,
    commitHash,
  };
};

const cleanupWorktreeFixture = async (
  fixture: WorktreeFixture
): Promise<void> => {
  await execFileAsync(
    'git',
    ['worktree', 'remove', fixture.worktreePath, '--force'],
    {
      cwd: fixture.repoPath,
    }
  ).catch(() => undefined);
  await rm(fixture.rootPath, { recursive: true, force: true });
};

describe('worktree support', () => {
  it('should resolve git metadata from a linked worktree', async () => {
    const fixture = await createWorktreeFixture();

    try {
      const logger = createConsoleLogger('test', 'ignore');
      const getGitMetadata = getFetchGitMetadata(
        fixture.worktreePath,
        true,
        logger
      );
      const metadata = await getGitMetadata();

      expect(metadata.git.commit.hash).toBe(fixture.commitHash);
      expect(metadata.git.tags).toEqual(['v1.2.3']);
      expect(metadata.git.branches).toContain('main');
      expect(metadata.git.version).toBe('1.2.3');
    } finally {
      await cleanupWorktreeFixture(fixture);
    }
  });

  it('should emit git_commit_hash into metadata source files from a linked worktree', async () => {
    const fixture = await createWorktreeFixture();

    try {
      await build({
        configFile: false,
        root: fixture.worktreePath,
        plugins: [
          screwUp({
            insertMetadataBanner: false,
            outputMetadataFile: true,
          }),
        ],
        build: {
          lib: {
            entry: join(fixture.worktreePath, 'src', 'index.ts'),
            name: 'WorktreeFixture',
            fileName: 'index',
            formats: ['es'],
          },
          outDir: join(fixture.worktreePath, 'dist'),
          minify: false,
        },
      });

      const metadataSource = await readFile(
        join(fixture.worktreePath, 'src', 'generated', 'packageMetadata.ts'),
        'utf-8'
      );

      expect(metadataSource).toContain(
        `export const git_commit_hash = "${fixture.commitHash}";`
      );
    } finally {
      await cleanupWorktreeFixture(fixture);
    }
  }, 30000);
});
