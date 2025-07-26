import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join, relative, resolve } from 'path';
import { tmpdir } from 'os';
import { execSync, spawn } from 'child_process';
import * as tar from 'tar';
import dayjs from 'dayjs';
import { packAssets } from '../src/cli-internal.js';

const CLI_PATH = join(__dirname, '../dist/cli.js');

// Default inheritable fields (copied from cli.ts)
const defaultInheritableFields = new Set([
  'version',
  'description', 
  'author',
  'license',
  'repository',
  'keywords',
  'homepage',
  'bugs',
  'readme'
]);

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

      const metadata = await packAssets(targetDir, outputDir, true, defaultInheritableFields, undefined);
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

      const workspaceArchived = await packAssets(workspaceRoot, outputDir, true, defaultInheritableFields, undefined);
      expect(workspaceArchived).toBeUndefined();

      // Check workspace archive was not created
      const workspaceArchivePath = join(outputDir, 'workspace-root-2.0.0.tgz');
      expect(existsSync(workspaceArchivePath)).toBe(false);

      const childArchived = await packAssets(childDir, outputDir, true, defaultInheritableFields, undefined);
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

      const childArchived = await packAssets(childDir, outputDir, true, defaultInheritableFields, undefined);
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

    it('should pack with README replacement using CLI option', async () => {
      // Create README replacement file
      const readmeReplacement = join(testSourceDir, 'README_custom.md');
      writeFileSync(readmeReplacement, '# Custom README for packaging\nThis is a custom README file.');

      // Create regular README.md
      const regularReadme = join(testSourceDir, 'README.md');
      writeFileSync(regularReadme, '# Regular README\nThis should be ignored.');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const metadata = await packAssets(testSourceDir, outputDir, true, defaultInheritableFields, readmeReplacement);
      expect(metadata).toBeDefined();
      expect(metadata?.name).toBe('test-package');

      // Check if archive was created
      const archivePath = join(outputDir, 'test-package-1.0.0.tgz');
      expect(existsSync(archivePath)).toBe(true);

      // Extract and verify README.md content
      const extractDir = join(tempDir, 'extract-readme');
      mkdirSync(extractDir);
      await tar.extract({
        file: archivePath,
        cwd: extractDir
      });

      const extractedReadme = join(extractDir, 'README.md');
      expect(existsSync(extractedReadme)).toBe(true);
      
      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe('# Custom README for packaging\nThis is a custom README file.');
      expect(readmeContent).not.toContain('Regular README');
    });

    it('should pack with README replacement using package.json readme field', async () => {
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
        files: ['**/*']
      };
      writeFileSync(join(testDir, 'package.json'), JSON.stringify(packageJsonWithReadme, null, 2));

      // Create README files
      const packReadme = join(testDir, 'README_pack.md');
      writeFileSync(packReadme, '# Pack README\nThis is the pack-specific README.');

      const regularReadme = join(testDir, 'README.md');
      writeFileSync(regularReadme, '# Regular README\nThis should be ignored.');

      writeFileSync(join(testDir, 'index.js'), 'console.log("test");');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // No CLI readme option provided - should use package.json readme field
      const metadata = await packAssets(testDir, outputDir, true, defaultInheritableFields, undefined);
      expect(metadata).toBeDefined();
      expect(metadata?.name).toBe('test-package-readme');

      // Check if archive was created
      const archivePath = join(outputDir, 'test-package-readme-1.0.0.tgz');
      expect(existsSync(archivePath)).toBe(true);

      // Extract and verify README.md content
      const extractDir = join(tempDir, 'extract-pack-readme');
      mkdirSync(extractDir);
      await tar.extract({
        file: archivePath,
        cwd: extractDir
      });

      const extractedReadme = join(extractDir, 'README.md');
      expect(existsSync(extractedReadme)).toBe(true);
      
      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe('# Pack README\nThis is the pack-specific README.');
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
        files: ['**/*']
      };
      writeFileSync(join(testDir, 'package.json'), JSON.stringify(packageJsonWithReadme, null, 2));

      // Create multiple README files
      const packReadme = join(testDir, 'README_pack.md');
      writeFileSync(packReadme, '# Pack README\nFrom package.json readme field.');

      const cliReadme = join(testDir, 'README_cli.md');
      writeFileSync(cliReadme, '# CLI README\nFrom CLI option - should take priority.');

      const regularReadme = join(testDir, 'README.md');
      writeFileSync(regularReadme, '# Regular README\nShould be ignored.');

      writeFileSync(join(testDir, 'index.js'), 'console.log("test");');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // CLI option should take priority over package.json readme field
      const metadata = await packAssets(testDir, outputDir, true, defaultInheritableFields, cliReadme);
      expect(metadata).toBeDefined();
      expect(metadata?.name).toBe('test-priority');

      // Check if archive was created
      const archivePath = join(outputDir, 'test-priority-1.0.0.tgz');
      expect(existsSync(archivePath)).toBe(true);

      // Extract and verify README.md content
      const extractDir = join(tempDir, 'extract-priority');
      mkdirSync(extractDir);
      await tar.extract({
        file: archivePath,
        cwd: extractDir
      });

      const extractedReadme = join(extractDir, 'README.md');
      expect(existsSync(extractedReadme)).toBe(true);
      
      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe('# CLI README\nFrom CLI option - should take priority.');
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
        files: ['index.js'] // README.md not included
      };
      writeFileSync(join(testDir, 'package.json'), JSON.stringify(packageJsonNoReadme, null, 2));

      writeFileSync(join(testDir, 'index.js'), 'console.log("test");');

      // Create replacement README file
      const replacementReadme = join(testDir, 'README_replacement.md');
      writeFileSync(replacementReadme, '# Replacement README\nAdded even though not in files array.');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const metadata = await packAssets(testDir, outputDir, true, defaultInheritableFields, replacementReadme);
      expect(metadata).toBeDefined();
      expect(metadata?.name).toBe('test-no-readme-in-files');

      // Check if archive was created
      const archivePath = join(outputDir, 'test-no-readme-in-files-1.0.0.tgz');
      expect(existsSync(archivePath)).toBe(true);

      // Extract and verify README.md was added
      const extractDir = join(tempDir, 'extract-no-files');
      mkdirSync(extractDir);
      await tar.extract({
        file: archivePath,
        cwd: extractDir
      });

      const extractedReadme = join(extractDir, 'README.md');
      expect(existsSync(extractedReadme)).toBe(true);
      
      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe('# Replacement README\nAdded even though not in files array.');
    });

    it('should throw error when replacement file does not exist', async () => {
      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const nonExistentReadme = join(testSourceDir, 'non-existent-readme.md');

      await expect(packAssets(testSourceDir, outputDir, true, defaultInheritableFields, nonExistentReadme))
        .rejects.toThrow('README replacement file not found:');
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

    it('should pack with --readme option to replace README.md', async () => {
      // Create README replacement file
      const readmeReplacement = join(testSourceDir, 'README_custom.md');
      writeFileSync(readmeReplacement, '# Custom README for packaging\nThis is a custom README file.');

      // Create regular README.md
      const regularReadme = join(testSourceDir, 'README.md');
      writeFileSync(regularReadme, '# Regular README\nThis should be ignored.');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // Run CLI pack command with --readme option
      const result = execSync(`node "${CLI_PATH}" pack "${testSourceDir}" --readme "${readmeReplacement}"`, {
        cwd: outputDir,
        encoding: 'utf-8'
      });

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
        cwd: extractDir
      });

      const extractedReadme = join(extractDir, 'README.md');
      expect(existsSync(extractedReadme)).toBe(true);
      
      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe('# Custom README for packaging\nThis is a custom README file.');
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
        files: ['**/*']
      };
      writeFileSync(join(testDir, 'package.json'), JSON.stringify(packageJsonWithReadme, null, 2));

      // Create README files
      const packReadme = join(testDir, 'README_pack.md');
      writeFileSync(packReadme, '# Pack README\nThis is the pack-specific README.');

      const regularReadme = join(testDir, 'README.md');
      writeFileSync(regularReadme, '# Regular README\nThis should be ignored.');

      writeFileSync(join(testDir, 'index.js'), 'console.log("test");');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // Run CLI pack command without --readme option
      const result = execSync(`node "${CLI_PATH}" pack "${testDir}"`, {
        cwd: outputDir,
        encoding: 'utf-8'
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
        cwd: extractDir
      });

      const extractedReadme = join(extractDir, 'README.md');
      expect(existsSync(extractedReadme)).toBe(true);
      
      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe('# Pack README\nThis is the pack-specific README.');
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
        files: ['**/*']
      };
      writeFileSync(join(testDir, 'package.json'), JSON.stringify(packageJsonWithReadme, null, 2));

      // Create multiple README files
      const packReadme = join(testDir, 'README_pack.md');
      writeFileSync(packReadme, '# Pack README\nFrom package.json readme field.');

      const cliReadme = join(testDir, 'README_cli.md');
      writeFileSync(cliReadme, '# CLI README\nFrom CLI option - should take priority.');

      const regularReadme = join(testDir, 'README.md');
      writeFileSync(regularReadme, '# Regular README\nShould be ignored.');

      writeFileSync(join(testDir, 'index.js'), 'console.log("test");');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // Run CLI pack command with --readme option (should override package.json readme)
      const result = execSync(`node "${CLI_PATH}" pack "${testDir}" --readme "${cliReadme}"`, {
        cwd: outputDir,
        encoding: 'utf-8'
      });

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
        cwd: extractDir
      });

      const extractedReadme = join(extractDir, 'README.md');
      expect(existsSync(extractedReadme)).toBe(true);
      
      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe('# CLI README\nFrom CLI option - should take priority.');
      expect(readmeContent).not.toContain('Pack README');
      expect(readmeContent).not.toContain('Regular README');
    }, 10000);

    it('should handle error when --readme file does not exist', async () => {
      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const nonExistentReadme = join(testSourceDir, 'non-existent-readme.md');

      try {
        execSync(`node "${CLI_PATH}" pack "${testSourceDir}" --readme "${nonExistentReadme}"`, {
          cwd: outputDir,
          encoding: 'utf-8'
        });
        // Should not reach here, command should fail
        expect.fail('Command should have failed');
      } catch (error: any) {
        // Check error message in stderr
        expect(error.stderr || error.stdout).toContain('README replacement file not found:');
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
        files: ['index.js'] // README.md not included
      };
      writeFileSync(join(testDir, 'package.json'), JSON.stringify(packageJsonNoReadme, null, 2));

      writeFileSync(join(testDir, 'index.js'), 'console.log("test");');

      // Create replacement README file
      const replacementReadme = join(testDir, 'README_replacement.md');
      writeFileSync(replacementReadme, '# Replacement README\nAdded even though not in files array.');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // Run CLI pack command with --readme option
      const result = execSync(`node "${CLI_PATH}" pack "${testDir}" --readme "${replacementReadme}"`, {
        cwd: outputDir,
        encoding: 'utf-8'
      });

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
        cwd: extractDir
      });

      const extractedReadme = join(extractDir, 'README.md');
      expect(existsSync(extractedReadme)).toBe(true);
      
      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe('# Replacement README\nAdded even though not in files array.');
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
      
      const metadata = await packAssets(testSourceDir, outputDir, true, defaultInheritableFields, undefined);
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
      
      const metadata = await packAssets(testSourceDir, nestedDir, true, defaultInheritableFields, undefined);
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

  //////////////////////////////////////////////////////////////////////////////////

  describe('CLI dump command tests', () => {
    it('should dump package.json from current directory when no arguments provided', () => {
      const result = execSync(`node "${CLI_PATH}" dump`, {
        cwd: testSourceDir,
        encoding: 'utf-8'
      });

      // Parse the JSON output
      const packageJson = JSON.parse(result);
      expect(packageJson.name).toBe('test-package');
      expect(packageJson.version).toBe('1.0.0');
    }, 10000);

    it('should dump package.json from specified directory', () => {
      const result = execSync(`node "${CLI_PATH}" dump "${testSourceDir}"`, {
        cwd: tempDir,
        encoding: 'utf-8'
      });

      // Parse the JSON output
      const packageJson = JSON.parse(result);
      expect(packageJson.name).toBe('test-package');
      expect(packageJson.version).toBe('1.0.0');
    }, 10000);

    it('should respect --no-wds option', () => {
      const result = execSync(`node "${CLI_PATH}" dump "${testSourceDir}" --no-wds`, {
        cwd: tempDir,
        encoding: 'utf-8'
      });

      // Parse the JSON output
      const packageJson = JSON.parse(result);
      expect(packageJson.name).toBe('test-package');
      expect(packageJson.version).toBe('1.0.0');
    }, 10000);

    it('should show help for dump command', () => {
      const result = execSync(`node "${CLI_PATH}" dump --help`, {
        encoding: 'utf-8'
      });

      expect(result).toContain('Usage: screw-up <command> [options]');
      expect(result).toContain('dump [directory]              Dump computed package.json as JSON');
      expect(result).toContain('--no-wds');
    });

    it('should handle workspace inheritance in dump', () => {
      // Create workspace root with parent package.json
      const workspaceRoot = join(tempDir, 'workspace-dump');
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

      const result = execSync(`node "${CLI_PATH}" dump "${childDir}"`, {
        cwd: tempDir,
        encoding: 'utf-8'
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

    it('should handle error when directory does not exist', () => {
      const nonExistentDir = join(tempDir, 'does-not-exist');

      try {
        execSync(`node "${CLI_PATH}" dump "${nonExistentDir}"`, {
          cwd: tempDir,
          encoding: 'utf-8'
        });
        // Should not reach here, command should fail
        expect.fail('Command should have failed');
      } catch (error: any) {
        // Check error message in stderr
        expect(error.stderr).toContain('dump: Unable to read package.json from');
        expect(error.status).toBe(1);
      }
    });

    it('should handle directory without package.json', () => {
      // Create directory without package.json
      const emptyDir = join(tempDir, 'empty-no-package-dump');
      mkdirSync(emptyDir);
      writeFileSync(join(emptyDir, 'readme.txt'), 'test file');

      try {
        execSync(`node "${CLI_PATH}" dump "${emptyDir}"`, {
          cwd: tempDir,
          encoding: 'utf-8'
        });
        // Should not reach here, command should fail
        expect.fail('Command should have failed');
      } catch (error: any) {
        // Check error message in stderr or stdout  
        expect(error.stderr || error.stdout).toContain('dump: Failed to dump package.json');
        expect(error.status).toBe(1);
      }
    }, 10000);

    it('should dump complete package.json with all metadata', () => {
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
          url: 'https://github.com/test/repo.git'
        },
        dependencies: {
          'test-dep': '^1.0.0'
        },
        devDependencies: {
          'test-dev-dep': '^2.0.0'
        },
        scripts: {
          test: 'echo "test"',
          build: 'echo "build"'
        },
        files: ['dist/**/*', 'README.md']
      };
      writeFileSync(join(testSourceDir, 'package.json'), JSON.stringify(comprehensivePackageJson, null, 2));

      const result = execSync(`node "${CLI_PATH}" dump "${testSourceDir}"`, {
        cwd: tempDir,
        encoding: 'utf-8'
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
        url: 'https://github.com/test/repo.git'
      });
      expect(packageJson.dependencies).toEqual({
        'test-dep': '^1.0.0'
      });
      expect(packageJson.devDependencies).toEqual({
        'test-dev-dep': '^2.0.0'
      });
      expect(packageJson.scripts).toEqual({
        test: 'echo "test"',
        build: 'echo "build"'
      });
      expect(packageJson.files).toEqual(['dist/**/*', 'README.md']);
    }, 10000);

    it('should output valid JSON format', () => {
      const result = execSync(`node "${CLI_PATH}" dump "${testSourceDir}"`, {
        cwd: tempDir,
        encoding: 'utf-8'
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
      writeFileSync(workspaceReadme, '# Workspace README\nThis is the workspace-level README file.');

      const rootPackageJson = {
        name: 'workspace-root',
        version: '2.0.0',
        author: 'Workspace Author',
        license: 'Apache-2.0',
        readme: 'README_workspace.md',
        workspaces: ['packages/*']
      };
      writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify(rootPackageJson, null, 2));

      // Create child package without readme field
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });

      const childPackageJson = {
        name: 'child-package',
        description: 'Child package description',
        files: ['**/*']
      };
      writeFileSync(join(childDir, 'package.json'), JSON.stringify(childPackageJson, null, 2));
      writeFileSync(join(childDir, 'index.js'), 'console.log("child");');

      // Create child-level README that should be ignored
      const childReadme = join(childDir, 'README.md');
      writeFileSync(childReadme, '# Child README\nThis should be ignored in favor of workspace README.');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // Pack child package - should use workspace root's README
      const metadata = await packAssets(childDir, outputDir, true, defaultInheritableFields, undefined);
      expect(metadata).toBeDefined();
      expect(metadata?.name).toBe('child-package');

      // Extract and verify README.md content
      const archivePath = join(outputDir, 'child-package-2.0.0.tgz');
      const extractDir = join(tempDir, 'extract-workspace');
      mkdirSync(extractDir);

      await tar.extract({
        file: archivePath,
        cwd: extractDir
      });

      const extractedReadme = join(extractDir, 'README.md');
      expect(existsSync(extractedReadme)).toBe(true);
      
      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe('# Workspace README\nThis is the workspace-level README file.');
      expect(readmeContent).not.toContain('Child README');
    }, 10000);

    it('should prioritize child package readme over inherited workspace readme', async () => {
      // Create workspace root with parent package.json
      const workspaceRoot = join(tempDir, 'workspace-priority');
      mkdirSync(workspaceRoot);

      // Create workspace root README
      const workspaceReadme = join(workspaceRoot, 'README_workspace.md');
      writeFileSync(workspaceReadme, '# Workspace README\nInherited from workspace root.');

      const rootPackageJson = {
        name: 'workspace-root',
        version: '3.0.0',
        author: 'Workspace Author',
        license: 'Apache-2.0',
        readme: 'README_workspace.md',
        workspaces: ['packages/*']
      };
      writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify(rootPackageJson, null, 2));

      // Create child package WITH its own readme field
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });

      // Create child-specific README
      const childReadme = join(childDir, 'README_child.md');
      writeFileSync(childReadme, '# Child README\nChild-specific README file.');

      const childPackageJson = {
        name: 'child-package',
        description: 'Child package description',
        readme: 'README_child.md',
        files: ['**/*']
      };
      writeFileSync(join(childDir, 'package.json'), JSON.stringify(childPackageJson, null, 2));
      writeFileSync(join(childDir, 'index.js'), 'console.log("child");');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // Pack child package - should use child's own README, not workspace README
      const metadata = await packAssets(childDir, outputDir, true, defaultInheritableFields, undefined);
      expect(metadata).toBeDefined();
      expect(metadata?.name).toBe('child-package');

      // Extract and verify README.md content
      const archivePath = join(outputDir, 'child-package-3.0.0.tgz');
      const extractDir = join(tempDir, 'extract-priority');
      mkdirSync(extractDir);

      await tar.extract({
        file: archivePath,
        cwd: extractDir
      });

      const extractedReadme = join(extractDir, 'README.md');
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
      writeFileSync(workspaceReadme, '# Workspace README\nInherited from workspace root.');

      const rootPackageJson = {
        name: 'workspace-root',
        version: '4.0.0',
        author: 'Workspace Author',
        license: 'Apache-2.0',
        readme: 'README_workspace.md',
        workspaces: ['packages/*']
      };
      writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify(rootPackageJson, null, 2));

      // Create child package without readme field
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });

      const childPackageJson = {
        name: 'child-package',
        description: 'Child package description',
        files: ['**/*']
      };
      writeFileSync(join(childDir, 'package.json'), JSON.stringify(childPackageJson, null, 2));
      writeFileSync(join(childDir, 'index.js'), 'console.log("child");');

      // Create CLI-specified README
      const cliReadme = join(childDir, 'README_cli.md');
      writeFileSync(cliReadme, '# CLI README\nSpecified via CLI option - should override workspace inheritance.');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // Pack child package with CLI option - should use CLI README, not workspace README
      const metadata = await packAssets(childDir, outputDir, true, defaultInheritableFields, cliReadme);
      expect(metadata).toBeDefined();
      expect(metadata?.name).toBe('child-package');

      // Extract and verify README.md content
      const archivePath = join(outputDir, 'child-package-4.0.0.tgz');
      const extractDir = join(tempDir, 'extract-cli-override');
      mkdirSync(extractDir);

      await tar.extract({
        file: archivePath,
        cwd: extractDir
      });

      const extractedReadme = join(extractDir, 'README.md');
      expect(existsSync(extractedReadme)).toBe(true);
      
      const readmeContent = readFileSync(extractedReadme, 'utf-8');
      expect(readmeContent).toBe('# CLI README\nSpecified via CLI option - should override workspace inheritance.');
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
        workspaces: ['packages/*']
      };
      writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify(rootPackageJson, null, 2));

      // Create child package
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });

      const childPackageJson = {
        name: 'child-package'
        // version and homepage should be inherited from parent
      };
      writeFileSync(join(childDir, 'package.json'), JSON.stringify(childPackageJson, null, 2));
      writeFileSync(join(childDir, 'index.js'), 'console.log("child");');

      const outputDir = join(tempDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      // Run CLI pack command with custom --inheritable-fields (only version and homepage)
      const result = execSync(`node "${CLI_PATH}" pack "${childDir}" --inheritable-fields "version,homepage"`, {
        cwd: outputDir,
        encoding: 'utf-8'
      });

      expect(result).toContain('Creating archive of');
      expect(result).toContain('Archive created successfully');

      // Extract and verify package.json content
      const archivePath = join(outputDir, 'child-package-2.5.0.tgz');
      const extractDir = join(tempDir, 'extract-cli-fields');
      mkdirSync(extractDir);

      await tar.extract({
        file: archivePath,
        cwd: extractDir
      });

      const extractedPackageJsonPath = join(extractDir, 'package.json');
      const extractedPackageJson = JSON.parse(readFileSync(extractedPackageJsonPath, 'utf-8'));

      // Verify child name is preserved
      expect(extractedPackageJson.name).toBe('child-package');

      // Verify only specified fields are inherited
      expect(extractedPackageJson.version).toBe('2.5.0'); // Should be inherited
      expect(extractedPackageJson.homepage).toBe('https://workspace.example.com'); // Should be inherited

      // Verify other fields are NOT inherited
      expect(extractedPackageJson.author).toBeUndefined();
      expect(extractedPackageJson.license).toBeUndefined();
      expect(extractedPackageJson.description).toBeUndefined();
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
        workspaces: ['packages/*']
      };
      writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify(rootPackageJson, null, 2));

      // Create child package
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });

      const childPackageJson = {
        name: 'child-package'
      };
      writeFileSync(join(childDir, 'package.json'), JSON.stringify(childPackageJson, null, 2));
      writeFileSync(join(childDir, 'index.js'), 'console.log("child");');

      // Run CLI publish command with custom --inheritable-fields
      const result = execSync(`node "${CLI_PATH}" publish "${childDir}" --inheritable-fields "version,license,repository" --dry-run`, {
        cwd: tempDir,
        encoding: 'utf-8',
        env: { 
          ...process.env, 
          SCREW_UP_TEST_MODE: 'true'
        }
      });

      expect(result).toContain('Creating archive of');
      expect(result).toContain('TEST_MODE: Would execute: npm publish');
      expect(result).toContain('child-package-3.5.0.tgz');
      expect(result).toContain('TEST_MODE: Options: --dry-run'); // inheritable-fields should not be passed to npm
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
        workspaces: ['packages/*']
      };
      writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify(rootPackageJson, null, 2));

      // Create child package
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });

      const childPackageJson = {
        name: 'child-package',
        description: 'Child description override'
      };
      writeFileSync(join(childDir, 'package.json'), JSON.stringify(childPackageJson, null, 2));

      // Run CLI dump command with custom --inheritable-fields (only author and keywords)
      const result = execSync(`node "${CLI_PATH}" dump "${childDir}" --inheritable-fields "author,keywords"`, {
        cwd: tempDir,
        encoding: 'utf-8'
      });

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
        workspaces: ['packages/*']
      };
      writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify(rootPackageJson, null, 2));

      // Create child package
      const childDir = join(workspaceRoot, 'packages', 'child');
      mkdirSync(childDir, { recursive: true });

      const childPackageJson = {
        name: 'child-package',
        version: '1.0.0'
      };
      writeFileSync(join(childDir, 'package.json'), JSON.stringify(childPackageJson, null, 2));
      writeFileSync(join(childDir, 'index.js'), 'console.log("child");');

      // Run CLI dump command with empty --inheritable-fields (no inheritance)
      const result = execSync(`node "${CLI_PATH}" dump "${childDir}" --inheritable-fields ""`, {
        cwd: tempDir,
        encoding: 'utf-8'
      });

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
});
