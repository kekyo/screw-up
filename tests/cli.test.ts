import { describe, it, expect, beforeEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readSync,
  readdirSync,
} from 'fs';
import { join, relative, resolve } from 'path';
import { tmpdir } from 'os';
import { spawn, execSync } from 'child_process';
import * as tar from 'tar';
import dayjs from 'dayjs';
import { cliMain } from '../src/cli.ts';
import { packAssets } from '../src/cli-internal';
import { createConsoleLogger } from '../src/internal';

// Default inheritable fields (copied from main.ts)
const defaultInheritableFields = new Set([
  'version',
  'description',
  'author',
  'license',
  'repository',
  'keywords',
  'homepage',
  'bugs',
  'readme',
]);

const sortObjectKeys = (obj) => {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  const sorted = {};
  Object.keys(obj)
    .sort()
    .forEach((key) => {
      sorted[key] = sortObjectKeys(obj[key]);
    });
  return sorted;
};

const expectedObject = (expected, actual) => {
  expect(JSON.stringify(sortObjectKeys(actual))).toBe(
    JSON.stringify(sortObjectKeys(expected))
  );
};

describe('CLI tests', () => {
  const tempBaseDir = join(
    tmpdir(),
    'screw-up',
    'cli-test',
    dayjs().format('YYYYMMDD_HHmmssSSS')
  );

  let tempDir: string;
  let testSourceDir: string;

  beforeEach((fn) => {
    tempDir = join(tempBaseDir, fn.task.name);
    testSourceDir = join(tempDir, 'source');
    mkdirSync(testSourceDir, { recursive: true });

    // Create basic package.json for most tests
    const basicPackage = {
      name: 'test-package',
      version: '1.0.0',
    };
    writeFileSync(
      join(testSourceDir, 'package.json'),
      JSON.stringify(basicPackage, null, 2)
    );

    // Create test files
    writeFileSync(join(testSourceDir, 'file1.txt'), 'Test content 1\n');
    writeFileSync(join(testSourceDir, 'file2.js'), 'console.log("test");\n');

    // Create subdirectory with files
    const subDir = join(testSourceDir, 'subdir');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'nested.json'), '{"test": true}\n');
  });

  const runCLI = (
    command: string,
    args: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: tempDir,
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code || 0 });
      });
    });
  };

  const expectCLISuccess = (
    result: { stdout: string; stderr: string; exitCode: number },
    expectStderr: boolean = false
  ) => {
    if (result.exitCode !== 0) {
      const errorMessage = [
        `CLI command failed with exit code ${result.exitCode}`,
        `STDOUT: ${result.stdout}`,
        `STDERR: ${result.stderr}`,
      ].join('\n');
      throw new Error(errorMessage);
    }
    expect(result.exitCode).toBe(0);
    if (!expectStderr) {
      expect(result.stderr).toBe('');
    }
  };

  //////////////////////////////////////////////////////////////////////////////////

  describe('packAssets', () => {
    it('should pack assets into a tar archive', async () => {
      // Pack assets from test source directory
      const targetDir = testSourceDir;
      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const logger = createConsoleLogger();
      const { packageFileName, metadata } = (await packAssets(
        targetDir,
        outputDir,
        true,
        true,
        defaultInheritableFields,
        undefined,
        true,
        '^',
        logger
      ))!;
      expect(metadata).toBeDefined();
      expect(metadata?.name).toBe('test-package');
      expect(metadata?.version).toBe('1.0.0');

      // Check if test-package-1.0.0.tgz was created
      const archivePath = join(outputDir, packageFileName);
      expect(existsSync(archivePath)).toBe(true);

      // Extract archive
      const extractDir = join(tempDir, 'extract');
      mkdirSync(extractDir);
      await tar.extract({
        file: archivePath,
        cwd: extractDir,
      });

      // Compare and verify archive contents each file by file
      const result = await runCLI('diff', [
        '-r',
        relative(tempDir, targetDir),
        relative(tempDir, join(extractDir, 'package')),
      ]);
      expectCLISuccess(result);
    });

    it('should pack workspace assets into a tar archive', async () => {
      // Create workspace root with parent package.json
      const workspaceRoot = join(tempDir, 'workspace');
      mkdirSync(workspaceRoot);

      const rootPackageJson = {
        name: 'workspace-root',
        version: '1.0.0',
        author: 'Workspace Author',
        license: 'Apache-2.0',
        private: true,
        workspaces: ['packages/*'],
      };
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create child package
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });

      const childPackageJson = {
        name: 'child-package',
        description: 'Child package description',
        version: '2.0.0',
      };
      writeFileSync(
        join(childDir, 'package.json'),
        JSON.stringify(childPackageJson, null, 2)
      );

      // Add test files to child
      writeFileSync(join(childDir, 'index.js'), 'console.log("child");');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const workspaceArchived = await packAssets(
        workspaceRoot,
        outputDir,
        true,
        true,
        defaultInheritableFields,
        undefined,
        true,
        '^',
        createConsoleLogger()
      );
      expect(workspaceArchived).toBeUndefined();

      // Check workspace archive was not created
      const workspaceArchivePath = join(outputDir, 'workspace-root-1.0.0.tgz');
      expect(existsSync(workspaceArchivePath)).toBe(false);

      const { packageFileName, metadata } = (await packAssets(
        childDir,
        outputDir,
        true,
        true,
        defaultInheritableFields,
        undefined,
        true,
        '^',
        createConsoleLogger()
      ))!;
      expect(metadata).toBeDefined();
      expect(metadata?.name).toBe('child-package');
      expect(metadata?.version).toBe('2.0.0');

      // Check child package archive was created
      const childArchivePath = join(outputDir, packageFileName);
      expect(existsSync(childArchivePath)).toBe(true);

      // Extract archive
      const extractDir = join(tempDir, 'extract');
      mkdirSync(extractDir);
      await tar.extract({
        file: childArchivePath,
        cwd: extractDir,
      });

      // Compare and verify child package archive contents each file by file excepts package.json
      const extractPackageDir = join(extractDir, 'package');
      const result = await runCLI('diff', [
        '-r',
        '--exclude=package.json',
        relative(tempDir, childDir),
        relative(tempDir, extractPackageDir),
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('');

      // Assert package.json
      const expectedJsonObject = {
        name: 'child-package',
        version: '2.0.0',
        author: 'Workspace Author',
        license: 'Apache-2.0',
        description: 'Child package description',
      };

      const actualJsonObject = JSON.parse(
        readFileSync(join(extractPackageDir, 'package.json'), 'utf-8')
      );

      expectedObject(expectedJsonObject, actualJsonObject);
    });

    it('should handle workspace inheritance in package.json', async () => {
      // Create workspace root with parent package.json
      const workspaceRoot = join(tempDir, 'workspace');
      mkdirSync(workspaceRoot);

      const rootPackageJson = {
        name: 'workspace-root',
        version: '2.0.0',
        author: 'Workspace Author',
        license: 'Apache-2.0',
        workspaces: ['packages/*'],
      };
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create child package
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });

      const childPackageJson = {
        name: 'child-package',
        version: '1.0.0',
        description: 'Child package description',
      };
      writeFileSync(
        join(childDir, 'package.json'),
        JSON.stringify(childPackageJson, null, 2)
      );

      // Add test files to child
      writeFileSync(join(childDir, 'index.js'), 'console.log("child");');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const { packageFileName, metadata } = (await packAssets(
        childDir,
        outputDir,
        true,
        true,
        defaultInheritableFields,
        undefined,
        true,
        '^',
        createConsoleLogger()
      ))!;
      expect(metadata).toBeDefined();
      expect(metadata?.name).toBe('child-package');
      expect(metadata?.version).toBe('1.0.0');

      // Extract and verify inherited metadata
      const archivePath = join(outputDir, packageFileName);
      const extractDir = join(tempDir, 'extract-child');
      mkdirSync(extractDir);

      await tar.extract({
        file: archivePath,
        cwd: extractDir,
      });

      const extractedPackageJsonPath = join(extractDir, 'package/package.json');
      expect(existsSync(extractedPackageJsonPath)).toBe(true);

      const extractedPackageJson = JSON.parse(
        readFileSync(extractedPackageJsonPath, 'utf-8')
      );

      // Verify child overrides
      expect(extractedPackageJson.name).toBe('child-package');
      expect(extractedPackageJson.description).toBe(
        'Child package description'
      );

      // Verify inherited from parent
      expect(extractedPackageJson.version).toBe('1.0.0');
      expect(extractedPackageJson.author).toBe('Workspace Author');
      expect(extractedPackageJson.license).toBe('Apache-2.0');

      // Workspace field should not be inherited
      expect(extractedPackageJson.workspaces).toBeUndefined();
    }, 10000);

    it('should pack with README replacement using CLI option', async () => {
      // Create README replacement file
      const readmeReplacement = join(testSourceDir, 'README_custom.md');
      writeFileSync(
        readmeReplacement,
        '# Custom README for packaging\nThis is a custom README file.'
      );

      // Create regular README.md
      const regularReadme = join(testSourceDir, 'README.md');
      writeFileSync(regularReadme, '# Regular README\nThis should be ignored.');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const { packageFileName, metadata } = (await packAssets(
        testSourceDir,
        outputDir,
        true,
        true,
        defaultInheritableFields,
        readmeReplacement,
        true,
        '^',
        createConsoleLogger()
      ))!;
      expect(metadata).toBeDefined();
      expect(metadata?.name).toBe('test-package');

      // Check if archive was created
      const archivePath = join(outputDir, packageFileName);
      expect(existsSync(archivePath)).toBe(true);

      // Extract and verify README.md content
      const extractDir = join(tempDir, 'extract-readme');
      mkdirSync(extractDir);
      await tar.extract({
        file: archivePath,
        cwd: extractDir,
      });

      const extractedReadme = join(extractDir, 'package/README.md');
      expect(existsSync(extractedReadme)).toBe(true);

      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe(
        '# Custom README for packaging\nThis is a custom README file.'
      );
      expect(readmeContent).not.toContain('Regular README');
    });

    it('should pack with README replacement using package.json readme field', async () => {
      // Create separate test directory for this test
      const testDir = join(tempDir, 'package-json-readme-test');
      mkdirSync(testDir, { recursive: true });

      // Create package.json with `readme` field
      const packageJsonWithReadme = {
        name: 'test-package-readme',
        version: '1.0.0',
        description: 'Test package with readme field',
        author: 'Test Author',
        license: 'MIT',
        readme: 'README_pack.md', // Replacement
        files: ['**/*'],
      };
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify(packageJsonWithReadme, null, 2)
      );

      // Create README files
      const packReadme = join(testDir, 'README_pack.md');
      writeFileSync(
        packReadme,
        '# Pack README\nThis is the pack-specific README.'
      );

      const regularReadme = join(testDir, 'README.md');
      writeFileSync(regularReadme, '# Regular README\nThis should be ignored.');

      writeFileSync(join(testDir, 'index.js'), 'console.log("test");');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // No CLI readme option provided - should use package.json readme field
      const { packageFileName, metadata } = (await packAssets(
        testDir,
        outputDir,
        true,
        true,
        defaultInheritableFields,
        undefined,
        true,
        '^',
        createConsoleLogger()
      ))!;
      expect(metadata).toBeDefined();
      expect(metadata?.name).toBe('test-package-readme');

      // Check if archive was created
      const archivePath = join(outputDir, packageFileName);
      expect(existsSync(archivePath)).toBe(true);

      // Extract and verify README.md content
      const extractDir = join(tempDir, 'extract-pack-readme');
      mkdirSync(extractDir);
      await tar.extract({
        file: archivePath,
        cwd: extractDir,
      });

      const extractedReadme = join(extractDir, 'package/README.md');
      expect(existsSync(extractedReadme)).toBe(true);

      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe(
        '# Pack README\nThis is the pack-specific README.'
      );
      expect(readmeContent).not.toContain('Regular README');
    });

    it('should prioritize CLI option over package.json readme field', async () => {
      // Create separate test directory for this test
      const testDir = join(tempDir, 'priority-test');
      mkdirSync(testDir, { recursive: true });

      // Create package.json with readme field
      const packageJsonWithReadme = {
        name: 'test-priority',
        version: '1.0.0',
        description: 'Test priority handling',
        author: 'Test Author',
        license: 'MIT',
        readme: 'README_pack.md',
        files: ['**/*'],
      };
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify(packageJsonWithReadme, null, 2)
      );

      // Create multiple README files
      const packReadme = join(testDir, 'README_pack.md');
      writeFileSync(
        packReadme,
        '# Pack README\nFrom package.json readme field.'
      );

      const cliReadme = join(testDir, 'README_cli.md');
      writeFileSync(
        cliReadme,
        '# CLI README\nFrom CLI option - should take priority.'
      );

      const regularReadme = join(testDir, 'README.md');
      writeFileSync(regularReadme, '# Regular README\nShould be ignored.');

      writeFileSync(join(testDir, 'index.js'), 'console.log("test");');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // CLI option should take priority over package.json readme field
      const { packageFileName, metadata } = (await packAssets(
        testDir,
        outputDir,
        true,
        true,
        defaultInheritableFields,
        cliReadme,
        true,
        '^',
        createConsoleLogger()
      ))!;
      expect(metadata).toBeDefined();
      expect(metadata!.readme).not.toBeDefined();
      expect(metadata!.name).toBe('test-priority');

      // Check if archive was created
      const archivePath = join(outputDir, packageFileName);
      expect(existsSync(archivePath)).toBe(true);

      // Extract and verify README.md content
      const extractDir = join(tempDir, 'extract-priority');
      mkdirSync(extractDir);
      await tar.extract({
        file: archivePath,
        cwd: extractDir,
      });

      const extractedReadme = join(extractDir, 'package/README.md');
      expect(existsSync(extractedReadme)).toBe(true);

      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe(
        '# CLI README\nFrom CLI option - should take priority.'
      );
      expect(readmeContent).not.toContain('Pack README');
      expect(readmeContent).not.toContain('Regular README');
    });

    it('should add README.md even when not in files array', async () => {
      // Create separate test directory for this test
      const testDir = join(tempDir, 'no-files-test');
      mkdirSync(testDir, { recursive: true });

      // Create package.json without README.md in files array
      const packageJsonNoReadme = {
        name: 'test-no-readme-in-files',
        version: '1.0.0',
        description: 'Test adding README when not in files',
        author: 'Test Author',
        license: 'MIT',
        files: ['index.js'], // README.md not included
      };
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify(packageJsonNoReadme, null, 2)
      );

      writeFileSync(join(testDir, 'index.js'), 'console.log("test");');

      // Create replacement README file
      const replacementReadme = join(testDir, 'README_replacement.md');
      writeFileSync(
        replacementReadme,
        '# Replacement README\nAdded even though not in files array.'
      );

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const { packageFileName, metadata } = (await packAssets(
        testDir,
        outputDir,
        true,
        true,
        defaultInheritableFields,
        replacementReadme,
        true,
        '^',
        createConsoleLogger()
      ))!;
      expect(metadata).toBeDefined();
      expect(metadata!.name).toBe('test-no-readme-in-files');
      expect(metadata!.readme).not.toBeDefined();

      // Check if archive was created
      const archivePath = join(outputDir, packageFileName);
      expect(existsSync(archivePath)).toBe(true);

      // Extract and verify README.md was added
      const extractDir = join(tempDir, 'extract-no-files');
      mkdirSync(extractDir);
      await tar.extract({
        file: archivePath,
        cwd: extractDir,
      });

      const extractedReadme = join(extractDir, 'package/README.md');
      expect(existsSync(extractedReadme)).toBe(true);

      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe(
        '# Replacement README\nAdded even though not in files array.'
      );
    });

    it('should throw error when replacement file does not exist', async () => {
      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const nonExistentReadme = join(testSourceDir, 'non-existent-readme.md');

      await expect(
        packAssets(
          testSourceDir,
          outputDir,
          true,
          true,
          defaultInheritableFields,
          nonExistentReadme,
          true,
          '^',
          createConsoleLogger()
        )
      ).rejects.toThrow('README replacement file is not found:');
    }, 10000);
  });

  //////////////////////////////////////////////////////////////////////////////////

  const execCliMainWithLogging = async (args: string[], options: any) => {
    let info: string[] = [];
    let err: string[] = [];
    const logger = {
      debug: (msg) => info.push(msg),
      info: (msg) => info.push(msg),
      warn: (msg) => err.push(msg),
      error: (msg) => err.push(msg),
    };

    // Hook console.info to capture help messages
    const originalConsoleInfo = console.info;
    console.info = (msg: string) => info.push(msg);

    const oldwd = process.cwd();
    const oldenv = process.env;
    try {
      if (options.cwd) {
        process.chdir(options.cwd);
      }
      if (options.env) {
        process.env = options.env;
      }
      let code: number;
      try {
        code = await cliMain(args, logger);
      } catch (error: any) {
        err.push(error.message);
        return { info: info.join('\n'), err: err.join('\n'), code: 1 };
      }
      if (code !== 0) {
        return { info: info.join('\n'), err: err.join('\n'), code };
      }
      return { info: info.join('\n'), err: err.join('\n'), code: 0 };
    } finally {
      // Restore console.info
      console.info = originalConsoleInfo;
      process.env = oldenv;
      process.chdir(oldwd);
    }
  };

  const execCliMain = async (args: string[], options: any) => {
    let logs: string[] = [];
    let consoleOutput: string[] = [];
    const logger = {
      debug: (msg) => logs.push(msg),
      info: (msg) => logs.push(msg),
      warn: (msg) => logs.push(msg),
      error: (msg) => logs.push(msg),
    };

    // Hook console.info for dump command
    const originalConsoleInfo = console.info;
    console.info = (msg) => {
      consoleOutput.push(msg);
    };

    const oldwd = process.cwd();
    const oldenv = process.env;
    try {
      if (options.cwd) {
        process.chdir(options.cwd);
      }
      if (options.env) {
        process.env = options.env;
      }
      let code: number;
      try {
        code = await cliMain(args, logger);
      } catch (error: any) {
        error.message = error.message + '\n' + logs.join('\n');
        throw error;
      }
      if (code !== 0) {
        const error: any = new Error(logs.join('\n'));
        error.status = code;
        throw error;
      }

      // For dump command, return console output instead of logs
      if (args.length > 0 && args[0] === 'dump') {
        return consoleOutput.join('\n');
      }
      return logs.join('\n');
    } finally {
      console.info = originalConsoleInfo;
      process.env = oldenv;
      process.chdir(oldwd);
    }
  };

  describe('CLI pack command tests', () => {
    it('should pack current directory when no arguments provided', async () => {
      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // Run CLI pack command from the output directory
      const result = await execCliMain(['pack', '--verbose', testSourceDir], {
        cwd: outputDir,
      });

      expect(result).toContain('Creating archive of');
      expect(result).toContain('Archive created successfully');

      // Check if test-package-1.0.0.tgz was created in current directory (outputDir)
      const archivePath = join(outputDir, 'test-package-1.0.0.tgz');
      expect(existsSync(archivePath)).toBe(true);

      // Verify archive contents
      const files: string[] = [];
      await tar.list({
        file: archivePath,
        onentry: (entry: any) => files.push(entry.path),
      });
      expect(files).toContain('package/package.json');
      expect(files).toContain('package/file1.txt');
      expect(files).toContain('package/file2.js');
      expect(files).toContain('package/subdir/nested.json');
    }, 10000);

    it('should pack specified directory', async () => {
      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // Run CLI pack command with specific directory
      const result = await execCliMain(['pack', '--verbose', testSourceDir], {
        cwd: outputDir,
      });

      expect(result).toContain(`Creating archive of ${testSourceDir}`);
      expect(result).toContain('Archive created successfully');

      // Check if test-package-1.0.0.tgz was created
      const archivePath = join(outputDir, 'test-package-1.0.0.tgz');
      expect(existsSync(archivePath)).toBe(true);

      // Extract and verify contents
      const extractDir = join(tempDir, 'extract');
      mkdirSync(extractDir);

      await tar.extract({
        file: archivePath,
        cwd: extractDir,
      });

      expect(existsSync(join(extractDir, 'package', 'file1.txt'))).toBe(true);
      expect(existsSync(join(extractDir, 'package', 'file2.js'))).toBe(true);
      expect(
        existsSync(join(extractDir, 'package', 'subdir', 'nested.json'))
      ).toBe(true);

      const content1 = readFileSync(
        join(extractDir, 'package', 'file1.txt'),
        'utf-8'
      );
      expect(content1).toBe('Test content 1\n');

      const content2 = readFileSync(
        join(extractDir, 'package', 'subdir', 'nested.json'),
        'utf-8'
      );
      expect(content2).toBe('{"test": true}\n');
    }, 10000);

    it('should use --pack-destination option to specify output directory', async () => {
      const outputDir = join(tempDir, 'custom-output');
      mkdirSync(outputDir, { recursive: true });

      // Run CLI pack command with --pack-destination
      const result = await execCliMain(
        ['pack', '--verbose', testSourceDir, '--pack-destination', outputDir],
        {
          cwd: tempDir,
        }
      );

      expect(result).toContain('Creating archive of');
      expect(result).toContain('Archive created successfully');

      // Check if test-package-1.0.0.tgz was created in the specified destination
      const archivePath = join(outputDir, 'test-package-1.0.0.tgz');
      expect(existsSync(archivePath)).toBe(true);

      // Should not be created in current directory
      const currentDirArchive = join(tempDir, 'package.tgz');
      expect(existsSync(currentDirArchive)).toBe(false);

      // Verify archive contents
      const files: string[] = [];
      await tar.list({
        file: archivePath,
        onentry: (entry: any) => files.push(entry.path),
      });
      expect(files).toContain('package/package.json');
      expect(files).toContain('package/file1.txt');
      expect(files).toContain('package/file2.js');
      expect(files).toContain('package/subdir/nested.json');
    }, 10000);

    it('should handle relative paths in --pack-destination', async () => {
      const outputDir = join(tempDir, 'relative-test');
      mkdirSync(outputDir);

      // Run from a different directory with relative path
      const relativeOutputDir = 'output';
      const fullOutputDir = join(outputDir, relativeOutputDir);
      mkdirSync(fullOutputDir);

      const result = await execCliMain(
        [
          'pack',
          '--verbose',
          testSourceDir,
          '--pack-destination',
          relativeOutputDir,
        ],
        {
          cwd: outputDir,
        }
      );

      expect(result).toContain('Archive created successfully');

      // Check if test-package-1.0.0.tgz was created in the relative path
      const archivePath = join(fullOutputDir, 'test-package-1.0.0.tgz');
      expect(existsSync(archivePath)).toBe(true);
    }, 10000);

    it('should show help for pack command', async () => {
      const result = await execCliMainWithLogging(
        ['pack', '--verbose', '--help'],
        {}
      );

      expect(result.info).toContain(
        'Usage: screw-up pack [options] [directory]'
      );
      expect(result.info).toContain('Pack the project into a tar archive');
      expect(result.info).toContain(
        'directory                     Directory to pack (default: current directory)'
      );
    });

    it('should handle empty directory', async () => {
      const emptyDir = join(tempDir, 'empty');
      mkdirSync(emptyDir);

      // Create basic package.json for empty directory test
      const emptyPackageJson = {
        name: 'empty-package',
        version: '1.0.0',
      };
      writeFileSync(
        join(emptyDir, 'package.json'),
        JSON.stringify(emptyPackageJson, null, 2)
      );

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const result = await execCliMain(['pack', '--verbose', emptyDir], {
        cwd: outputDir,
      });

      expect(result).toContain('Archive created successfully');

      // Check if empty-package-1.0.0.tgz was created
      const archivePath = join(outputDir, 'empty-package-1.0.0.tgz');
      expect(existsSync(archivePath)).toBe(true);

      // Verify archive contains at least the directory entry
      const files: string[] = [];
      await tar.list({
        file: archivePath,
        onentry: (entry: any) => files.push(entry.path),
      });
      expect(files).toContain('package/package.json');
    }, 10000);

    it('should handle files with special characters', async () => {
      const specialDir = join(tempDir, 'special');
      mkdirSync(specialDir);

      // Create basic package.json for special directory test
      const specialPackageJson = {
        name: 'special-package',
        version: '1.0.0',
      };
      writeFileSync(
        join(specialDir, 'package.json'),
        JSON.stringify(specialPackageJson, null, 2)
      );

      // Create files with special characters in names
      writeFileSync(join(specialDir, 'file with spaces.txt'), 'content');
      writeFileSync(join(specialDir, 'file-with-dashes.txt'), 'content');
      writeFileSync(join(specialDir, 'file.with.dots.txt'), 'content');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const result = await execCliMain(['pack', '--verbose', specialDir], {
        cwd: outputDir,
      });

      expect(result).toContain('Archive created successfully');

      const archivePath = join(outputDir, 'special-package-1.0.0.tgz');
      const files: string[] = [];
      await tar.list({
        file: archivePath,
        onentry: (entry: any) => files.push(entry.path),
      });

      expect(files).toContain('package/package.json');
      expect(files).toContain('package/file with spaces.txt');
      expect(files).toContain('package/file-with-dashes.txt');
      expect(files).toContain('package/file.with.dots.txt');
    }, 10000);

    it('should create output directory if it does not exist', async () => {
      const nonExistentOutput = join(
        tempDir,
        'non-existent',
        'nested',
        'output'
      );

      // Directory should not exist initially
      expect(existsSync(nonExistentOutput)).toBe(false);

      const result = await execCliMain(
        [
          'pack',
          '--verbose',
          testSourceDir,
          '--pack-destination',
          nonExistentOutput,
        ],
        {
          cwd: tempDir,
        }
      );

      expect(result).toContain('Archive created successfully');

      // Directory should be created and archive should exist
      const archivePath = join(nonExistentOutput, 'test-package-1.0.0.tgz');
      expect(existsSync(archivePath)).toBe(true);
    }, 10000);

    it('should handle error when source directory does not exist', async () => {
      const nonExistentDir = join(tempDir, 'does-not-exist');
      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      try {
        await execCliMain(['pack', '--verbose', nonExistentDir], {
          cwd: outputDir,
        });
        // Should not reach here, command should fail
        expect.fail('Command should have failed');
      } catch (error: any) {
        // Check error message in stderr
        expect(error.message).toContain('Target directory is not found');
        expect(error.status).toBe(1);
      }
    });

    it('should use resolved package.json metadata in archive', async () => {
      // Create test package.json
      const packageJson = {
        name: 'test-resolved-pack',
        version: '1.2.3',
        description: 'Test resolved metadata',
        author: 'Test Author',
        license: 'MIT',
      };
      writeFileSync(
        join(testSourceDir, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const result = await execCliMain(['pack', '--verbose', testSourceDir], {
        cwd: outputDir,
      });

      expect(result).toContain('Archive created successfully');

      // Extract and verify package.json content
      const archivePath = join(outputDir, 'test-resolved-pack-1.2.3.tgz');
      const extractDir = join(tempDir, 'extract-resolved');
      mkdirSync(extractDir);

      await tar.extract({
        file: archivePath,
        cwd: extractDir,
      });

      // Verify package.json exists and has resolved content
      const extractedPackageJsonPath = join(extractDir, 'package/package.json');
      expect(existsSync(extractedPackageJsonPath)).toBe(true);

      const extractedPackageJson = JSON.parse(
        readFileSync(extractedPackageJsonPath, 'utf-8')
      );
      expect(extractedPackageJson.name).toBe('test-resolved-pack');
      expect(extractedPackageJson.version).toBe('1.2.3');
      expect(extractedPackageJson.description).toBe('Test resolved metadata');
      expect(extractedPackageJson.author).toBe('Test Author');
      expect(extractedPackageJson.license).toBe('MIT');
    }, 10000);

    it('should handle workspace inheritance in package.json', async () => {
      // Create workspace root with parent package.json
      const workspaceRoot = join(tempDir, 'workspace-cli');
      mkdirSync(workspaceRoot);

      const rootPackageJson = {
        name: 'workspace-root',
        version: '2.0.0',
        author: 'Workspace Author',
        license: 'Apache-2.0',
        workspaces: ['packages/*'],
      };
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create child package
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });

      const childPackageJson = {
        name: 'child-package',
        version: '1.0.0',
        description: 'Child package description',
      };
      writeFileSync(
        join(childDir, 'package.json'),
        JSON.stringify(childPackageJson, null, 2)
      );

      // Add test files to child
      writeFileSync(join(childDir, 'index.js'), 'console.log("child");');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const result = await execCliMain(['pack', '--verbose', childDir], {
        cwd: outputDir,
      });

      expect(result).toContain('Archive created successfully');

      // Extract and verify inherited metadata
      const archivePath = join(outputDir, 'child-package-1.0.0.tgz');
      const extractDir = join(tempDir, 'extract-workspace');
      mkdirSync(extractDir);

      await tar.extract({
        file: archivePath,
        cwd: extractDir,
      });

      const extractedPackageJsonPath = join(extractDir, 'package/package.json');
      expect(existsSync(extractedPackageJsonPath)).toBe(true);

      const extractedPackageJson = JSON.parse(
        readFileSync(extractedPackageJsonPath, 'utf-8')
      );

      // Verify child overrides
      expect(extractedPackageJson.name).toBe('child-package');
      expect(extractedPackageJson.description).toBe(
        'Child package description'
      );

      // Verify inherited from parent
      expect(extractedPackageJson.version).toBe('1.0.0');
      expect(extractedPackageJson.author).toBe('Workspace Author');
      expect(extractedPackageJson.license).toBe('Apache-2.0');

      // Workspace field should not be inherited
      expect(extractedPackageJson.workspaces).toBeUndefined();
    }, 10000);

    it('should handle package.json without existing file', async () => {
      // Create a directory without package.json to test empty metadata resolution
      const emptyMetadataDir = join(tempDir, 'no-package-json');
      mkdirSync(emptyMetadataDir);

      // Create test file in directory
      writeFileSync(join(emptyMetadataDir, 'test.txt'), 'test content');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      try {
        await execCliMain(['pack', '--verbose', emptyMetadataDir], {
          cwd: outputDir,
        });
        // Should not reach here, command should fail
        expect.fail('Command should have failed');
      } catch (error: any) {
        // Check error message in stderr and stdout
        expect(error.message).toContain('no such file or directory');
        expect(error.status).toBe(1);
      }
    }, 10000);

    it('should pack with --readme option to replace README.md', async () => {
      // Create README replacement file
      const readmeReplacement = join(testSourceDir, 'README_custom.md');
      writeFileSync(
        readmeReplacement,
        '# Custom README for packaging\nThis is a custom README file.'
      );

      // Create regular README.md
      const regularReadme = join(testSourceDir, 'README.md');
      writeFileSync(regularReadme, '# Regular README\nThis should be ignored.');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // Run CLI pack command with --readme option
      const result = await execCliMain(
        ['pack', '--verbose', testSourceDir, '--readme', readmeReplacement],
        {
          cwd: outputDir,
        }
      );

      expect(result).toContain('Creating archive of');
      expect(result).toContain('Archive created successfully');

      // Check if archive was created
      const archivePath = join(outputDir, 'test-package-1.0.0.tgz');
      expect(existsSync(archivePath)).toBe(true);

      // Extract and verify README.md content
      const extractDir = join(tempDir, 'extract-readme');
      mkdirSync(extractDir);
      await tar.extract({
        file: archivePath,
        cwd: extractDir,
      });

      const extractedReadme = join(extractDir, 'package/README.md');
      expect(existsSync(extractedReadme)).toBe(true);

      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe(
        '# Custom README for packaging\nThis is a custom README file.'
      );
      expect(readmeContent).not.toContain('Regular README');
    }, 10000);

    it('should pack with package.json readme field when no --readme option', async () => {
      // Create separate test directory for this test
      const testDir = join(tempDir, 'package-json-readme-test');
      mkdirSync(testDir, { recursive: true });

      // Create package.json with readme field
      const packageJsonWithReadme = {
        name: 'test-package-readme',
        version: '1.0.0',
        description: 'Test package with readme field',
        author: 'Test Author',
        license: 'MIT',
        readme: 'README_pack.md',
        files: ['**/*'],
      };
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify(packageJsonWithReadme, null, 2)
      );

      // Create README files
      const packReadme = join(testDir, 'README_pack.md');
      writeFileSync(
        packReadme,
        '# Pack README\nThis is the pack-specific README.'
      );

      const regularReadme = join(testDir, 'README.md');
      writeFileSync(regularReadme, '# Regular README\nThis should be ignored.');

      writeFileSync(join(testDir, 'index.js'), 'console.log("test");');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // Run CLI pack command without --readme option
      const result = await execCliMain(['pack', '--verbose', testDir], {
        cwd: outputDir,
      });

      expect(result).toContain('Creating archive of');
      expect(result).toContain('Archive created successfully');

      // Check if archive was created
      const archivePath = join(outputDir, 'test-package-readme-1.0.0.tgz');
      expect(existsSync(archivePath)).toBe(true);

      // Extract and verify README.md content
      const extractDir = join(tempDir, 'extract-pack-readme');
      mkdirSync(extractDir);
      await tar.extract({
        file: archivePath,
        cwd: extractDir,
      });

      const extractedReadme = join(extractDir, 'package/README.md');
      expect(existsSync(extractedReadme)).toBe(true);

      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe(
        '# Pack README\nThis is the pack-specific README.'
      );
      expect(readmeContent).not.toContain('Regular README');
    }, 10000);

    it('should prioritize --readme option over package.json readme field', async () => {
      // Create separate test directory for this test
      const testDir = join(tempDir, 'priority-test');
      mkdirSync(testDir, { recursive: true });

      // Create package.json with readme field
      const packageJsonWithReadme = {
        name: 'test-priority',
        version: '1.0.0',
        description: 'Test priority handling',
        author: 'Test Author',
        license: 'MIT',
        readme: 'README_pack.md',
        files: ['**/*'],
      };
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify(packageJsonWithReadme, null, 2)
      );

      // Create multiple README files
      const packReadme = join(testDir, 'README_pack.md');
      writeFileSync(
        packReadme,
        '# Pack README\nFrom package.json readme field.'
      );

      const cliReadme = join(testDir, 'README_cli.md');
      writeFileSync(
        cliReadme,
        '# CLI README\nFrom CLI option - should take priority.'
      );

      const regularReadme = join(testDir, 'README.md');
      writeFileSync(regularReadme, '# Regular README\nShould be ignored.');

      writeFileSync(join(testDir, 'index.js'), 'console.log("test");');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // Run CLI pack command with --readme option (should override package.json readme)
      const result = await execCliMain(
        ['pack', '--verbose', testDir, '--readme', cliReadme],
        {
          cwd: outputDir,
        }
      );

      expect(result).toContain('Creating archive of');
      expect(result).toContain('Archive created successfully');

      // Check if archive was created
      const archivePath = join(outputDir, 'test-priority-1.0.0.tgz');
      expect(existsSync(archivePath)).toBe(true);

      // Extract and verify README.md content
      const extractDir = join(tempDir, 'extract-priority');
      mkdirSync(extractDir);
      await tar.extract({
        file: archivePath,
        cwd: extractDir,
      });

      const extractedReadme = join(extractDir, 'package/README.md');
      expect(existsSync(extractedReadme)).toBe(true);

      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe(
        '# CLI README\nFrom CLI option - should take priority.'
      );
      expect(readmeContent).not.toContain('Pack README');
      expect(readmeContent).not.toContain('Regular README');
    }, 10000);

    it('should handle error when --readme file does not exist', async () => {
      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const nonExistentReadme = join(testSourceDir, 'non-existent-readme.md');

      try {
        await execCliMain(
          ['pack', '--verbose', testSourceDir, '--readme', nonExistentReadme],
          {
            cwd: outputDir,
          }
        );
        // Should not reach here, command should fail
        expect.fail('Command should have failed');
      } catch (error: any) {
        // Check error message in stderr
        expect(error.message).toContain(
          'README replacement file is not found:'
        );
        expect(error.status).toBe(1);
      }
    }, 10000);

    it('should add README.md even when not in files array with --readme option', async () => {
      // Create separate test directory for this test
      const testDir = join(tempDir, 'no-files-test');
      mkdirSync(testDir, { recursive: true });

      // Create package.json without README.md in files array
      const packageJsonNoReadme = {
        name: 'test-no-readme-in-files',
        version: '1.0.0',
        description: 'Test adding README when not in files',
        author: 'Test Author',
        license: 'MIT',
        files: ['index.js'], // README.md not included
      };
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify(packageJsonNoReadme, null, 2)
      );

      writeFileSync(join(testDir, 'index.js'), 'console.log("test");');

      // Create replacement README file
      const replacementReadme = join(testDir, 'README_replacement.md');
      writeFileSync(
        replacementReadme,
        '# Replacement README\nAdded even though not in files array.'
      );

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // Run CLI pack command with --readme option
      const result = await execCliMain(
        ['pack', '--verbose', testDir, '--readme', replacementReadme],
        {
          cwd: outputDir,
        }
      );

      expect(result).toContain('Creating archive of');
      expect(result).toContain('Archive created successfully');

      // Check if archive was created
      const archivePath = join(outputDir, 'test-no-readme-in-files-1.0.0.tgz');
      expect(existsSync(archivePath)).toBe(true);

      // Extract and verify README.md was added
      const extractDir = join(tempDir, 'extract-no-files');
      mkdirSync(extractDir);
      await tar.extract({
        file: archivePath,
        cwd: extractDir,
      });

      const extractedReadme = join(extractDir, 'package/README.md');
      expect(existsSync(extractedReadme)).toBe(true);

      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe(
        '# Replacement README\nAdded even though not in files array.'
      );
    }, 10000);

    it('should handle packages with prepack scripts correctly', async () => {
      const testDir = join(tempDir, 'prepack-test');
      mkdirSync(testDir, { recursive: true });

      // Create package.json with prepack script
      const packageJsonWithPrepack = {
        name: 'test-prepack-package',
        version: '1.0.0',
        scripts: {
          prepack: 'echo "Running prepack script"',
        },
      };
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify(packageJsonWithPrepack, null, 2)
      );

      // Create some test files
      writeFileSync(
        join(testDir, 'index.js'),
        'console.log("Hello from prepack test");'
      );

      const outputDir = join(tempDir, 'prepack-output');
      mkdirSync(outputDir, { recursive: true });

      // Run CLI pack command - this should handle prepack script output correctly
      const result = await execCliMain(
        ['pack', '--verbose', testDir, '--pack-destination', outputDir],
        {
          cwd: tempDir,
        }
      );

      expect(result).toContain('Creating archive of');
      expect(result).toContain('Archive created successfully');

      // Check if archive was created with correct filename despite prepack script output
      const archivePath = join(outputDir, 'test-prepack-package-1.0.0.tgz');
      expect(existsSync(archivePath)).toBe(true);

      // Verify archive contents
      const files: string[] = [];
      await tar.list({
        file: archivePath,
        onentry: (entry: any) => files.push(entry.path),
      });
      expect(files).toContain('package/package.json');
      expect(files).toContain('package/index.js');

      // Extract and verify package.json content
      const extractDir = join(tempDir, 'extract-prepack');
      mkdirSync(extractDir);
      await tar.extract({
        file: archivePath,
        cwd: extractDir,
      });

      const extractedPackageJson = join(extractDir, 'package/package.json');
      expect(existsSync(extractedPackageJson)).toBe(true);
      const packageContent = JSON.parse(
        readFileSync(extractedPackageJson, 'utf-8')
      );
      expect(packageContent.name).toBe('test-prepack-package');
      expect(packageContent.version).toBe('1.0.0');
    }, 10000);
  });

  //////////////////////////////////////////////////////////////////////////////////

  describe('CLI publish command tests', async () => {
    const runPublishCLI = async (args: string[], cwd: string = tempDir) => {
      const fullArgs = ['publish', ...args];
      const result = await execCliMainWithLogging(fullArgs, {
        cwd: cwd,
        env: {
          ...process.env,
          SCREW_UP_TEST_MODE: 'true', // Enable test mode to avoid actual npm publish
        },
      });
      return result;
    };

    it('should publish tarball when no arguments provided', async () => {
      const result = await runPublishCLI(['--verbose'], testSourceDir);

      expect(result.code).toBe(0);
      expect(result.info).toContain('Creating archive of');
      expect(result.info).toContain('TEST_MODE: Would execute: npm publish');
      expect(result.info).toContain('test-package-1.0.0.tgz');
      expect(result.info).toContain('TEST_MODE: Tarball path:');
      expect(result.info).toContain('Successfully published');
    }, 10000);

    it('should publish tarball from directory argument', async () => {
      const result = await runPublishCLI(['--verbose', testSourceDir]);

      expect(result.code).toBe(0);
      expect(result.info).toContain(`Creating archive of ${testSourceDir}`);
      expect(result.info).toContain('TEST_MODE: Would execute: npm publish');
      expect(result.info).toContain('test-package-1.0.0.tgz');
      expect(result.info).toContain('TEST_MODE: Tarball path:');
      expect(result.info).toContain('Successfully published');
    }, 10000);

    it('should publish existing tarball file directly', async () => {
      // First create a tarball file
      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const { packageFileName, metadata } = (await packAssets(
        testSourceDir,
        outputDir,
        true,
        true,
        defaultInheritableFields,
        undefined,
        true,
        '^',
        createConsoleLogger()
      ))!;
      const tarballPath = join(
        outputDir,
        `${metadata.name}-${metadata.version}.tgz`
      );

      // Verify tarball exists
      expect(existsSync(tarballPath)).toBe(true);

      const result = await runPublishCLI([tarballPath]);

      expect(result.code).toBe(0);
      expect(result.info).toContain('TEST_MODE: Would execute: npm publish');
      expect(result.info).toContain(packageFileName);
      expect(result.info).toContain(
        `TEST_MODE: Tarball path: ${resolve(tarballPath)}`
      );
      expect(result.info).toContain('Successfully published');
      // Should not create new archive when given existing tarball
      expect(result.info).not.toContain('Creating archive of');
    }, 10000);

    it('should forward npm publish options', async () => {
      const result = await runPublishCLI([
        testSourceDir,
        '--dry-run',
        '--tag',
        'beta',
        '--access',
        'public',
      ]);

      expect(result.code).toBe(0);
      expect(result.info).toContain('TEST_MODE: Would execute: npm publish');
      expect(result.info).toContain('test-package-1.0.0.tgz');
      expect(result.info).toContain('Successfully published');
    }, 10000);

    it('should handle scoped package names correctly', async () => {
      // Create a scoped package
      const scopedPackageJson = {
        name: '@scope/special-package',
        version: '2.1.0',
      };
      writeFileSync(
        join(testSourceDir, 'package.json'),
        JSON.stringify(scopedPackageJson, null, 2)
      );

      const result = await runPublishCLI([testSourceDir]);

      expect(result.code).toBe(0);
      expect(result.info).toContain('TEST_MODE: Would execute: npm publish');
      // Scoped package names should have '/' replaced with '-' in filename
      expect(result.info).toContain('@scope-special-package-2.1.0.tgz');
      expect(result.info).toContain('Successfully published');
    }, 10000);

    it('should handle boolean options correctly', async () => {
      const result = await runPublishCLI([
        testSourceDir,
        '--dry-run',
        '--force',
      ]);

      expect(result.code).toBe(0);
      expect(result.info).toContain('--dry-run --force');
    }, 10000);

    it('should handle key-value options correctly', async () => {
      const result = await runPublishCLI([
        testSourceDir,
        '--registry',
        'https://custom-registry.com',
        '--tag',
        'alpha',
      ]);

      expect(result.code).toBe(0);
      expect(result.info).toContain(
        '--registry https://custom-registry.com --tag alpha'
      );
    }, 10000);

    it('should handle error when path does not exist', async () => {
      const nonExistentPath = join(tempDir, 'does-not-exist');
      const result = await runPublishCLI([nonExistentPath]);

      expect(result.code).toBe(1);
      expect(result.err).toContain('Path does not exist');
    }, 10000);

    it('should handle error when invalid file type is provided', async () => {
      // Create a non-tarball file
      const invalidFile = join(tempDir, 'invalid.txt');
      writeFileSync(invalidFile, 'not a tarball');

      const result = await runPublishCLI([invalidFile]);

      expect(result.code).toBe(1);
      expect(result.err).toContain(
        'Invalid path - must be a directory or .tgz/.tar.gz file'
      );
    }, 10000);

    it('should handle directory without package.json', async () => {
      // Create directory without package.json
      const emptyDir = join(tempDir, 'empty-no-package');
      mkdirSync(emptyDir);
      writeFileSync(join(emptyDir, 'readme.txt'), 'test file');

      const result = await runPublishCLI([emptyDir]);

      expect(result.code).toBe(1);
      expect(result.err).toContain('no such file or directory');
    }, 10000);

    it('should show help for publish command', async () => {
      const result = await runPublishCLI(['--help']);

      expect(result.info).toContain(
        'Usage: screw-up publish [options] [directory|package.tgz]'
      );
      expect(result.info).toContain('All npm publish options are supported');
    });

    it('should verify tarball path is absolute', async () => {
      // Create tarball in nested directory
      const nestedDir = join(tempDir, 'nested', 'output');
      mkdirSync(nestedDir, { recursive: true });

      const { metadata } = (await packAssets(
        testSourceDir,
        nestedDir,
        true,
        true,
        defaultInheritableFields,
        undefined,
        true,
        '^',
        createConsoleLogger()
      ))!;
      const tarballPath = join(
        nestedDir,
        `${metadata.name}-${metadata.version}.tgz`
      );

      const result = await runPublishCLI([tarballPath]);

      expect(result.code).toBe(0);
      // Should contain absolute path
      expect(result.info).toContain(
        `TEST_MODE: Tarball path: ${resolve(tarballPath)}`
      );
    }, 10000);

    it('should handle workspace packages correctly', async () => {
      // Create workspace root with parent package.json
      const workspaceRoot = join(tempDir, 'workspace-publish');
      mkdirSync(workspaceRoot);

      const rootPackageJson = {
        name: 'workspace-root',
        version: '3.0.0',
        author: 'Workspace Author',
        license: 'Apache-2.0',
        private: true,
        workspaces: ['packages/*'],
      };
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create child package
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });

      const childPackageJson = {
        name: 'workspace-child',
        version: '2.0.0',
        description: 'Child package',
      };
      writeFileSync(
        join(childDir, 'package.json'),
        JSON.stringify(childPackageJson, null, 2)
      );
      writeFileSync(join(childDir, 'index.js'), 'console.log("child");');

      const result = await runPublishCLI(['--verbose', childDir]);

      expect(result.code).toBe(0);
      expect(result.info).toContain('Creating archive of');
      // Should inherit version from workspace root
      expect(result.info).toContain('workspace-child-2.0.0.tgz');
      expect(result.info).toContain('Successfully published');
    }, 10000);
  });

  //////////////////////////////////////////////////////////////////////////////////

  describe('CLI dump command tests', () => {
    it('should dump package.json from current directory when no arguments provided', async () => {
      const result = await execCliMain(['dump'], {
        cwd: testSourceDir,
      });

      // Parse the JSON output
      const packageJson = JSON.parse(result);
      expect(packageJson.name).toBe('test-package');
      expect(packageJson.version).toBe('1.0.0');
    }, 10000);

    it('should dump package.json from specified directory', async () => {
      const result = await execCliMain(['dump', testSourceDir], {
        cwd: tempDir,
      });

      // Parse the JSON output
      const packageJson = JSON.parse(result);
      expect(packageJson.name).toBe('test-package');
      expect(packageJson.version).toBe('1.0.0');
    }, 10000);

    it('should respect --no-wds option', async () => {
      const result = await execCliMain(['dump', testSourceDir, '--no-wds'], {
        cwd: tempDir,
      });

      // Parse the JSON output
      const packageJson = JSON.parse(result);
      expect(packageJson.name).toBe('test-package');
      expect(packageJson.version).toBe('1.0.0');
    }, 10000);

    it('should show help for dump command', async () => {
      const result = await execCliMainWithLogging(['dump', '--help'], {});

      expect(result.info).toContain(
        'Usage: screw-up dump [options] [directory]'
      );
      expect(result.info).toContain('Dump computed package.json as JSON');
      expect(result.info).toContain(
        'directory                     Directory to dump package.json from (default: current directory)'
      );
    });

    it('should handle workspace inheritance in dump', async () => {
      // Create workspace root with parent package.json
      const workspaceRoot = join(tempDir, 'workspace-dump');
      mkdirSync(workspaceRoot);

      const rootPackageJson = {
        name: 'workspace-root',
        version: '2.0.0',
        author: 'Workspace Author',
        license: 'Apache-2.0',
        workspaces: ['packages/*'],
      };
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create child package
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });

      const childPackageJson = {
        name: 'child-package',
        description: 'Child package description',
      };
      writeFileSync(
        join(childDir, 'package.json'),
        JSON.stringify(childPackageJson, null, 2)
      );

      const result = await execCliMain(['dump', childDir], {
        cwd: tempDir,
      });

      // Parse the JSON output
      const packageJson = JSON.parse(result);

      // Verify child overrides
      expect(packageJson.name).toBe('child-package');
      expect(packageJson.description).toBe('Child package description');

      // Verify inherited from parent
      expect(packageJson.version).toBe('2.0.0');
      expect(packageJson.author).toBe('Workspace Author');
      expect(packageJson.license).toBe('Apache-2.0');

      // Workspace field should not be inherited
      expect(packageJson.workspaces).toBeUndefined();
    }, 10000);

    it('should handle error when directory does not exist', async () => {
      const nonExistentDir = join(tempDir, 'does-not-exist');

      try {
        await execCliMain(['dump', nonExistentDir], {
          cwd: tempDir,
        });
        // Should not reach here, command should fail
        expect.fail('Command should have failed');
      } catch (error: any) {
        // Check error message in stderr
        expect(error.message).toContain(
          'dump: Unable to read package.json from'
        );
        expect(error.status).toBe(1);
      }
    });

    it('should handle directory without package.json', async () => {
      // Create directory without package.json
      const emptyDir = join(tempDir, 'empty-no-package-dump');
      mkdirSync(emptyDir);
      writeFileSync(join(emptyDir, 'readme.txt'), 'test file');

      try {
        await execCliMain(['dump', emptyDir], {
          cwd: tempDir,
        });
        // Should not reach here, command should fail
        expect.fail('Command should have failed');
      } catch (error: any) {
        // Check error message in stderr or stdout
        expect(error.message).toContain('dump: Failed to dump package.json');
        expect(error.status).toBe(1);
      }
    }, 10000);

    it('should dump complete package.json with all metadata', async () => {
      // Create comprehensive package.json
      const comprehensivePackageJson = {
        name: 'comprehensive-package',
        version: '3.2.1',
        description: 'A comprehensive test package',
        author: 'Test Author <test@example.com>',
        license: 'MIT',
        keywords: ['test', 'package'],
        repository: {
          type: 'git',
          url: 'https://github.com/test/repo.git',
        },
        dependencies: {
          'test-dep': '^1.0.0',
        },
        devDependencies: {
          'test-dev-dep': '^2.0.0',
        },
        scripts: {
          test: 'echo "test"',
          build: 'echo "build"',
        },
        files: ['dist/**/*', 'README.md'],
      };
      writeFileSync(
        join(testSourceDir, 'package.json'),
        JSON.stringify(comprehensivePackageJson, null, 2)
      );

      const result = await execCliMain(['dump', testSourceDir], {
        cwd: tempDir,
      });

      // Parse the JSON output
      const packageJson = JSON.parse(result);

      // Verify all fields are preserved
      expect(packageJson.name).toBe('comprehensive-package');
      expect(packageJson.version).toBe('3.2.1');
      expect(packageJson.description).toBe('A comprehensive test package');
      expect(packageJson.author).toBe('Test Author <test@example.com>');
      expect(packageJson.license).toBe('MIT');
      expect(packageJson.keywords).toEqual(['test', 'package']);
      expect(packageJson.repository).toEqual({
        type: 'git',
        url: 'https://github.com/test/repo.git',
      });
      expect(packageJson.dependencies).toEqual({
        'test-dep': '^1.0.0',
      });
      expect(packageJson.devDependencies).toEqual({
        'test-dev-dep': '^2.0.0',
      });
      expect(packageJson.scripts).toEqual({
        test: 'echo "test"',
        build: 'echo "build"',
      });
      expect(packageJson.files).toEqual(['dist/**/*', 'README.md']);
    }, 10000);

    it('should output valid JSON format', async () => {
      const result = await execCliMain(['dump', testSourceDir], {
        cwd: tempDir,
      });

      // Should be valid JSON that can be parsed
      expect(() => JSON.parse(result)).not.toThrow();

      // Should be properly formatted (with indentation)
      expect(result).toContain('\n');
      expect(result).toContain('  ');
    }, 10000);
  });

  //////////////////////////////////////////////////////////////////////////////////

  describe('Workspace README replacement tests', () => {
    it('should use workspace root README when specified in parent package.json', async () => {
      // Create workspace root with parent package.json
      const workspaceRoot = join(tempDir, 'workspace-readme');
      mkdirSync(workspaceRoot);

      // Create workspace root README
      const workspaceReadme = join(workspaceRoot, 'README_workspace.md');
      writeFileSync(
        workspaceReadme,
        '# Workspace README\nThis is the workspace-level README file.'
      );

      const rootPackageJson = {
        name: 'workspace-root',
        version: '2.0.0',
        author: 'Workspace Author',
        license: 'Apache-2.0',
        readme: 'README_workspace.md',
        workspaces: ['packages/*'],
      };
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create child package without readme field
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });

      const childPackageJson = {
        name: 'child-package',
        version: '1.5.0',
        description: 'Child package description',
        files: ['**/*'],
      };
      writeFileSync(
        join(childDir, 'package.json'),
        JSON.stringify(childPackageJson, null, 2)
      );
      writeFileSync(join(childDir, 'index.js'), 'console.log("child");');

      // Create child-level README that should be ignored
      const childReadme = join(childDir, 'README.md');
      writeFileSync(
        childReadme,
        '# Child README\nThis should be ignored in favor of workspace README.'
      );

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // Pack child package - should use workspace root's README
      const { packageFileName, metadata } = (await packAssets(
        childDir,
        outputDir,
        true,
        true,
        defaultInheritableFields,
        undefined,
        true,
        '^',
        createConsoleLogger()
      ))!;
      expect(metadata).toBeDefined();
      expect(metadata?.name).toBe('child-package');

      // Extract and verify README.md content
      const archivePath = join(outputDir, packageFileName);
      const extractDir = join(tempDir, 'extract-workspace');
      mkdirSync(extractDir);

      await tar.extract({
        file: archivePath,
        cwd: extractDir,
      });

      const extractedReadme = join(extractDir, 'package/README.md');
      expect(existsSync(extractedReadme)).toBe(true);

      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe(
        '# Workspace README\nThis is the workspace-level README file.'
      );
      expect(readmeContent).not.toContain('Child README');
    }, 10000);

    it('should prioritize child package readme over inherited workspace readme', async () => {
      // Create workspace root with parent package.json
      const workspaceRoot = join(tempDir, 'workspace-priority');
      mkdirSync(workspaceRoot);

      // Create workspace root README
      const workspaceReadme = join(workspaceRoot, 'README_workspace.md');
      writeFileSync(
        workspaceReadme,
        '# Workspace README\nInherited from workspace root.'
      );

      const rootPackageJson = {
        name: 'workspace-root',
        version: '3.0.0',
        author: 'Workspace Author',
        license: 'Apache-2.0',
        readme: 'README_workspace.md',
        workspaces: ['packages/*'],
      };
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create child package WITH its own readme field
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });

      // Create child-specific README
      const childReadme = join(childDir, 'README_child.md');
      writeFileSync(childReadme, '# Child README\nChild-specific README file.');

      const childPackageJson = {
        name: 'child-package',
        version: '2.0.0',
        description: 'Child package description',
        readme: 'README_child.md',
        files: ['**/*'],
      };
      writeFileSync(
        join(childDir, 'package.json'),
        JSON.stringify(childPackageJson, null, 2)
      );
      writeFileSync(join(childDir, 'index.js'), 'console.log("child");');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // Pack child package - should use child's own README, not workspace README
      const { packageFileName, metadata } = (await packAssets(
        childDir,
        outputDir,
        true,
        true,
        defaultInheritableFields,
        undefined,
        true,
        '^',
        createConsoleLogger()
      ))!;
      expect(metadata).toBeDefined();
      expect(metadata?.name).toBe('child-package');

      // Extract and verify README.md content
      const archivePath = join(outputDir, packageFileName);
      const extractDir = join(tempDir, 'extract-priority');
      mkdirSync(extractDir);

      await tar.extract({
        file: archivePath,
        cwd: extractDir,
      });

      const extractedReadme = join(extractDir, 'package/README.md');
      expect(existsSync(extractedReadme)).toBe(true);

      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe('# Child README\nChild-specific README file.');
      expect(readmeContent).not.toContain('Workspace README');
    }, 10000);

    it('should handle CLI --readme option overriding workspace inheritance', async () => {
      // Create workspace root with parent package.json
      const workspaceRoot = join(tempDir, 'workspace-cli-override');
      mkdirSync(workspaceRoot);

      // Create workspace root README
      const workspaceReadme = join(workspaceRoot, 'README_workspace.md');
      writeFileSync(
        workspaceReadme,
        '# Workspace README\nInherited from workspace root.'
      );

      const rootPackageJson = {
        name: 'workspace-root',
        version: '4.0.0',
        author: 'Workspace Author',
        license: 'Apache-2.0',
        readme: 'README_workspace.md',
        workspaces: ['packages/*'],
      };
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create child package without readme field
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });

      const childPackageJson = {
        name: 'child-package',
        version: '2.0.0',
        description: 'Child package description',
        files: ['**/*'],
      };
      writeFileSync(
        join(childDir, 'package.json'),
        JSON.stringify(childPackageJson, null, 2)
      );
      writeFileSync(join(childDir, 'index.js'), 'console.log("child");');

      // Create CLI-specified README
      const cliReadme = join(childDir, 'README_cli.md');
      writeFileSync(
        cliReadme,
        '# CLI README\nSpecified via CLI option - should override workspace inheritance.'
      );

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // Pack child package with CLI option - should use CLI README, not workspace README
      const { packageFileName, metadata } = (await packAssets(
        childDir,
        outputDir,
        true,
        true,
        defaultInheritableFields,
        cliReadme,
        true,
        '^',
        createConsoleLogger()
      ))!;
      expect(metadata).toBeDefined();
      expect(metadata?.name).toBe('child-package');

      // Extract and verify README.md content
      const archivePath = join(outputDir, packageFileName);
      const extractDir = join(tempDir, 'extract-cli-override');
      mkdirSync(extractDir);

      await tar.extract({
        file: archivePath,
        cwd: extractDir,
      });

      const extractedReadme = join(extractDir, 'package/README.md');
      expect(existsSync(extractedReadme)).toBe(true);

      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe(
        '# CLI README\nSpecified via CLI option - should override workspace inheritance.'
      );
      expect(readmeContent).not.toContain('Workspace README');
    }, 10000);

    it('should use --inheritable-fields CLI option in pack command', async () => {
      // Create workspace root with parent package.json
      const workspaceRoot = join(tempDir, 'workspace-cli-fields');
      mkdirSync(workspaceRoot);

      const rootPackageJson = {
        name: 'workspace-root',
        version: '2.5.0',
        author: 'Workspace Author',
        license: 'Apache-2.0',
        description: 'Root description',
        keywords: ['root', 'workspace'],
        homepage: 'https://workspace.example.com',
        workspaces: ['packages/*'],
      };
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create child package
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });

      const childPackageJson = {
        name: 'child-package',
        version: '1.5.0',
        // description and homepage should be inherited from parent
      };
      writeFileSync(
        join(childDir, 'package.json'),
        JSON.stringify(childPackageJson, null, 2)
      );
      writeFileSync(join(childDir, 'index.js'), 'console.log("child");');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // Run CLI pack command with custom --inheritable-fields (only description and homepage)
      const result = await execCliMain(
        [
          'pack',
          '--verbose',
          childDir,
          '--inheritable-fields',
          'description,homepage',
        ],
        {
          cwd: outputDir,
        }
      );

      expect(result).toContain('Creating archive of');
      expect(result).toContain('Archive created successfully');

      // Extract and verify package.json content
      const archivePath = join(outputDir, 'child-package-1.5.0.tgz');
      const extractDir = join(tempDir, 'extract-cli-fields');
      mkdirSync(extractDir);

      await tar.extract({
        file: archivePath,
        cwd: extractDir,
      });

      const extractedPackageJsonPath = join(extractDir, 'package/package.json');
      const extractedPackageJson = JSON.parse(
        readFileSync(extractedPackageJsonPath, 'utf-8')
      );

      // Verify child name is preserved
      expect(extractedPackageJson.name).toBe('child-package');

      // Verify only specified fields are inherited
      expect(extractedPackageJson.description).toBe('Root description'); // Should be inherited
      expect(extractedPackageJson.homepage).toBe(
        'https://workspace.example.com'
      ); // Should be inherited

      // Verify other fields are NOT inherited
      expect(extractedPackageJson.author).toBeUndefined();
      expect(extractedPackageJson.license).toBeUndefined();
      expect(extractedPackageJson.keywords).toBeUndefined();
      expect(extractedPackageJson.workspaces).toBeUndefined();
    }, 10000);

    it('should use --inheritable-fields CLI option in publish command', async () => {
      // Create workspace root with parent package.json
      const workspaceRoot = join(tempDir, 'workspace-publish-fields');
      mkdirSync(workspaceRoot);

      const rootPackageJson = {
        name: 'workspace-root',
        version: '3.5.0',
        author: 'Workspace Author',
        license: 'MIT',
        description: 'Root description',
        repository: 'https://github.com/test/repo.git',
        workspaces: ['packages/*'],
      };
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create child package
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });

      const childPackageJson = {
        name: 'child-package',
        version: '2.5.0',
      };
      writeFileSync(
        join(childDir, 'package.json'),
        JSON.stringify(childPackageJson, null, 2)
      );
      writeFileSync(join(childDir, 'index.js'), 'console.log("child");');

      // Run CLI publish command with custom --inheritable-fields
      const result = await execCliMain(
        [
          'publish',
          childDir,
          '--verbose',
          '--inheritable-fields',
          'description,license,repository',
          '--dry-run',
        ],
        {
          cwd: tempDir,
          env: {
            ...process.env,
            SCREW_UP_TEST_MODE: 'true',
          },
        }
      );

      expect(result).toContain('Creating archive of');
      expect(result).toContain('TEST_MODE: Would execute: npm publish');
      expect(result).toContain('child-package-2.5.0.tgz');
      expect(result).toContain('--dry-run'); // verbose and inheritable-fields should not be passed to npm
      expect(result).toContain('Successfully published');
    }, 10000);

    it('should use --inheritable-fields CLI option in dump command', async () => {
      // Create workspace root with parent package.json
      const workspaceRoot = join(tempDir, 'workspace-dump-fields');
      mkdirSync(workspaceRoot);

      const rootPackageJson = {
        name: 'workspace-root',
        version: '4.5.0',
        author: 'Workspace Author',
        license: 'BSD-3-Clause',
        description: 'Root description',
        keywords: ['test', 'workspace'],
        workspaces: ['packages/*'],
      };
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create child package
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });

      const childPackageJson = {
        name: 'child-package',
        description: 'Child description override',
      };
      writeFileSync(
        join(childDir, 'package.json'),
        JSON.stringify(childPackageJson, null, 2)
      );

      // Run CLI dump command with custom --inheritable-fields (only author and keywords)
      const result = await execCliMain(
        [
          'dump',
          childDir,
          '--verbose',
          '--inheritable-fields',
          'author,keywords',
        ],
        {
          cwd: tempDir,
        }
      );

      // Parse the JSON output
      const packageJson = JSON.parse(result);

      // Verify child overrides
      expect(packageJson.name).toBe('child-package');
      expect(packageJson.description).toBe('Child description override');

      // Verify only specified fields are inherited
      expect(packageJson.author).toBe('Workspace Author');
      expect(packageJson.keywords).toEqual(['test', 'workspace']);

      // Verify other fields are NOT inherited
      expect(packageJson.version).toBeUndefined();
      expect(packageJson.license).toBeUndefined();
      expect(packageJson.workspaces).toBeUndefined();
    }, 10000);

    it('should handle empty --inheritable-fields option', async () => {
      // Create workspace root with parent package.json
      const workspaceRoot = join(tempDir, 'workspace-empty-fields');
      mkdirSync(workspaceRoot);

      const rootPackageJson = {
        name: 'workspace-root',
        version: '5.0.0',
        author: 'Workspace Author',
        license: 'MIT',
        workspaces: ['packages/*'],
      };
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create child package
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });

      const childPackageJson = {
        name: 'child-package',
        version: '1.0.0',
      };
      writeFileSync(
        join(childDir, 'package.json'),
        JSON.stringify(childPackageJson, null, 2)
      );
      writeFileSync(join(childDir, 'index.js'), 'console.log("child");');

      // Run CLI dump command with empty --inheritable-fields (no inheritance)
      const result = await execCliMain(
        ['dump', childDir, '--inheritable-fields', ''],
        {
          cwd: tempDir,
        }
      );

      // Parse the JSON output
      const packageJson = JSON.parse(result);

      // Verify only child package fields (no inheritance)
      expect(packageJson.name).toBe('child-package');
      expect(packageJson.version).toBe('1.0.0');

      // Verify no fields are inherited from parent
      expect(packageJson.author).toBeUndefined();
      expect(packageJson.license).toBeUndefined();
      expect(packageJson.workspaces).toBeUndefined();
    }, 10000);
  });

  //////////////////////////////////////////////////////////////////////////////////

  describe('peerDependencies replacement', () => {
    it('should replace "*" in peerDependencies with workspace sibling versions using packAssets', async () => {
      // Create workspace root
      const workspaceRoot = join(tempDir, 'workspace-peer-deps');
      mkdirSync(workspaceRoot);

      const rootPackageJson = {
        name: 'workspace-root',
        version: '1.0.0',
        workspaces: ['packages/*'],
      };
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create core package (sibling)
      const coreDir = join(workspaceRoot, 'packages', 'core');
      mkdirSync(coreDir, { recursive: true });
      const corePackageJson = {
        name: '@test/core',
        version: '2.5.3',
      };
      writeFileSync(
        join(coreDir, 'package.json'),
        JSON.stringify(corePackageJson, null, 2)
      );
      writeFileSync(join(coreDir, 'index.js'), 'module.exports = {};');

      // Create cli package with peerDependencies
      const cliDir = join(workspaceRoot, 'packages', 'cli');
      mkdirSync(cliDir, { recursive: true });
      const cliPackageJson = {
        name: '@test/cli',
        version: '1.0.0',
        peerDependencies: {
          '@test/core': '*',
          react: '^18.0.0', // Non-workspace dependency should remain unchanged
        },
      };
      writeFileSync(
        join(cliDir, 'package.json'),
        JSON.stringify(cliPackageJson, null, 2)
      );
      writeFileSync(join(cliDir, 'cli.js'), 'console.log("cli");');

      // Pack the cli package
      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const { packageFileName, metadata } = (await packAssets(
        cliDir,
        outputDir,
        true,
        true,
        defaultInheritableFields,
        undefined,
        true,
        '^',
        createConsoleLogger()
      ))!;

      expect(metadata).toBeDefined();
      expect(metadata.name).toBe('@test/cli');

      // Verify that the packaged file exists
      const archivePath = join(outputDir, packageFileName);
      expect(existsSync(archivePath)).toBe(true);

      // Extract and verify package.json
      const extractDir = join(tempDir, 'extracted');
      mkdirSync(extractDir, { recursive: true });

      tar.extract({
        file: archivePath,
        cwd: extractDir,
        sync: true,
      });

      const extractedPackageJsonPath = join(
        extractDir,
        'package',
        'package.json'
      );
      expect(existsSync(extractedPackageJsonPath)).toBe(true);

      const extractedPackageJson = JSON.parse(
        readFileSync(extractedPackageJsonPath, 'utf-8')
      );

      // Verify peerDependencies replacement
      expect(extractedPackageJson.peerDependencies['@test/core']).toBe(
        '^2.5.3'
      );
      expect(extractedPackageJson.peerDependencies['react']).toBe('^18.0.0'); // Should remain unchanged
    }, 10000);

    it('should support custom version prefix using packAssets', async () => {
      // Create workspace root
      const workspaceRoot = join(tempDir, 'workspace-custom-prefix');
      mkdirSync(workspaceRoot);

      const rootPackageJson = {
        name: 'workspace-root',
        version: '1.0.0',
        workspaces: ['packages/*'],
      };
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create core package (sibling)
      const coreDir = join(workspaceRoot, 'packages', 'core');
      mkdirSync(coreDir, { recursive: true });
      const corePackageJson = {
        name: '@test/core',
        version: '1.2.3',
      };
      writeFileSync(
        join(coreDir, 'package.json'),
        JSON.stringify(corePackageJson, null, 2)
      );
      writeFileSync(join(coreDir, 'index.js'), 'module.exports = {};');

      // Create plugin package with peerDependencies
      const pluginDir = join(workspaceRoot, 'packages', 'plugin');
      mkdirSync(pluginDir, { recursive: true });
      const pluginPackageJson = {
        name: '@test/plugin',
        version: '0.5.0',
        peerDependencies: {
          '@test/core': '*',
        },
      };
      writeFileSync(
        join(pluginDir, 'package.json'),
        JSON.stringify(pluginPackageJson, null, 2)
      );
      writeFileSync(join(pluginDir, 'plugin.js'), 'console.log("plugin");');

      // Pack the plugin package with tilde prefix
      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const result = await packAssets(
        pluginDir,
        outputDir,
        true,
        true,
        defaultInheritableFields,
        undefined,
        true,
        '~',
        createConsoleLogger()
      );

      expect(result).toBeDefined();

      // Extract and verify package.json
      const archivePath = join(outputDir, result!.packageFileName);
      const extractDir = join(tempDir, 'extracted');
      mkdirSync(extractDir, { recursive: true });

      tar.extract({
        file: archivePath,
        cwd: extractDir,
        sync: true,
      });

      const extractedPackageJson = JSON.parse(
        readFileSync(join(extractDir, 'package', 'package.json'), 'utf-8')
      );

      // Verify tilde prefix is used
      expect(extractedPackageJson.peerDependencies['@test/core']).toBe(
        '~1.2.3'
      );
    }, 10000);

    it('should skip replacement when feature is disabled using packAssets', async () => {
      // Create workspace root
      const workspaceRoot = join(tempDir, 'workspace-disabled');
      mkdirSync(workspaceRoot);

      const rootPackageJson = {
        name: 'workspace-root',
        version: '1.0.0',
        workspaces: ['packages/*'],
      };
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create core package (sibling)
      const coreDir = join(workspaceRoot, 'packages', 'core');
      mkdirSync(coreDir, { recursive: true });
      const corePackageJson = {
        name: '@test/core',
        version: '3.0.0',
      };
      writeFileSync(
        join(coreDir, 'package.json'),
        JSON.stringify(corePackageJson, null, 2)
      );

      // Create test package with peerDependencies
      const testDir = join(workspaceRoot, 'packages', 'test');
      mkdirSync(testDir, { recursive: true });
      const testPackageJson = {
        name: '@test/test',
        version: '1.0.0',
        peerDependencies: {
          '@test/core': '*',
        },
      };
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify(testPackageJson, null, 2)
      );
      writeFileSync(join(testDir, 'test.js'), 'console.log("test");');

      // Pack with feature disabled
      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const result = await packAssets(
        testDir,
        outputDir,
        true,
        true,
        defaultInheritableFields,
        undefined,
        false,
        '^',
        createConsoleLogger()
      );

      expect(result).toBeDefined();

      // Extract and verify package.json
      const archivePath = join(outputDir, '@test-test-1.0.0.tgz');
      const extractDir = join(tempDir, 'extracted');
      mkdirSync(extractDir, { recursive: true });

      tar.extract({
        file: archivePath,
        cwd: extractDir,
        sync: true,
      });

      const extractedPackageJson = JSON.parse(
        readFileSync(join(extractDir, 'package', 'package.json'), 'utf-8')
      );

      // Verify "*" remains unchanged
      expect(extractedPackageJson.peerDependencies['@test/core']).toBe('*');
    }, 10000);

    it('should replace peerDependencies via CLI with default options', async () => {
      // Create workspace root
      const workspaceRoot = join(tempDir, 'workspace-cli-default');
      mkdirSync(workspaceRoot);

      const rootPackageJson = {
        name: 'workspace-root',
        version: '1.0.0',
        workspaces: ['packages/*'],
      };
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create core package
      const coreDir = join(workspaceRoot, 'packages', 'core');
      mkdirSync(coreDir, { recursive: true });
      const corePackageJson = {
        name: '@workspace/core',
        version: '4.1.2',
      };
      writeFileSync(
        join(coreDir, 'package.json'),
        JSON.stringify(corePackageJson, null, 2)
      );
      writeFileSync(join(coreDir, 'index.js'), 'module.exports = {};');

      // Create cli package
      const cliDir = join(workspaceRoot, 'packages', 'cli');
      mkdirSync(cliDir, { recursive: true });
      const cliPackageJson = {
        name: '@workspace/cli',
        version: '2.0.0',
        peerDependencies: {
          '@workspace/core': '*',
        },
        files: ['*.js', '*.json'],
      };
      writeFileSync(
        join(cliDir, 'package.json'),
        JSON.stringify(cliPackageJson, null, 2)
      );
      writeFileSync(join(cliDir, 'cli.js'), 'console.log("cli");');

      // Run CLI pack command (default behavior should replace)
      const outputDir = join(tempDir, 'output');
      const result = await execCliMain(
        ['pack', cliDir, '--pack-destination', outputDir],
        {}
      );

      // Extract and verify
      const archivePath = join(outputDir, '@workspace-cli-2.0.0.tgz');
      expect(existsSync(archivePath)).toBe(true);

      const extractDir = join(tempDir, 'extracted');
      mkdirSync(extractDir, { recursive: true });

      tar.extract({
        file: archivePath,
        cwd: extractDir,
        sync: true,
      });

      const extractedPackageJson = JSON.parse(
        readFileSync(join(extractDir, 'package', 'package.json'), 'utf-8')
      );

      // Verify default prefix "^" is used
      expect(extractedPackageJson.peerDependencies['@workspace/core']).toBe(
        '^4.1.2'
      );
    }, 15000);

    it('should disable peerDependencies replacement via CLI --no-replace-peer-deps', async () => {
      // Create workspace root
      const workspaceRoot = join(tempDir, 'workspace-cli-disabled');
      mkdirSync(workspaceRoot);

      const rootPackageJson = {
        name: 'workspace-root',
        version: '1.0.0',
        workspaces: ['packages/*'],
      };
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create core package
      const coreDir = join(workspaceRoot, 'packages', 'core');
      mkdirSync(coreDir, { recursive: true });
      const corePackageJson = {
        name: '@workspace/core',
        version: '5.0.0',
      };
      writeFileSync(
        join(coreDir, 'package.json'),
        JSON.stringify(corePackageJson, null, 2)
      );

      // Create plugin package
      const pluginDir = join(workspaceRoot, 'packages', 'plugin');
      mkdirSync(pluginDir, { recursive: true });
      const pluginPackageJson = {
        name: '@workspace/plugin',
        version: '1.0.0',
        peerDependencies: {
          '@workspace/core': '*',
        },
        files: ['*.js'],
      };
      writeFileSync(
        join(pluginDir, 'package.json'),
        JSON.stringify(pluginPackageJson, null, 2)
      );
      writeFileSync(join(pluginDir, 'plugin.js'), 'console.log("plugin");');

      // Run CLI pack command with --no-replace-peer-deps
      const outputDir = join(tempDir, 'output');
      const result = await execCliMain(
        [
          'pack',
          pluginDir,
          '--pack-destination',
          outputDir,
          '--no-replace-peer-deps',
        ],
        {}
      );

      // Extract and verify
      const archivePath = join(outputDir, '@workspace-plugin-1.0.0.tgz');
      const extractDir = join(tempDir, 'extracted');
      mkdirSync(extractDir, { recursive: true });

      tar.extract({
        file: archivePath,
        cwd: extractDir,
        sync: true,
      });

      const extractedPackageJson = JSON.parse(
        readFileSync(join(extractDir, 'package', 'package.json'), 'utf-8')
      );

      // Verify "*" remains unchanged
      expect(extractedPackageJson.peerDependencies['@workspace/core']).toBe(
        '*'
      );
    }, 15000);

    it('should use custom prefix via CLI --peer-deps-prefix', async () => {
      // Create workspace root
      const workspaceRoot = join(tempDir, 'workspace-cli-prefix');
      mkdirSync(workspaceRoot);

      const rootPackageJson = {
        name: 'workspace-root',
        version: '1.0.0',
        workspaces: ['packages/*'],
      };
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create utils package
      const utilsDir = join(workspaceRoot, 'packages', 'utils');
      mkdirSync(utilsDir, { recursive: true });
      const utilsPackageJson = {
        name: '@workspace/utils',
        version: '3.2.1',
      };
      writeFileSync(
        join(utilsDir, 'package.json'),
        JSON.stringify(utilsPackageJson, null, 2)
      );

      // Create client package
      const clientDir = join(workspaceRoot, 'packages', 'client');
      mkdirSync(clientDir, { recursive: true });
      const clientPackageJson = {
        name: '@workspace/client',
        version: '1.5.0',
        peerDependencies: {
          '@workspace/utils': '*',
        },
        files: ['client.js'],
      };
      writeFileSync(
        join(clientDir, 'package.json'),
        JSON.stringify(clientPackageJson, null, 2)
      );
      writeFileSync(join(clientDir, 'client.js'), 'console.log("client");');

      // Run CLI pack command with --peer-deps-prefix
      const outputDir = join(tempDir, 'output');
      const result = await execCliMain(
        [
          'pack',
          clientDir,
          '--pack-destination',
          outputDir,
          '--peer-deps-prefix',
          '>=',
        ],
        {}
      );

      // Extract and verify
      const archivePath = join(outputDir, '@workspace-client-1.5.0.tgz');
      const extractDir = join(tempDir, 'extracted');
      mkdirSync(extractDir, { recursive: true });

      tar.extract({
        file: archivePath,
        cwd: extractDir,
        sync: true,
      });

      const extractedPackageJson = JSON.parse(
        readFileSync(join(extractDir, 'package', 'package.json'), 'utf-8')
      );

      // Verify ">=" prefix is used
      expect(extractedPackageJson.peerDependencies['@workspace/utils']).toBe(
        '>=3.2.1'
      );
    }, 15000);

    it('should use exact version with empty prefix via CLI', async () => {
      // Create workspace root
      const workspaceRoot = join(tempDir, 'workspace-cli-exact');
      mkdirSync(workspaceRoot);

      const rootPackageJson = {
        name: 'workspace-root',
        version: '1.0.0',
        workspaces: ['packages/*'],
      };
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create shared package
      const sharedDir = join(workspaceRoot, 'packages', 'shared');
      mkdirSync(sharedDir, { recursive: true });
      const sharedPackageJson = {
        name: '@workspace/shared',
        version: '2.1.0',
      };
      writeFileSync(
        join(sharedDir, 'package.json'),
        JSON.stringify(sharedPackageJson, null, 2)
      );

      // Create app package
      const appDir = join(workspaceRoot, 'packages', 'app');
      mkdirSync(appDir, { recursive: true });
      const appPackageJson = {
        name: '@workspace/app',
        version: '1.0.0',
        peerDependencies: {
          '@workspace/shared': '*',
        },
        files: ['app.js'],
      };
      writeFileSync(
        join(appDir, 'package.json'),
        JSON.stringify(appPackageJson, null, 2)
      );
      writeFileSync(join(appDir, 'app.js'), 'console.log("app");');

      // Run CLI pack command with empty prefix (exact version)
      const outputDir = join(tempDir, 'output');
      const result = await execCliMain(
        [
          'pack',
          appDir,
          '--pack-destination',
          outputDir,
          '--peer-deps-prefix',
          '',
        ],
        {}
      );

      // Extract and verify
      const archivePath = join(outputDir, '@workspace-app-1.0.0.tgz');
      const extractDir = join(tempDir, 'extracted');
      mkdirSync(extractDir, { recursive: true });

      tar.extract({
        file: archivePath,
        cwd: extractDir,
        sync: true,
      });

      const extractedPackageJson = JSON.parse(
        readFileSync(join(extractDir, 'package', 'package.json'), 'utf-8')
      );

      // Verify exact version (no prefix)
      expect(extractedPackageJson.peerDependencies['@workspace/shared']).toBe(
        '2.1.0'
      );
    }, 15000);

    it('should use Git tag version for workspace siblings in peerDependencies', async () => {
      // Create workspace root
      const workspaceRoot = join(tempDir, 'workspace-git-tag');
      mkdirSync(workspaceRoot);

      // Initialize git repo first
      execSync('git init', { cwd: workspaceRoot });
      execSync('git config user.email "test@example.com"', {
        cwd: workspaceRoot,
      });
      execSync('git config user.name "Test User"', { cwd: workspaceRoot });

      const rootPackageJson = {
        name: 'workspace-root',
        version: '1.0.0',
        workspaces: ['packages/*'],
      };
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify(rootPackageJson, null, 2)
      );

      // Create core package with low version in package.json
      const coreDir = join(workspaceRoot, 'packages', 'core');
      mkdirSync(coreDir, { recursive: true });
      const corePackageJson = {
        name: '@git-test/core',
        version: '0.0.1', // Low version in package.json
        main: 'index.js',
      };
      writeFileSync(
        join(coreDir, 'package.json'),
        JSON.stringify(corePackageJson, null, 2)
      );
      writeFileSync(join(coreDir, 'index.js'), 'module.exports = {};');

      // Create plugin package with peerDependencies
      const pluginDir = join(workspaceRoot, 'packages', 'plugin');
      mkdirSync(pluginDir, { recursive: true });
      const pluginPackageJson = {
        name: '@git-test/plugin',
        version: '0.0.1',
        peerDependencies: {
          '@git-test/core': '*',
        },
        files: ['plugin.js'],
      };
      writeFileSync(
        join(pluginDir, 'package.json'),
        JSON.stringify(pluginPackageJson, null, 2)
      );
      writeFileSync(join(pluginDir, 'plugin.js'), 'console.log("plugin");');

      // Commit and add Git tags
      execSync('git add .', { cwd: workspaceRoot });
      execSync('git commit -m "Initial commit"', { cwd: workspaceRoot });

      // Tag with version 3.5.0 (all packages in the workspace will use this version)
      execSync('git tag 3.5.0', { cwd: workspaceRoot });

      // Run CLI pack command from workspace root
      const outputDir = join(tempDir, 'output');
      await execCliMain(
        ['pack', pluginDir, '--pack-destination', outputDir],
        {}
      );

      // Check what files were created
      const files = readdirSync(outputDir);

      // Find the actual created file
      const createdFile = files.find((f) => f.endsWith('.tgz'));
      expect(createdFile).toBeDefined();

      // Extract and verify
      const archivePath = join(outputDir, createdFile!);

      const extractDir = join(tempDir, 'extracted');
      mkdirSync(extractDir, { recursive: true });

      tar.extract({
        file: archivePath,
        cwd: extractDir,
        sync: true,
      });

      const extractedPackageJson = JSON.parse(
        readFileSync(join(extractDir, 'package', 'package.json'), 'utf-8')
      );

      // Verify Git tag version is used in peerDependencies (not the 0.0.1 from package.json)
      expect(extractedPackageJson.peerDependencies['@git-test/core']).toBe(
        '^3.5.0'
      );
    }, 15000);
  });
});
