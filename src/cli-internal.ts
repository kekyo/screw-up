// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { resolve } from 'path';
import { glob } from 'glob';
import { existsSync, Stats } from 'fs';
import { mkdir, lstat } from 'fs/promises';
import { createTarPacker, createReadFileItem, createFileItem, storeReaderToFile } from 'tar-vern';
import { resolveRawPackageJsonObject } from './internal.js';

//////////////////////////////////////////////////////////////////////////////////

/**
 * Pack entry
 */
interface PackEntry {
  name: string;
  content?: string;
  filePath?: string;
  stat?: Stats;
}

/**
 * Create tar entry generator
 * @param entries - Pack entries
 * @param baseDir - Base directory
 * @returns Tar entry generator
 */
const createTarEntryGenerator = async function* (entries: PackEntry[], baseDir: string) {
  for (const entry of entries) {
    if (entry.content !== undefined) {
      // If content is defined, create a file item
      yield await createFileItem(entry.name, entry.content);
    } else if (entry.filePath && entry.stat) {
      // If filePath and stat are defined, create a file item
      yield await createReadFileItem(entry.name, resolve(baseDir, entry.filePath));
    }
  }
};

// Package metadata fields that should be inherited from parent
const defaultInheritableFields = new Set([
  'version',
  'description', 
  'author',
  'license',
  'repository',
  'keywords',
  'homepage',
  'bugs'
]);

/**
 * Pack assets into a tar archive
 * @param targetDir - Target directory to pack
 * @param outputDir - Output directory to write the tarball
 * @param checkWorkingDirectoryStatus - Check working directory status
 * @param inheritableFields - Package metadata fields that should be inherited from parent
 * @returns Package metadata (package.json) or undefined if failed
 */
export const packAssets = async (
  targetDir: string,
  outputDir: string,
  checkWorkingDirectoryStatus: boolean,
  inheritableFields?: Set<string>) : Promise<any> => {
  // Check if target directory exists
  if (!existsSync(targetDir)) {
    return undefined;
  }

  // Resolve package metadata
  let resolvedPackageJson: any;
  try {
    resolvedPackageJson = await resolveRawPackageJsonObject(
      targetDir, checkWorkingDirectoryStatus,
      inheritableFields ?? defaultInheritableFields);
  } catch (error) {
    // If package.json cannot be read (e.g., file doesn't exist), return undefined
    // This matches npm pack behavior which requires package.json
    return undefined;
  }

  // Check if package is private
  if (resolvedPackageJson?.private) {
    return undefined;
  }

  // Get package name
  const outputFileName = `${resolvedPackageJson?.name?.replace('/', '-') ?? "package"}-${resolvedPackageJson?.version ?? "0.0.0"}.tgz`;

  // Collect all entries first
  const packEntries: PackEntry[] = [];

  // Add `package.json` content
  const packageJsonContent = JSON.stringify(resolvedPackageJson, null, 2);
  packEntries.push({ name: 'package.json', content: packageJsonContent });

  // Get distribution files in `package.json`
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

  // Collect target packing files to add to archive
  for (const packingFilePath of packingFilePaths) {
    // Except `package.json`
    if (packingFilePath !== 'package.json') {
      // Is file regular?
      const fullPath = resolve(targetDir, packingFilePath);
      const stat = await lstat(fullPath);
      if (stat.isFile()) {
        // Add regular file
        packEntries.push({ name: packingFilePath, filePath: packingFilePath, stat });
      }
    }
  }

  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true });
  }

  // Create tar packer with entries and gzip compression
  const packer = createTarPacker(createTarEntryGenerator(packEntries, targetDir), 'gzip');
  
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
  inheritableFields?: Set<string>) : Promise<any> => {
  // Check if target directory exists
  if (!existsSync(targetDir)) {
    return undefined;
  }

  // Resolve package metadata
  const resolvedPackageJson = await resolveRawPackageJsonObject(
    targetDir, checkWorkingDirectoryStatus,
    inheritableFields ?? defaultInheritableFields);
  return resolvedPackageJson;
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

        if (nextArg && !nextArg.startsWith('-')) {
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

      if (nextArg && !nextArg.startsWith('-')) {
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
