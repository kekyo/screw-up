// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { resolve } from 'path';
import { glob } from 'glob';
import { existsSync } from 'fs';
import { mkdir, lstat } from 'fs/promises';
import { createTarPacker, createReadFileItem, createFileItem, storeReaderToFile } from 'tar-vern';
import { resolveRawPackageJsonObject, PackageResolutionResult, findWorkspaceRoot, collectWorkspaceSiblings, replacePeerDependenciesWildcards } from './internal.js';

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


/**
 * Pack assets into a tar archive
 * @param targetDir - Target directory to pack
 * @param outputDir - Output directory to write the tarball
 * @param checkWorkingDirectoryStatus - Check working directory status
 * @param inheritableFields - Package metadata fields that should be inherited from parent
 * @param readmeReplacementPath - Optional path to replacement README file
 * @param replacePeerDepsWildcards - Replace "*" in peerDependencies with actual versions
 * @param peerDepsVersionPrefix - Version prefix for replaced peerDependencies
 * @returns Package metadata (package.json) or undefined if failed
 */
export const packAssets = async (
  targetDir: string,
  outputDir: string,
  checkWorkingDirectoryStatus: boolean,
  inheritableFields: Set<string>,
  readmeReplacementPath: string | undefined,
  replacePeerDepsWildcards: boolean = true,
  peerDepsVersionPrefix: string = "^") : Promise<any> => {
  // Check if target directory exists
  if (!existsSync(targetDir)) {
    return undefined;
  }

  // Resolve package metadata with source tracking
  let result: PackageResolutionResult;
  try {
    result = await resolveRawPackageJsonObject(
      targetDir, checkWorkingDirectoryStatus,
      inheritableFields);
  } catch (error) {
    // If package.json cannot be read (e.g., file doesn't exist), return undefined
    // This matches npm pack behavior which requires package.json
    return undefined;
  }

  let { packageJson: resolvedPackageJson, sourceMap } = result;

  // Check if package is private
  if (resolvedPackageJson?.private) {
    return undefined;
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

  // Determine README replacement path
  // Priority: CLI option > package.json.readme > none
  let finalReadmeReplacementPath = readmeReplacementPath;
  if (!finalReadmeReplacementPath && resolvedPackageJson?.readme) {
    // Get the correct base directory for readme field
    const readmeSourceDir = sourceMap.get('readme') ?? targetDir;
    const packageReadmePath = resolve(readmeSourceDir, resolvedPackageJson.readme);
    if (existsSync(packageReadmePath)) {
      finalReadmeReplacementPath = packageReadmePath;
    }
  }

  // Validate README replacement path before creating generator
  if (finalReadmeReplacementPath && !existsSync(finalReadmeReplacementPath)) {
    throw new Error(`README replacement file not found: ${finalReadmeReplacementPath}`);
  }

  // Get package name
  const outputFileName = `${resolvedPackageJson?.name?.replace('/', '-') ?? "package"}-${resolvedPackageJson?.version ?? "0.0.0"}.tgz`;

  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true });
  }

  // Create tar packer with generator and gzip compression
  const packer = createTarPacker(
    createPackEntryGenerator(targetDir, resolvedPackageJson, finalReadmeReplacementPath),
    'gzip');

  // Write compressed tar archive to file
  const outputFile = resolve(outputDir, outputFileName);
  await storeReaderToFile(packer, outputFile);

  return resolvedPackageJson;
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
  inheritableFields: Set<string>) : Promise<any> => {
  // Check if target directory exists
  if (!existsSync(targetDir)) {
    return undefined;
  }

  // Resolve package metadata
  const result = await resolveRawPackageJsonObject(
    targetDir, checkWorkingDirectoryStatus,
    inheritableFields);
  return result.packageJson;
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
