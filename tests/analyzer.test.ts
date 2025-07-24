import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { simpleGit } from 'simple-git';
import { getGitMetadata } from '../src/analyzer.js';

// Test utilities for creating temporary git repositories
class GitTestRepository {
  public readonly path: string;
  private git: any;

  constructor(path: string) {
    this.path = path;
    this.git = simpleGit(path);
  }

  async init(): Promise<void> {
    await this.git.init();
    await this.git.addConfig('user.name', 'Test User');
    await this.git.addConfig('user.email', 'test@example.com');
  }

  async createFile(filename: string, content: string): Promise<void> {
    const fs = await import('fs/promises');
    await fs.writeFile(join(this.path, filename), content);
  }

  async commit(message: string, files: string[] = ['.']): Promise<string> {
    await this.git.add(files);
    const result = await this.git.commit(message);
    return result.commit;
  }

  async createTag(tagName: string, commitHash?: string): Promise<void> {
    if (commitHash) {
      await this.git.tag([tagName, commitHash]);
    } else {
      await this.git.tag([tagName]);
    }
  }

  async createBranch(branchName: string, startPoint?: string): Promise<void> {
    if (startPoint) {
      await this.git.checkoutBranch(branchName, startPoint);
    } else {
      await this.git.checkoutLocalBranch(branchName);
    }
  }

  async checkout(ref: string): Promise<void> {
    await this.git.checkout(ref);
  }

  async getCurrentCommitHash(): Promise<string> {
    const log = await this.git.log({ maxCount: 1 });
    return log.latest?.hash || '';
  }

  async getCommit(hash: string): Promise<any> {
    const log = await this.git.show([hash, '--format=%H%n%h%n%ci%n%s%n%P', '-s']);
    const lines = log.trim().split('\n');
    
    if (lines.length < 4) return null;
    
    return {
      hash: lines[0],
      shortHash: lines[1],
      date: lines[2],
      message: lines[3],
      parents: lines[4] ? lines[4].split(' ').filter((p: string) => p.length > 0) : []
    };
  }
}

// Helper function to create a temporary test repository
async function createTestRepository(): Promise<GitTestRepository> {
  const tempDir = await mkdtemp(join(tmpdir(), 'git-metadata-test-'));
  const repo = new GitTestRepository(tempDir);
  await repo.init();
  return repo;
}

// Helper function to cleanup test repository
async function cleanupTestRepository(repo: GitTestRepository): Promise<void> {
  await rm(repo.path, { recursive: true, force: true });
}

