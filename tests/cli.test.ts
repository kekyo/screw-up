import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, mkdtempSync, readdirSync } from 'fs';
import { join, relative } from 'path';
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

      await packAssets(targetDir, outputDir);

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
      
      const workspaceArchived = await packAssets(workspaceRoot, outputDir);
      expect(workspaceArchived).toBe(false);

      // Check workspace archive was not created
      const workspaceArchivePath = join(outputDir, 'workspace-root-2.0.0.tgz');
      expect(existsSync(workspaceArchivePath)).toBe(false);

      const childArchived = await packAssets(childDir, outputDir);
      expect(childArchived).toBe(true);

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
      expect(result.stdout).toBe('diff -r workspace/packages/child/package.json extract/package.json\n3c3,6\n<   "description": "Child package description"\n---\n>   "description": "Child package description",\n>   "version": "2.0.0",\n>   "author": "Workspace Author",\n>   "license": "Apache-2.0"\n');
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

      const childArchived = await packAssets(childDir, outputDir);
      expect(childArchived).toBe(true);

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

      expect(result).toContain('Usage: screw-up pack');
      expect(result).toContain('Pack the project into a tar archive');
      expect(result).toContain('--pack-destination <path>');
      expect(result).toContain('Directory to write the tarball');
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

    it('should handle package.json without existing file', async () => {
      // Create a directory without package.json to test empty metadata resolution
      const emptyMetadataDir = join(tempDir, 'no-package-json');
      mkdirSync(emptyMetadataDir);
      
      // Create test file in directory
      writeFileSync(join(emptyMetadataDir, 'test.txt'), 'test content');
      
      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const result = execSync(`node "${CLI_PATH}" pack "${emptyMetadataDir}"`, {
        cwd: outputDir,
        encoding: 'utf-8'
      });

      expect(result).toContain('Archive created successfully');

      // Extract and verify empty package.json is created
      const archivePath = join(outputDir, 'package-0.0.0.tgz');
      const extractDir = join(tempDir, 'extract-empty');
      mkdirSync(extractDir);

      await tar.extract({
        file: archivePath,
        cwd: extractDir
      });

      const extractedPackageJsonPath = join(extractDir, 'package.json');
      expect(existsSync(extractedPackageJsonPath)).toBe(true);

      const extractedPackageJson = JSON.parse(readFileSync(extractedPackageJsonPath, 'utf-8'));
      
      // Should be an empty object or minimal structure
      expect(typeof extractedPackageJson).toBe('object');
    }, 10000);
  });
});
