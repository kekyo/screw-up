import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join, relative, resolve } from 'path';
import { tmpdir } from 'os';
import { execSync, spawn } from 'child_process';
import * as tar from 'tar';
import dayjs from 'dayjs';
import { packAssets } from '../src/cli-internal.js';

const CLI_PATH = join(__dirname, '../dist/cli.js');

describe('CLI tests', () => {
  const tempBaseDir = join(tmpdir(), 'screw-up', 'cli-test', dayjs().format('YYYYMMDD_HHmmssSSS'));
  
  let tempDir: string;
  let testSourceDir: string;

  beforeEach(fn => {
    tempDir = join(tempBaseDir, fn.task.name);
    testSourceDir = join(tempDir, 'source');
    mkdirSync(testSourceDir, { recursive: true });
    
    // Create basic package.json for most tests
    const basicPackage = {
      name: 'test-package',
      version: '1.0.0'
    };
    writeFileSync(join(testSourceDir, 'package.json'), JSON.stringify(basicPackage, null, 2));
    
    // Create test files
    writeFileSync(join(testSourceDir, 'file1.txt'), 'Test content 1\n');
    writeFileSync(join(testSourceDir, 'file2.js'), 'console.log("test");\n');
    
    // Create subdirectory with files
    const subDir = join(testSourceDir, 'subdir');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'nested.json'), '{"test": true}\n');
  });

  const runCLI = (command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: tempDir,
        env: { ...process.env }
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

  const expectCLISuccess = (result: { stdout: string; stderr: string; exitCode: number }, expectStderr: boolean = false) => {
    if (result.exitCode !== 0) {
      const errorMessage = [
        `CLI command failed with exit code ${result.exitCode}`,
        `STDOUT: ${result.stdout}`,
        `STDERR: ${result.stderr}`
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

      const metadata = await packAssets(targetDir, outputDir, true);
      expect(metadata).toBeDefined();
      expect(metadata?.name).toBe('test-package');
      expect(metadata?.version).toBe('1.0.0');

      // Check if test-package-1.0.0.tgz was created
      const archivePath = join(outputDir, 'test-package-1.0.0.tgz');
      expect(existsSync(archivePath)).toBe(true);

      // Extract archive
      const extractDir = join(tempDir, 'extract');
      mkdirSync(extractDir);
      await tar.extract({
        file: archivePath,
        cwd: extractDir
      });

      // Compare and verify archive contents each file by file
      const result = await runCLI('diff', ['-r', relative(tempDir, targetDir), relative(tempDir, extractDir)]);
      expectCLISuccess(result);
    });

    it('should pack workspace assets into a tar archive', async () => {
      // Create workspace root with parent package.json
      const workspaceRoot = join(tempDir, 'workspace');
      mkdirSync(workspaceRoot);
      
      const rootPackageJson = {
        name: 'workspace-root',
        version: '2.0.0',
        author: 'Workspace Author',
        license: 'Apache-2.0',
        private: true,
        workspaces: ['packages/*']
      };
      writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify(rootPackageJson, null, 2));

      // Create child package
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });
      
      const childPackageJson = {
        name: 'child-package',
        description: 'Child package description'
      };
      writeFileSync(join(childDir, 'package.json'), JSON.stringify(childPackageJson, null, 2));
      
      // Add test files to child
      writeFileSync(join(childDir, 'index.js'), 'console.log("child");');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });
      
      const workspaceArchived = await packAssets(workspaceRoot, outputDir, true);
      expect(workspaceArchived).toBeUndefined();

      // Check workspace archive was not created
      const workspaceArchivePath = join(outputDir, 'workspace-root-2.0.0.tgz');
      expect(existsSync(workspaceArchivePath)).toBe(false);

      const childArchived = await packAssets(childDir, outputDir, true);
      expect(childArchived).toBeDefined();
      expect(childArchived?.name).toBe('child-package');
      expect(childArchived?.version).toBe('2.0.0');

      // Check child package archive was created
      const childArchivePath = join(outputDir, 'child-package-2.0.0.tgz');
      expect(existsSync(childArchivePath)).toBe(true);

      // Extract archive  
      const extractDir = join(tempDir, 'extract');
      mkdirSync(extractDir);
      await tar.extract({
        file: childArchivePath,
        cwd: extractDir
      });

      // Compare and verify child package archive contents each file by file
      const result = await runCLI('diff', ['-r', relative(tempDir, childDir), relative(tempDir, extractDir)]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('diff -r workspace/packages/child/package.json extract/package.json\n1a2,4\n>   "version": "2.0.0",\n>   "author": "Workspace Author",\n>   "license": "Apache-2.0",\n');
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
        workspaces: ['packages/*']
      };
      writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify(rootPackageJson, null, 2));

      // Create child package
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });
      
      const childPackageJson = {
        name: 'child-package',
        description: 'Child package description'
      };
      writeFileSync(join(childDir, 'package.json'), JSON.stringify(childPackageJson, null, 2));

      // Add test files to child
      writeFileSync(join(childDir, 'index.js'), 'console.log("child");');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const childArchived = await packAssets(childDir, outputDir, true);
      expect(childArchived).toBeDefined();
      expect(childArchived?.name).toBe('child-package');
      expect(childArchived?.version).toBe('2.0.0');

      // Extract and verify inherited metadata
      const archivePath = join(outputDir, 'child-package-2.0.0.tgz');
      const extractDir = join(tempDir, 'extract-child');
      mkdirSync(extractDir);

      await tar.extract({
        file: archivePath,
        cwd: extractDir
      });

      const extractedPackageJsonPath = join(extractDir, 'package.json');
      expect(existsSync(extractedPackageJsonPath)).toBe(true);

      const extractedPackageJson = JSON.parse(readFileSync(extractedPackageJsonPath, 'utf-8'));
      
      // Verify child overrides
      expect(extractedPackageJson.name).toBe('child-package');
      expect(extractedPackageJson.description).toBe('Child package description');
      
      // Verify inherited from parent
      expect(extractedPackageJson.version).toBe('2.0.0');
      expect(extractedPackageJson.author).toBe('Workspace Author');
      expect(extractedPackageJson.license).toBe('Apache-2.0');
      
      // Workspace field should not be inherited
      expect(extractedPackageJson.workspaces).toBeUndefined();
    }, 10000);
  });

  //////////////////////////////////////////////////////////////////////////////////

  describe('CLI pack command tests', () => {
    it('should pack current directory when no arguments provided', async () => {
      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });
      
      // Run CLI pack command from the output directory
      const result = execSync(`node "${CLI_PATH}" pack "${testSourceDir}"`, {
        cwd: outputDir,
        encoding: 'utf-8'
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
        onentry: (entry: any) => files.push(entry.path)
      });
      expect(files).toContain('package.json');
      expect(files).toContain('file1.txt');
      expect(files).toContain('file2.js');
      expect(files).toContain('subdir/nested.json');
    }, 10000);

    it('should pack specified directory', async () => {
      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // Run CLI pack command with specific directory
      const result = execSync(`node "${CLI_PATH}" pack "${testSourceDir}"`, {
        cwd: outputDir,
        encoding: 'utf-8'
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
        cwd: extractDir
      });

      expect(existsSync(join(extractDir, 'file1.txt'))).toBe(true);
      expect(existsSync(join(extractDir, 'file2.js'))).toBe(true);
      expect(existsSync(join(extractDir, 'subdir', 'nested.json'))).toBe(true);

      const content1 = readFileSync(join(extractDir, 'file1.txt'), 'utf-8');
      expect(content1).toBe('Test content 1\n');

      const content2 = readFileSync(join(extractDir, 'subdir', 'nested.json'), 'utf-8');
      expect(content2).toBe('{"test": true}\n');
    }, 10000);

    it('should use --pack-destination option to specify output directory', async () => {
      const outputDir = join(tempDir, 'custom-output');
      mkdirSync(outputDir, { recursive: true });

      // Run CLI pack command with --pack-destination
      const result = execSync(`node "${CLI_PATH}" pack "${testSourceDir}" --pack-destination "${outputDir}"`, {
        cwd: tempDir,
        encoding: 'utf-8'
      });

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
        onentry: (entry: any) => files.push(entry.path)
      });
      expect(files).toContain('package.json');
      expect(files).toContain('file1.txt');
      expect(files).toContain('file2.js');
      expect(files).toContain('subdir/nested.json');
    }, 10000);

    it('should handle relative paths in --pack-destination', async () => {
      const outputDir = join(tempDir, 'relative-test');
      mkdirSync(outputDir);

      // Run from a different directory with relative path
      const relativeOutputDir = 'output';
      const fullOutputDir = join(outputDir, relativeOutputDir);
      mkdirSync(fullOutputDir);

      const result = execSync(`node "${CLI_PATH}" pack "${testSourceDir}" --pack-destination "${relativeOutputDir}"`, {
        cwd: outputDir,
        encoding: 'utf-8'
      });

      expect(result).toContain('Archive created successfully');

      // Check if test-package-1.0.0.tgz was created in the relative path
      const archivePath = join(fullOutputDir, 'test-package-1.0.0.tgz');
      expect(existsSync(archivePath)).toBe(true);
    }, 10000);

    it('should show help for pack command', () => {
      const result = execSync(`node "${CLI_PATH}" pack --help`, {
        encoding: 'utf-8'
      });

      expect(result).toContain('Usage: screw-up <command> [options]');
      expect(result).toContain('pack [directory]              Pack the project into a tar archive');
      expect(result).toContain('--pack-destination <path>     Directory to write the tarball');
    });

    it('should handle empty directory', async () => {
      const emptyDir = join(tempDir, 'empty');
      mkdirSync(emptyDir);
      
      // Create basic package.json for empty directory test
      const emptyPackageJson = {
        name: 'empty-package',
        version: '1.0.0'
      };
      writeFileSync(join(emptyDir, 'package.json'), JSON.stringify(emptyPackageJson, null, 2));
      
      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const result = execSync(`node "${CLI_PATH}" pack "${emptyDir}"`, {
        cwd: outputDir,
        encoding: 'utf-8'
      });

      expect(result).toContain('Archive created successfully');

      // Check if empty-package-1.0.0.tgz was created
      const archivePath = join(outputDir, 'empty-package-1.0.0.tgz');
      expect(existsSync(archivePath)).toBe(true);

      // Verify archive contains at least the directory entry
      const files: string[] = [];
      await tar.list({ 
        file: archivePath,
        onentry: (entry: any) => files.push(entry.path)
      });
      expect(files).toContain('package.json');
    }, 10000);

    it('should handle files with special characters', async () => {
      const specialDir = join(tempDir, 'special');
      mkdirSync(specialDir);
      
      // Create basic package.json for special directory test
      const specialPackageJson = {
        name: 'special-package',
        version: '1.0.0'
      };
      writeFileSync(join(specialDir, 'package.json'), JSON.stringify(specialPackageJson, null, 2));
      
      // Create files with special characters in names
      writeFileSync(join(specialDir, 'file with spaces.txt'), 'content');
      writeFileSync(join(specialDir, 'file-with-dashes.txt'), 'content');
      writeFileSync(join(specialDir, 'file.with.dots.txt'), 'content');
      
      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const result = execSync(`node "${CLI_PATH}" pack "${specialDir}"`, {
        cwd: outputDir,
        encoding: 'utf-8'
      });

      expect(result).toContain('Archive created successfully');

      const archivePath = join(outputDir, 'special-package-1.0.0.tgz');
      const files: string[] = [];
      await tar.list({ 
        file: archivePath,
        onentry: (entry: any) => files.push(entry.path)
      });

      expect(files).toContain('package.json');
      expect(files).toContain('file with spaces.txt');
      expect(files).toContain('file-with-dashes.txt');
      expect(files).toContain('file.with.dots.txt');
    }, 10000);

    it('should create output directory if it does not exist', async () => {
      const nonExistentOutput = join(tempDir, 'non-existent', 'nested', 'output');
      
      // Directory should not exist initially
      expect(existsSync(nonExistentOutput)).toBe(false);

      const result = execSync(`node "${CLI_PATH}" pack "${testSourceDir}" --pack-destination "${nonExistentOutput}"`, {
        cwd: tempDir,
        encoding: 'utf-8'
      });

      expect(result).toContain('Archive created successfully');

      // Directory should be created and archive should exist
      const archivePath = join(nonExistentOutput, 'test-package-1.0.0.tgz');
      expect(existsSync(archivePath)).toBe(true);
    }, 10000);

    it('should handle error when source directory does not exist', () => {
      const nonExistentDir = join(tempDir, 'does-not-exist');
      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      try {
        execSync(`node "${CLI_PATH}" pack "${nonExistentDir}"`, {
          cwd: outputDir,
          encoding: 'utf-8'
        });
        // Should not reach here, command should fail
        expect.fail('Command should have failed');
      } catch (error: any) {
        // Check error message in stderr
        expect(error.stderr).toContain('pack: Unable to find any files to pack');
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
        license: 'MIT'
      };
      writeFileSync(join(testSourceDir, 'package.json'), JSON.stringify(packageJson, null, 2));

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const result = execSync(`node "${CLI_PATH}" pack "${testSourceDir}"`, {
        cwd: outputDir,
        encoding: 'utf-8'
      });

      expect(result).toContain('Archive created successfully');

      // Extract and verify package.json content
      const archivePath = join(outputDir, 'test-resolved-pack-1.2.3.tgz');
      const extractDir = join(tempDir, 'extract-resolved');
      mkdirSync(extractDir);

      await tar.extract({
        file: archivePath,
        cwd: extractDir
      });

      // Verify package.json exists and has resolved content
      const extractedPackageJsonPath = join(extractDir, 'package.json');
      expect(existsSync(extractedPackageJsonPath)).toBe(true);

      const extractedPackageJson = JSON.parse(readFileSync(extractedPackageJsonPath, 'utf-8'));
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
        workspaces: ['packages/*']
      };
      writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify(rootPackageJson, null, 2));

      // Create child package
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });
      
      const childPackageJson = {
        name: 'child-package',
        description: 'Child package description'
      };
      writeFileSync(join(childDir, 'package.json'), JSON.stringify(childPackageJson, null, 2));

      // Add test files to child
      writeFileSync(join(childDir, 'index.js'), 'console.log("child");');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const result = execSync(`node "${CLI_PATH}" pack "${childDir}"`, {
        cwd: outputDir,
        encoding: 'utf-8'
      });

      expect(result).toContain('Archive created successfully');

      // Extract and verify inherited metadata
      const archivePath = join(outputDir, 'child-package-2.0.0.tgz');
      const extractDir = join(tempDir, 'extract-workspace');
      mkdirSync(extractDir);

      await tar.extract({
        file: archivePath,
        cwd: extractDir
      });

      const extractedPackageJsonPath = join(extractDir, 'package.json');
      expect(existsSync(extractedPackageJsonPath)).toBe(true);

      const extractedPackageJson = JSON.parse(readFileSync(extractedPackageJsonPath, 'utf-8'));
      
      // Verify child overrides
      expect(extractedPackageJson.name).toBe('child-package');
      expect(extractedPackageJson.description).toBe('Child package description');
      
      // Verify inherited from parent
      expect(extractedPackageJson.version).toBe('2.0.0');
      expect(extractedPackageJson.author).toBe('Workspace Author');
      expect(extractedPackageJson.license).toBe('Apache-2.0');
      
      // Workspace field should not be inherited
      expect(extractedPackageJson.workspaces).toBeUndefined();
    }, 10000);

    it('should handle package.json without existing file', () => {
      // Create a directory without package.json to test empty metadata resolution
      const emptyMetadataDir = join(tempDir, 'no-package-json');
      mkdirSync(emptyMetadataDir);
      
      // Create test file in directory
      writeFileSync(join(emptyMetadataDir, 'test.txt'), 'test content');
      
      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      try {
        execSync(`node "${CLI_PATH}" pack "${emptyMetadataDir}"`, {
          cwd: outputDir,
          encoding: 'utf-8'
        });
        // Should not reach here, command should fail
        expect.fail('Command should have failed');
      } catch (error: any) {
        // Check error message in stderr and stdout
        expect(error.stderr || error.stdout).toContain('Unable to find any files to pack');
        expect(error.status).toBe(1);
      }
    }, 10000);
  });

  //////////////////////////////////////////////////////////////////////////////////

  describe('CLI publish command tests', () => {
    const runPublishCLI = (args: string[], cwd: string = tempDir): { stdout: string; stderr: string; exitCode: number } => {
      const fullArgs = ['publish', ...args.map(arg => `"${arg}"`)];
      const result = execSync(`node "${CLI_PATH}" ${fullArgs.join(' ')}`, {
        cwd: cwd,
        encoding: 'utf-8',
        env: { 
          ...process.env, 
          SCREW_UP_TEST_MODE: 'true'  // Enable test mode to avoid actual npm publish
        }
      });
      return { stdout: result, stderr: '', exitCode: 0 };
    };

    const runPublishCLIWithError = (args: string[], cwd: string = tempDir): { stdout: string; stderr: string; exitCode: number } => {
      try {
        const fullArgs = ['publish', ...args.map(arg => `"${arg}"`)];
        const result = execSync(`node "${CLI_PATH}" ${fullArgs.join(' ')}`, {
          cwd: cwd,
          encoding: 'utf-8',
          env: { 
            ...process.env, 
            SCREW_UP_TEST_MODE: 'true'
          }
        });
        return { stdout: result, stderr: '', exitCode: 0 };
      } catch (error: any) {
        return {
          stdout: error.stdout || '',
          stderr: error.stderr || '',
          exitCode: error.status || 1
        };
      }
    };

    it('should publish tarball when no arguments provided', () => {
      const result = runPublishCLI([], testSourceDir);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Creating archive of');
      expect(result.stdout).toContain('TEST_MODE: Would execute: npm publish');
      expect(result.stdout).toContain('test-package-1.0.0.tgz');
      expect(result.stdout).toContain('TEST_MODE: Tarball path:');
      expect(result.stdout).toContain('Successfully published');
    }, 10000);

    it('should publish tarball from directory argument', () => {
      const result = runPublishCLI([testSourceDir]);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Creating archive of ${testSourceDir}`);
      expect(result.stdout).toContain('TEST_MODE: Would execute: npm publish');
      expect(result.stdout).toContain('test-package-1.0.0.tgz');
      expect(result.stdout).toContain('TEST_MODE: Tarball path:');
      expect(result.stdout).toContain('Successfully published');
    }, 10000);

    it('should publish existing tarball file directly', async () => {
      // First create a tarball file
      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });
      
      const metadata = await packAssets(testSourceDir, outputDir, true);
      const tarballPath = join(outputDir, `${metadata.name}-${metadata.version}.tgz`);
      
      // Verify tarball exists
      expect(existsSync(tarballPath)).toBe(true);
      
      const result = runPublishCLI([tarballPath]);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('TEST_MODE: Would execute: npm publish');
      expect(result.stdout).toContain('test-package-1.0.0.tgz');
      expect(result.stdout).toContain(`TEST_MODE: Tarball path: ${resolve(tarballPath)}`);
      expect(result.stdout).toContain('Successfully published');
      // Should not create new archive when given existing tarball
      expect(result.stdout).not.toContain('Creating archive of');
    }, 10000);

    it('should forward npm publish options', () => {
      const result = runPublishCLI([testSourceDir, '--dry-run', '--tag', 'beta', '--access', 'public']);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('TEST_MODE: Would execute: npm publish');
      expect(result.stdout).toContain('test-package-1.0.0.tgz');
      expect(result.stdout).toContain('TEST_MODE: Options: --dry-run --tag beta --access public');
      expect(result.stdout).toContain('Successfully published');
    }, 10000);

    it('should handle scoped package names correctly', () => {
      // Create a scoped package
      const scopedPackageJson = {
        name: '@scope/special-package',
        version: '2.1.0'
      };
      writeFileSync(join(testSourceDir, 'package.json'), JSON.stringify(scopedPackageJson, null, 2));
      
      const result = runPublishCLI([testSourceDir]);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('TEST_MODE: Would execute: npm publish');
      // Scoped package names should have '/' replaced with '-' in filename  
      expect(result.stdout).toContain('@scope/special-package-2.1.0.tgz');
      expect(result.stdout).toContain('Successfully published');
    }, 10000);

    it('should handle boolean options correctly', () => {
      const result = runPublishCLI([testSourceDir, '--dry-run', '--force']);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('TEST_MODE: Options: --dry-run --force');
    }, 10000);

    it('should handle key-value options correctly', () => {
      const result = runPublishCLI([testSourceDir, '--registry', 'https://custom-registry.com', '--tag', 'alpha']);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('TEST_MODE: Options: --registry https://custom-registry.com --tag alpha');
    }, 10000);

    it('should handle error when path does not exist', () => {
      const nonExistentPath = join(tempDir, 'does-not-exist');
      const result = runPublishCLIWithError([nonExistentPath]);
      
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Path does not exist');
    }, 10000);

    it('should handle error when invalid file type is provided', () => {
      // Create a non-tarball file
      const invalidFile = join(tempDir, 'invalid.txt');
      writeFileSync(invalidFile, 'not a tarball');
      
      const result = runPublishCLIWithError([invalidFile]);
      
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid path - must be a directory or .tgz/.tar.gz file');
    }, 10000);

    it('should handle directory without package.json', () => {
      // Create directory without package.json
      const emptyDir = join(tempDir, 'empty-no-package');
      mkdirSync(emptyDir);
      writeFileSync(join(emptyDir, 'readme.txt'), 'test file');
      
      const result = runPublishCLIWithError([emptyDir]);
      
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unable to find any files to pack');
    }, 10000);

    it('should show help for publish command', () => {
      const result = execSync(`node "${CLI_PATH}" publish --help`, {
        encoding: 'utf-8'
      });

      expect(result).toContain('Usage: screw-up <command> [options]');
      expect(result).toContain('publish [directory|package.tgz]  Publish the project');
      expect(result).toContain('All npm publish options are supported');
    });

    it('should verify tarball path is absolute', async () => {
      // Create tarball in nested directory
      const nestedDir = join(tempDir, 'nested', 'output');
      mkdirSync(nestedDir, { recursive: true });
      
      const metadata = await packAssets(testSourceDir, nestedDir, true);
      const tarballPath = join(nestedDir, `${metadata.name}-${metadata.version}.tgz`);
      
      const result = runPublishCLI([tarballPath]);
      
      expect(result.exitCode).toBe(0);
      // Should contain absolute path
      expect(result.stdout).toContain(`TEST_MODE: Tarball path: ${resolve(tarballPath)}`);
    }, 10000);

    it('should handle workspace packages correctly', () => {
      // Create workspace root with parent package.json
      const workspaceRoot = join(tempDir, 'workspace-publish');
      mkdirSync(workspaceRoot);
      
      const rootPackageJson = {
        name: 'workspace-root',
        version: '3.0.0',
        author: 'Workspace Author',
        license: 'Apache-2.0',
        private: true,
        workspaces: ['packages/*']
      };
      writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify(rootPackageJson, null, 2));

      // Create child package
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });
      
      const childPackageJson = {
        name: 'workspace-child',
        description: 'Child package'
      };
      writeFileSync(join(childDir, 'package.json'), JSON.stringify(childPackageJson, null, 2));
      writeFileSync(join(childDir, 'index.js'), 'console.log("child");');

      const result = runPublishCLI([childDir]);
      
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Creating archive of');
      // Should inherit version from workspace root
      expect(result.stdout).toContain('workspace-child-3.0.0.tgz');
      expect(result.stdout).toContain('Successfully published');
    }, 10000);
  });
});