describe('git-metadata', () => {
  let testRepo: GitTestRepository;

  beforeEach(async () => {
    testRepo = await createTestRepository();
  });

  afterEach(async () => {
    if (testRepo) {
      await cleanupTestRepository(testRepo);
    }
  });

  describe('lookupVersionLabelRecursive behavior', () => {
    it('should find tag immediately on current commit', async () => {
      // Setup: Create a commit with a tag
      await testRepo.createFile('README.md', '# Test Project');
      const commitHash = await testRepo.commit('Initial commit');
      await testRepo.createTag('v1.2.3');

      // Test: Extract git metadata
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should find the tag immediately
      expect(metadata.git.version).toBe('1.2.3');
      expect(metadata.git.tags).toEqual(['v1.2.3']);
      expect(metadata.git.commit.hash).toBe(commitHash);
    });

    it('should find tag in parent commit (depth 1)', async () => {
      // Setup: Create initial commit with tag
      await testRepo.createFile('README.md', '# Test Project');
      const taggedCommit = await testRepo.commit('Initial commit');
      await testRepo.createTag('v1.0.0');

      // Create another commit without tag
      await testRepo.createFile('file.txt', 'content');
      const currentCommit = await testRepo.commit('Add file');

      // Test: Extract git metadata
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should find parent tag and increment it
      expect(metadata.git.version).toBe('1.0.1'); // Should increment build version
      expect(metadata.git.tags).toEqual([]); // No tag on current commit
      expect(metadata.git.commit.hash).toBe(currentCommit);
    });

    it('should find tag in grandparent commit (depth 2)', async () => {
      // Setup: Create initial commit with tag
      await testRepo.createFile('README.md', '# Test Project');
      await testRepo.commit('Initial commit');
      await testRepo.createTag('v2.1.0');

      // Create intermediate commit
      await testRepo.createFile('file1.txt', 'content1');
      await testRepo.commit('Add file1');

      // Create current commit
      await testRepo.createFile('file2.txt', 'content2');
      const currentCommit = await testRepo.commit('Add file2');

      // Test: Extract git metadata
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should find grandparent tag and increment it appropriately
      expect(metadata.git.version).toBe('2.1.2'); // Should increment build version for each commit
      expect(metadata.git.commit.hash).toBe(currentCommit);
    });

    it('should handle multiple tags on same commit', async () => {
      // Setup: Create commit with multiple tags
      await testRepo.createFile('README.md', '# Test Project');
      const commitHash = await testRepo.commit('Initial commit');
      
      // Add multiple version tags (should pick highest)
      await testRepo.createTag('v1.0.0');
      await testRepo.createTag('v1.2.0');
      await testRepo.createTag('v1.1.5');

      // Test: Extract git metadata
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should pick the highest version
      expect(metadata.git.version).toBe('1.2.0');
      expect(metadata.git.tags).toEqual(['v1.0.0', 'v1.1.5', 'v1.2.0']);
    });

    it('should ignore non-version tags', async () => {
      // Setup: Create commit with mixed tags
      await testRepo.createFile('README.md', '# Test Project');
      const commitHash = await testRepo.commit('Initial commit');
      
      // Add non-version tags and one version tag
      await testRepo.createTag('release');
      await testRepo.createTag('stable');
      await testRepo.createTag('v1.5.2');
      await testRepo.createTag('feature-branch');

      // Test: Extract git metadata
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should only consider version tags
      expect(metadata.git.version).toBe('1.5.2');
      expect(metadata.git.tags).toEqual(['feature-branch', 'release', 'stable', 'v1.5.2']);
    });

    it('should handle merge commits with tags on both branches', async () => {
      // Setup: Create main branch with tag
      await testRepo.createFile('README.md', '# Test Project');
      const mainCommit = await testRepo.commit('Initial commit');
      await testRepo.createTag('v1.0.0');

      // Create feature branch with different tag
      await testRepo.createBranch('feature');
      await testRepo.createFile('feature.txt', 'feature content');
      const featureCommit = await testRepo.commit('Add feature');
      await testRepo.createTag('v0.9.0');

      // Switch back to main and merge
      await testRepo.checkout('main');
      await testRepo.git.merge(['feature', '--no-ff', '-m', 'Merge feature branch']);

      // Test: Extract git metadata
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should pick the higher version from either branch
      expect(metadata.git.version).toBe('1.0.1'); // Should increment from v1.0.0 (higher than v0.9.0)
    });

    it('should handle branch without any tags', async () => {
      // Setup: Create commits without any tags
      await testRepo.createFile('README.md', '# Test Project');
      await testRepo.commit('Initial commit');
      
      await testRepo.createFile('file.txt', 'content');
      const currentCommit = await testRepo.commit('Add file');

      // Test: Extract git metadata
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should use default version and increment for second commit
      expect(metadata.git.version).toBe('0.0.2');
      expect(metadata.git.tags).toEqual([]);
      expect(metadata.git.commit.hash).toBe(currentCommit);
    });

    it('should handle complex version increment scenarios', async () => {
      // Setup: Create commit with revision version
      await testRepo.createFile('README.md', '# Test Project');
      await testRepo.commit('Initial commit');
      await testRepo.createTag('v1.2.3.4'); // Has revision component

      // Create another commit
      await testRepo.createFile('file.txt', 'content');
      const currentCommit = await testRepo.commit('Add file');

      // Test: Extract git metadata
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should increment revision (last component)
      expect(metadata.git.version).toBe('1.2.3.5');
      expect(metadata.git.commit.hash).toBe(currentCommit);
    });

    it('should handle version increment priority (revision > build > minor)', async () => {
      // Test different version formats and their increment behavior
      // RelaxVersioner requires at least 2 components (major.minor)
      const testCases = [
        { tag: 'v1.2.0.0', expected: '1.2.0.1' }, // increment revision
        { tag: 'v1.2.3', expected: '1.2.4' },     // increment build  
        { tag: 'v1.2', expected: '1.3' },         // increment minor
      ];

      for (const testCase of testCases) {
        // Create fresh test repo for each case
        const tempRepo = await createTestRepository();
        
        try {
          await tempRepo.createFile('README.md', '# Test Project');
          await tempRepo.commit('Initial commit');
          await tempRepo.createTag(testCase.tag);

          await tempRepo.createFile('file.txt', 'content');
          await tempRepo.commit('Add file');

          const metadata = await getGitMetadata(tempRepo.path, true);
          expect(metadata.git.version).toBe(testCase.expected);
        } finally {
          await cleanupTestRepository(tempRepo);
        }
      }
    });
  });

  describe('complex branch and merge scenarios', () => {
    it('should handle merge with different depth tags on both branches', async () => {
      // Setup: Create main branch with deep tag history
      await testRepo.createFile('README.md', '# Test Project');
      await testRepo.commit('Initial commit');
      await testRepo.createTag('v1.0.0');

      // Add commits on main to create depth
      await testRepo.createFile('main1.txt', 'main content 1');
      await testRepo.commit('Main commit 1');
      await testRepo.createFile('main2.txt', 'main content 2');
      await testRepo.commit('Main commit 2');

      // Create feature branch from earlier commit
      await testRepo.checkout('HEAD~1'); // Go back 1 commit
      await testRepo.createBranch('feature');
      await testRepo.createFile('feature1.txt', 'feature content 1');
      await testRepo.commit('Feature commit 1');
      await testRepo.createTag('v2.0.0'); // Higher version on feature branch
      await testRepo.createFile('feature2.txt', 'feature content 2');
      await testRepo.commit('Feature commit 2');

      // Switch back to main and merge
      await testRepo.checkout('main');
      await testRepo.git.merge(['feature', '--no-ff', '-m', 'Merge feature branch']);

      // Test: Extract git metadata
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should pick the higher version from feature branch and increment
      // One increment for feature commit after tag, one for merge commit
      expect(metadata.git.version).toBe('2.0.2');
    });

    it('should handle merge where neither branch has tags', async () => {
      // Setup: Create main branch without tags
      await testRepo.createFile('README.md', '# Test Project');
      await testRepo.commit('Initial commit');

      await testRepo.createFile('main.txt', 'main content');
      await testRepo.commit('Main commit');

      // Create feature branch
      await testRepo.createBranch('feature');
      await testRepo.createFile('feature.txt', 'feature content');
      await testRepo.commit('Feature commit');

      // Switch back to main and merge
      await testRepo.checkout('main');
      await testRepo.git.merge(['feature', '--no-ff', '-m', 'Merge feature branch']);

      // Test: Extract git metadata
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should use default version and increment appropriately
      // Increments: initial->main commit->feature commit->merge commit = 4 total commits from default
      expect(metadata.git.version).toBe('0.0.4');
    });

    it('should handle multiple level branch merges with tags at different depths', async () => {
      // Setup: Create complex branch structure
      // main: v1.0.0 -> commit1 -> commit2 -> merge(dev) -> merge(feature)
      // dev: branch from main -> v1.1.0 -> commit3 -> commit4
      // feature: branch from dev -> commit5 -> v2.0.0 -> commit6

      await testRepo.createFile('README.md', '# Test Project');
      await testRepo.commit('Initial commit');
      await testRepo.createTag('v1.0.0');

      await testRepo.createFile('main1.txt', 'main content 1');
      await testRepo.commit('Main commit 1');
      await testRepo.createFile('main2.txt', 'main content 2');
      await testRepo.commit('Main commit 2');

      // Create dev branch
      await testRepo.createBranch('dev');
      await testRepo.createTag('v1.1.0');
      await testRepo.createFile('dev1.txt', 'dev content 1');
      await testRepo.commit('Dev commit 1');
      await testRepo.createFile('dev2.txt', 'dev content 2');
      await testRepo.commit('Dev commit 2');

      // Create feature branch from dev
      await testRepo.createBranch('feature');
      await testRepo.createFile('feature1.txt', 'feature content 1');
      await testRepo.commit('Feature commit 1');
      await testRepo.createTag('v2.0.0'); // Highest version
      await testRepo.createFile('feature2.txt', 'feature content 2');
      await testRepo.commit('Feature commit 2');

      // Merge feature back to dev
      await testRepo.checkout('dev');
      await testRepo.git.merge(['feature', '--no-ff', '-m', 'Merge feature to dev']);

      // Merge dev back to main
      await testRepo.checkout('main');
      await testRepo.git.merge(['dev', '--no-ff', '-m', 'Merge dev to main']);

      // Test: Extract git metadata
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should find highest version (v2.0.0) and increment appropriately
      // feature commit after v2.0.0 + merge to dev + merge to main = 3 increments
      expect(metadata.git.version).toBe('2.0.3');
    });

    it('should handle same version tags on different branches', async () => {
      // Setup: Create branches with same version tags
      await testRepo.createFile('README.md', '# Test Project');
      await testRepo.commit('Initial commit');

      // Create main branch tag
      await testRepo.createFile('main.txt', 'main content');
      await testRepo.commit('Main commit');
      await testRepo.createTag('v1.5.0');

      // Create feature branch with different version tag
      await testRepo.createBranch('feature');
      await testRepo.createFile('feature.txt', 'feature content');
      await testRepo.commit('Feature commit');
      await testRepo.createTag('v1.4.0'); // Different version from main

      // Switch back to main and merge
      await testRepo.checkout('main');
      await testRepo.git.merge(['feature', '--no-ff', '-m', 'Merge feature branch']);

      // Test: Extract git metadata
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should pick higher version (main v1.5.0) and increment
      expect(metadata.git.version).toBe('1.5.1');
    });

    it('should handle mixed version formats across branches', async () => {
      // Setup: Create branches with different version formats
      await testRepo.createFile('README.md', '# Test Project');
      await testRepo.commit('Initial commit');
      await testRepo.createTag('v1.0'); // 2-component version

      // Create feature branch with different format
      await testRepo.createBranch('feature');
      await testRepo.createFile('feature.txt', 'feature content');
      await testRepo.commit('Feature commit');
      await testRepo.createTag('v1.2.3.4'); // 4-component version (higher)

      // Switch back to main and merge
      await testRepo.checkout('main');
      await testRepo.git.merge(['feature', '--no-ff', '-m', 'Merge feature branch']);

      // Test: Extract git metadata
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should pick higher version and increment last component
      expect(metadata.git.version).toBe('1.2.3.5');
    });

    it('should handle feature branch merged after main progression', async () => {
      // Setup: Complex scenario where feature branch is based on old main
      await testRepo.createFile('README.md', '# Test Project');
      await testRepo.commit('Initial commit');
      await testRepo.createTag('v1.0.0');

      // Create feature branch early
      await testRepo.createBranch('feature');

      // Progress main branch
      await testRepo.checkout('main');
      await testRepo.createFile('main1.txt', 'main content 1');
      await testRepo.commit('Main commit 1');
      await testRepo.createTag('v1.1.0');
      await testRepo.createFile('main2.txt', 'main content 2');
      await testRepo.commit('Main commit 2');

      // Work on feature branch (based on v1.0.0)
      await testRepo.checkout('feature');
      await testRepo.createFile('feature1.txt', 'feature content 1');
      await testRepo.commit('Feature commit 1');
      await testRepo.createTag('v2.0.0'); // Higher version
      await testRepo.createFile('feature2.txt', 'feature content 2');
      await testRepo.commit('Feature commit 2');

      // Merge feature to main
      await testRepo.checkout('main');
      await testRepo.git.merge(['feature', '--no-ff', '-m', 'Merge feature branch']);

      // Test: Extract git metadata
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should pick highest version (v2.0.0) and increment
      // feature commit after v2.0.0 + merge commit = 2 increments
      expect(metadata.git.version).toBe('2.0.2');
    });

    it('should handle branch with no tags merged into tagged branch', async () => {
      // Setup: Main has tags, feature has no tags
      await testRepo.createFile('README.md', '# Test Project');
      await testRepo.commit('Initial commit');
      await testRepo.createTag('v1.0.0');

      await testRepo.createFile('main.txt', 'main content');
      await testRepo.commit('Main commit');
      await testRepo.createTag('v1.1.0');

      // Create feature branch with no tags
      await testRepo.createBranch('feature');
      await testRepo.createFile('feature1.txt', 'feature content 1');
      await testRepo.commit('Feature commit 1');
      await testRepo.createFile('feature2.txt', 'feature content 2');
      await testRepo.commit('Feature commit 2');

      // Switch back to main and merge
      await testRepo.checkout('main');
      await testRepo.git.merge(['feature', '--no-ff', '-m', 'Merge feature branch']);

      // Test: Extract git metadata
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should use main branch version and increment
      // feature commit 1 + feature commit 2 + merge commit = 3 increments from v1.1.0
      expect(metadata.git.version).toBe('1.1.3');
    });

    it('should handle deeply nested branch structure with tags', async () => {
      // Setup: Create deeply nested branch structure
      // main -> v1.0.0
      // main -> dev1 -> v1.1.0
      // dev1 -> dev2 -> v1.2.0
      // dev2 -> feature -> v2.0.0
      // All branches merge back in reverse order

      await testRepo.createFile('README.md', '# Test Project');
      await testRepo.commit('Initial commit');
      await testRepo.createTag('v1.0.0');

      // Create dev1 branch
      await testRepo.createBranch('dev1');
      await testRepo.createFile('dev1.txt', 'dev1 content');
      await testRepo.commit('Dev1 commit');
      await testRepo.createTag('v1.1.0');

      // Create dev2 branch from dev1
      await testRepo.createBranch('dev2');
      await testRepo.createFile('dev2.txt', 'dev2 content');
      await testRepo.commit('Dev2 commit');
      await testRepo.createTag('v1.2.0');

      // Create feature branch from dev2
      await testRepo.createBranch('feature');
      await testRepo.createFile('feature.txt', 'feature content');
      await testRepo.commit('Feature commit');
      await testRepo.createTag('v2.0.0'); // Highest version

      // Merge back in reverse order
      await testRepo.checkout('dev2');
      await testRepo.git.merge(['feature', '--no-ff', '-m', 'Merge feature to dev2']);

      await testRepo.checkout('dev1');
      await testRepo.git.merge(['dev2', '--no-ff', '-m', 'Merge dev2 to dev1']);

      await testRepo.checkout('main');
      await testRepo.git.merge(['dev1', '--no-ff', '-m', 'Merge dev1 to main']);

      // Test: Extract git metadata
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should find highest version and increment
      // merge feature to dev2 + merge dev2 to dev1 + merge dev1 to main = 3 merges from v2.0.0
      expect(metadata.git.version).toBe('2.0.3');
    });
  });

  describe('git metadata extraction', () => {
    it('should extract complete git metadata', async () => {
      // Setup: Create repository with tag
      await testRepo.createFile('README.md', '# Test Project');
      const commitHash = await testRepo.commit('Initial commit');
      await testRepo.createTag('v1.0.0');

      // Test: Extract git metadata
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: All expected metadata fields are present
      expect(metadata.git.version).toBe('1.0.0');
      expect(metadata.git.tags).toEqual(['v1.0.0']);
      expect(metadata.git.commit.hash).toBe(commitHash);
      expect(metadata.git.commit.shortHash).toBe(commitHash.substring(0, 7));
      expect(metadata.git.commit.date).toBeDefined();
      expect(metadata.git.commit.message).toBe('Initial commit');
      expect(metadata.git.branches).toEqual(['main']);
    });

    it.each([true, false])('should detect modified files', async (checkWorkingDirectoryStatus) => {
      // Setup: Create repository and modify files
      await testRepo.createFile('README.md', '# Test Project');
      await testRepo.commit('Initial commit');
      
      // Modify file without committing
      await testRepo.createFile('README.md', '# Modified Project');

      // Test: Extract git metadata
      const metadata = await getGitMetadata(testRepo.path, checkWorkingDirectoryStatus);

      // Verify: Should detect modifications
      expect(metadata.git.version).toBe(checkWorkingDirectoryStatus ? '0.0.2' : '0.0.1');
    });
  });

  describe('.gitignore handling', () => {
    it('should exclude ignored files from version increment detection', async () => {
      // Setup: Create repository with .gitignore
      await testRepo.createFile('README.md', '# Test Project');
      await testRepo.commit('Initial commit');
      await testRepo.createTag('v1.0.0');

      // Create .gitignore file
      await testRepo.createFile('.gitignore', 'temp.txt\n*.log\nnode_modules/\n');
      await testRepo.commit('Add .gitignore');

      // Create ignored files (should not trigger version increment)
      await testRepo.createFile('temp.txt', 'temporary content');
      await testRepo.createFile('debug.log', 'log content');
      
      // Test: Extract git metadata with working directory check
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should not increment version because all files are ignored
      expect(metadata.git.version).toBe('1.0.1'); // Only increment for .gitignore commit
    });

    it('should include ignored files except version increment detection', async () => {
      // Setup: Create repository with .gitignore
      await testRepo.createFile('README.md', '# Test Project');
      await testRepo.commit('Initial commit');
      await testRepo.createTag('v1.0.0');

      // Create .gitignore file
      await testRepo.createFile('.gitignore', 'test.txt\n*.log\ntemp/\n');
      await testRepo.commit('Add .gitignore');

      // Create mix of ignored and non-ignored files
      await testRepo.createFile('debug.log', 'log content'); // ignored
      await testRepo.createFile('test.txt', 'test content'); // ignored
      
      // Test: Extract git metadata with working directory check
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should not increment version because all files are ignored
      expect(metadata.git.version).toBe('1.0.1'); // .gitignore commit
    });

    it('should include non-ignored files in version increment detection', async () => {
      // Setup: Create repository with .gitignore
      await testRepo.createFile('README.md', '# Test Project');
      await testRepo.commit('Initial commit');
      await testRepo.createTag('v1.0.0');

      // Create .gitignore file
      await testRepo.createFile('.gitignore', '*.log\ntemp/\n');
      await testRepo.commit('Add .gitignore');

      // Create mix of ignored and non-ignored files
      await testRepo.createFile('debug.log', 'log content'); // ignored
      await testRepo.createFile('important.txt', 'important content'); // not ignored
      
      // Test: Extract git metadata with working directory check
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should increment version because important.txt is not ignored
      expect(metadata.git.version).toBe('1.0.2'); // .gitignore commit + untracked file
    });

    it('should handle subdirectory .gitignore files', async () => {
      // Setup: Create repository with subdirectory structure
      await testRepo.createFile('README.md', '# Test Project');
      await testRepo.commit('Initial commit');
      await testRepo.createTag('v1.0.0');

      // Create subdirectory with its own .gitignore
      await mkdir(join(testRepo.path, 'src'), { recursive: true });
      await testRepo.createFile('src/.gitignore', '*.tmp\ndebug/\n');
      await testRepo.commit('Add src/.gitignore');

      // Create files in subdirectory - mix of ignored and non-ignored
      await testRepo.createFile('src/temp.tmp', 'temp content'); // ignored by src/.gitignore
      await testRepo.createFile('src/code.js', 'console.log("hello");'); // not ignored
      
      // Test: Extract git metadata with working directory check
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should increment version because code.js is not ignored
      expect(metadata.git.version).toBe('1.0.2'); // src/.gitignore commit + untracked file
    });

    it('should handle complex .gitignore patterns', async () => {
      // Setup: Create repository with complex .gitignore patterns
      await testRepo.createFile('README.md', '# Test Project');
      await testRepo.commit('Initial commit');
      await testRepo.createTag('v1.0.0');

      // Create .gitignore with various patterns
      const gitignoreContent = `# Logs
*.log
logs/

# Dependencies
node_modules/
bower_components/

# Build outputs
dist/
build/
*.min.js

# IDE files
.vscode/
.idea/
*.swp

# OS files
.DS_Store
Thumbs.db

# Temporary files
*.tmp
.cache/

# But include some exceptions
!important.log
!dist/index.html
`;
      await testRepo.createFile('.gitignore', gitignoreContent);
      await testRepo.commit('Add comprehensive .gitignore');

      // Create various files matching different patterns
      await testRepo.createFile('debug.log', 'debug content'); // ignored
      await testRepo.createFile('important.log', 'important content'); // exception - not ignored
      await testRepo.createFile('app.min.js', 'minified js'); // ignored
      await testRepo.createFile('regular.js', 'regular js'); // not ignored
      await testRepo.createFile('temp.tmp', 'temp'); // ignored
      
      // Test: Extract git metadata with working directory check
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should increment version because important.log and regular.js are not ignored
      expect(metadata.git.version).toBe('1.0.2'); // .gitignore commit + untracked files
    });

    it('should handle nested .gitignore files with different rules', async () => {
      // Setup: Create repository with nested .gitignore structure
      await testRepo.createFile('README.md', '# Test Project');
      await testRepo.commit('Initial commit');
      await testRepo.createTag('v1.0.0');

      // Root .gitignore
      await testRepo.createFile('.gitignore', '*.log\ntemp/\n');
      
      // Create nested directory structure
      await mkdir(join(testRepo.path, 'src/utils'), { recursive: true });
      
      // Subdirectory .gitignore with different rules
      await testRepo.createFile('src/.gitignore', '*.tmp\n!important.tmp\n');
      await testRepo.createFile('src/utils/.gitignore', '*.cache\n');
      
      await testRepo.commit('Add nested .gitignore files');

      // Create files at different levels
      await testRepo.createFile('app.log', 'app logs'); // ignored by root
      await testRepo.createFile('config.txt', 'config'); // not ignored
      await testRepo.createFile('src/temp.tmp', 'temp'); // ignored by src/
      await testRepo.createFile('src/important.tmp', 'important'); // exception in src/
      await testRepo.createFile('src/code.js', 'code'); // not ignored
      await testRepo.createFile('src/utils/data.cache', 'cache'); // ignored by src/utils/
      await testRepo.createFile('src/utils/helper.js', 'helper'); // not ignored
      
      // Test: Extract git metadata with working directory check
      const metadata = await getGitMetadata(testRepo.path, true);

      // Verify: Should increment version for non-ignored files
      // config.txt, src/important.tmp, src/code.js, src/utils/helper.js are not ignored
      expect(metadata.git.version).toBe('1.0.2'); // .gitignore commits + untracked files
    });

    it('should handle .gitignore with working directory status disabled', async () => {
      // Setup: Create repository with .gitignore
      await testRepo.createFile('README.md', '# Test Project');
      await testRepo.commit('Initial commit');
      await testRepo.createTag('v1.0.0');

      await testRepo.createFile('.gitignore', '*.tmp\n');
      await testRepo.commit('Add .gitignore');

      // Create files that would normally be ignored
      await testRepo.createFile('temp.tmp', 'temp content');
      await testRepo.createFile('important.txt', 'important content');
      
      // Test: Extract git metadata without working directory check
      const metadata = await getGitMetadata(testRepo.path, false);

      // Verify: Should not check working directory status at all
      expect(metadata.git.version).toBe('1.0.1'); // Only .gitignore commit, no working dir check
    });
  });
});
