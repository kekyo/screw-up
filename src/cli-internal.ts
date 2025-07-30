// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { join, resolve } from 'path';
import { glob } from 'glob';
import { createReadStream, existsSync } from 'fs';
import { mkdir, lstat, mkdtemp, writeFile, copyFile, rm } from 'fs/promises';
import { createTarPacker, createReadFileItem, createFileItem, storeReaderToFile, extractTo, createTarExtractor, createEntryItemGenerator } from 'tar-vern';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { resolveRawPackageJsonObject, PackageResolutionResult, findWorkspaceRoot, collectWorkspaceSiblings, replacePeerDependenciesWildcards } from './internal.js';

// We use async I/O except 'existsSync', because 'exists' will throw an error if the file does not exist.

//////////////////////////////////////////////////////////////////////////////////

/**
 * Execute npm pack and return the generated tarball path
 * @param targetDir - Target directory to pack
 * @param packDestDir - Directory to store the generated tarball (must exist)
 * @returns Path to generated tarball
 */
const runNpmPack = async (targetDir: string, packDestDir: string): Promise<string> => {
  return new Promise((res, rej) => {
    const npmProcess = spawn('npm', ['pack', '--pack-destination', packDestDir], {
      cwd: targetDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    npmProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    npmProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    npmProcess.on('close', (code) => {
      if (code === 0) {
        // npm pack outputs the filename on stdout (first line of output)
        const lines = stdout.trim().split('\n');
        const filename = lines[0]; // First line contains just the filename
        if (filename) {
          const fullPath = join(packDestDir, filename);
          res(fullPath);
        } else {
          rej(new Error('npm pack did not output a filename'));
        }
      } else {
        const errorMessage = `npm pack failed with exit code ${code}`;
        const fullError = stderr ? `${errorMessage}\nstderr: ${stderr}` : errorMessage;
        if (stdout) {
          rej(new Error(`${fullError}\nstdout: ${stdout}`));
        } else {
          rej(new Error(fullError));
        }
      }
    });

    npmProcess.on('error', (error) => {
      rej(new Error(`Failed to spawn npm pack: ${error.message}`));
    });
  });
};

//////////////////////////////////////////////////////////////////////////////////

/**
 * Create pack entry generator that collects and yields entries on-demand
 * @param targetDir - Target directory to pack
 * @param resolvedPackageJson - Resolved package.json object
 * @param readmeReplacementPath - Optional path to replacement README file
 * @returns Pack entry generator
 */
const createPackEntryGenerator = async function* (targetDir: string, resolvedPackageJson: any, readmeReplacementPath: string | undefined) {
  // First yield package.json content
  const packageJsonContent = JSON.stringify(resolvedPackageJson, null, 2);
  yield await createFileItem('package/package.json', packageJsonContent);

  // Get distribution files in package.json
  const distributionFileGlobs = resolvedPackageJson?.files as string[] ?? ['**/*'];
  
  // Convert directory patterns to recursive patterns (like npm pack does)
  const packingFilePaths = (await Promise.all(
    distributionFileGlobs.map(async (pattern) => {
      const fullPath = resolve(targetDir, pattern);
      try {
        if (existsSync(fullPath) && (await lstat(fullPath)).isDirectory()) {
          return await glob(`${pattern}/**/*`, { cwd: targetDir });
        }
        return await glob(pattern, { cwd: targetDir });
      } catch (error) {
        // If there's an error accessing the path, treat as glob pattern
        return await glob(pattern, { cwd: targetDir });
      }
    }))).flat();

  // Yield target packing files
  for (const packingFilePath of packingFilePaths) {
    // Except package.json (already yielded)
    if (packingFilePath !== 'package.json') {
      // Is file regular?
      const fullPath = resolve(targetDir, packingFilePath);
      const stat = await lstat(fullPath);
      if (stat.isFile()) {
        // Handle README.md replacement
        if (packingFilePath === 'README.md' && readmeReplacementPath) {
          // Use replacement file but keep README.md as the archive entry name
          yield await createReadFileItem('package/README.md', readmeReplacementPath);
        } else {
          // Yield regular file
          yield await createReadFileItem(`package/${packingFilePath}`, fullPath);
        }
      }
    }
  }

  // Handle case where README.md doesn't exist in files but we have a replacement
  if (readmeReplacementPath && !packingFilePaths.includes('README.md')) {
    // Add README.md to the archive using replacement file
    yield await createReadFileItem('package/README.md', readmeReplacementPath);
  }
};

export interface PackedResult {
  packageFileName: string;
  metadata: any;
}

/**
 * Pack assets using npm pack delegation method
 * @param targetDir - Target directory to pack
 * @param outputDir - Output directory to write the tarball
 * @param checkWorkingDirectoryStatus - Check working directory status
 * @param inheritableFields - Package metadata fields that should be inherited from parent
 * @param readmeReplacementPath - Optional path to replacement README file
 * @param replacePeerDepsWildcards - Replace "*" in peerDependencies with actual versions
 * @param peerDepsVersionPrefix - Version prefix for replaced peerDependencies
 * @param alwaysOverrideVersionFromGit - Always override version from Git (default: true)
 * @returns Package metadata (package.json) or undefined if failed
 */
export const packAssets = async (
  targetDir: string,
  outputDir: string,
  checkWorkingDirectoryStatus: boolean,
  alwaysOverrideVersionFromGit: boolean,
  inheritableFields: Set<string>,
  readmeReplacementPath: string | undefined,
  replacePeerDepsWildcards: boolean,
  peerDepsVersionPrefix: string) : Promise<PackedResult | undefined> => {
  // Check if target directory exists
  if (!existsSync(targetDir)) {
    throw new Error(`Target directory is not found: ${targetDir}`);
  }

  let readmeReplacementCandidatePath = readmeReplacementPath;
  if (readmeReplacementCandidatePath && !existsSync(readmeReplacementCandidatePath)) {
    throw new Error(`README replacement file is not found: ${readmeReplacementCandidatePath}`);
  }

  // Resolve package metadata with source tracking
  const result = await resolveRawPackageJsonObject(
    targetDir,
    checkWorkingDirectoryStatus,
    alwaysOverrideVersionFromGit,
    inheritableFields);

  let resolvedPackageJson = result.metadata;

  // Check if package is private
  if (resolvedPackageJson?.private) {
    return undefined;
  }

  // Extract README replacement directive on package.json
  const packageJsonReadme = resolvedPackageJson.readme;
  if (packageJsonReadme) {
    // When does not override by parameter (CLI)
    if (!readmeReplacementCandidatePath) {
      const packageJsonReadmeDir = result.sourceMap.get('readme');
      const packageJsonReadmePath = join(packageJsonReadmeDir, packageJsonReadme);
      if (!existsSync(packageJsonReadmePath)) {
        throw new Error(`README replacement file is not found: ${packageJsonReadmePath}`);
      }
      readmeReplacementCandidatePath = packageJsonReadmePath;
    }
    // Always remove it.
    delete resolvedPackageJson.readme;
  }

  // Replace peerDependencies wildcards if enabled and in workspace
  if (replacePeerDepsWildcards) {
    const workspaceRoot = await findWorkspaceRoot(targetDir);
    if (workspaceRoot) {
      const siblings = await collectWorkspaceSiblings(workspaceRoot);
      if (siblings.size > 0) {
        resolvedPackageJson = replacePeerDependenciesWildcards(
          resolvedPackageJson,
          siblings,
          peerDepsVersionPrefix
        );
      }
    }
  }

  // Create temporary directory for npm pack
  const baseTempDir = await mkdtemp(join(tmpdir(), 'screw-up-npm-pack-'));
  await mkdir(baseTempDir, { recursive: true });

  try {
    // Step 1: Execute npm pack to generate initial tarball
    const npmTarballPath = await runNpmPack(targetDir, baseTempDir);

    // Step 2: Extract the npm-generated tarball into staging directory
    const stagingDir = join(baseTempDir, 'staging');
    await mkdir(stagingDir, { recursive: true });

    const stream = createReadStream(npmTarballPath);
    await extractTo(createTarExtractor(stream, 'gzip'), stagingDir);

    // Step 3: Process extracted files (package.json/README replacement)
    // Replace package.json with our processed version
    const packageJsonPath = join(stagingDir, 'package', 'package.json');
    if (existsSync(packageJsonPath)) {
      await writeFile(packageJsonPath, JSON.stringify(resolvedPackageJson, null, 2));
    }

    // Replace README.md
    if (readmeReplacementCandidatePath) {
      const readmeDestPath = join(stagingDir, 'package', 'README.md');
      await copyFile(readmeReplacementCandidatePath, readmeDestPath);
    }

    // Step 4: Re-create tarball with modified files
    const outputFileName = `${resolvedPackageJson?.name?.replace('/', '-') ?? "package"}-${resolvedPackageJson?.version ?? "0.0.0"}.tgz`;
    await mkdir(outputDir, { recursive: true });
    const outputFile = join(outputDir, outputFileName);

    // Re-packing final tar file from the modified staging directory
    const itemGenerator = createEntryItemGenerator(stagingDir);
    const packer = createTarPacker(itemGenerator, 'gzip');
    await storeReaderToFile(packer, outputFile);

    // PackedResult
    return {
      packageFileName: outputFileName,
      metadata: resolvedPackageJson
    };
  } finally {
    // Clean up temporary directory
    await rm(baseTempDir, { recursive: true, force: true });
  }
};

/**
 * Get computed package.json object
 * @param targetDir - Target directory to resolve package metadata
 * @param checkWorkingDirectoryStatus - Check working directory status
 * @param inheritableFields - Package metadata fields that should be inherited from parent
 * @returns Computed package.json object or undefined if failed
 */
export const getComputedPackageJsonObject = async (
  targetDir: string,
  checkWorkingDirectoryStatus: boolean,
  alwaysOverrideVersionFromGit: boolean,
  inheritableFields: Set<string>) : Promise<any> => {
  // Check if target directory exists
  if (!existsSync(targetDir)) {
    return undefined;
  }

  // Resolve package metadata
  const result = await resolveRawPackageJsonObject(
    targetDir,
    checkWorkingDirectoryStatus, alwaysOverrideVersionFromGit,
    inheritableFields);
  return result.metadata;
};

//////////////////////////////////////////////////////////////////////////////////

export interface ParsedArgs {
  command?: string;
  positional: string[];
  options: Record<string, string | boolean>;
}

export const parseArgs = (argv: string[]): ParsedArgs => {
  const args = argv.slice(2); // Remove 'node' and script path
  const result: ParsedArgs = {
    positional: [],
    options: {}
  };

  if (args.length === 0) {
    return result;
  }

  // Don't treat options as command
  if (args[0].startsWith('-')) {
    let i = 0;
    while (i < args.length) {
      const arg = args[i];

      if (arg.startsWith('--')) {
        const optionName = arg.slice(2);
        const nextArg = args[i + 1];

        if (nextArg !== undefined && !nextArg.startsWith('-')) {
          result.options[optionName] = nextArg;
          i += 2;
        } else {
          result.options[optionName] = true;
          i += 1;
        }
      } else if (arg.startsWith('-')) {
        const optionName = arg.slice(1);
        result.options[optionName] = true;
        i += 1;
      } else {
        result.positional.push(arg);
        i += 1;
      }
    }
    return result;
  }

  result.command = args[0];
  let i = 1;

  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const optionName = arg.slice(2);
      const nextArg = args[i + 1];

      if (nextArg !== undefined && !nextArg.startsWith('-')) {
        result.options[optionName] = nextArg;
        i += 2;
      } else {
        result.options[optionName] = true;
        i += 1;
      }
    } else if (arg.startsWith('-')) {
      const optionName = arg.slice(1);
      result.options[optionName] = true;
      i += 1;
    } else {
      result.positional.push(arg);
      i += 1;
    }
  }

  return result;
};
