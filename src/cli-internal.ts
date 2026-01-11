// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { dirname, isAbsolute, join, resolve } from 'path';
import { createReadStream, existsSync, statSync } from 'fs';
import { mkdir, mkdtemp, writeFile, copyFile, rm, readFile } from 'fs/promises';
import {
  createTarPacker,
  storeReaderToFile,
  extractTo,
  createTarExtractor,
  createEntryItemGenerator,
} from 'tar-vern';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { glob } from 'glob';
import JSON5 from 'json5';
import {
  resolveRawPackageJsonObject,
  findWorkspaceRoot,
  collectWorkspaceSiblings,
  replacePeerDependenciesWildcards,
  Logger,
} from './internal';
import { getFetchGitMetadata } from './analyzer';

// We use async I/O except 'existsSync', because 'exists' will throw an error if the file does not exist.

//////////////////////////////////////////////////////////////////////////////////

const readPackageJsonFile = async (packageJsonPath: string): Promise<any> => {
  const content = await readFile(packageJsonPath, 'utf-8');
  return JSON5.parse(content);
};

const getFilesArray = (packageJson: any): string[] | undefined => {
  if (!packageJson || !Array.isArray(packageJson.files)) {
    return undefined;
  }
  const entries = packageJson.files.filter(
    (entry: unknown): entry is string => typeof entry === 'string'
  );
  return entries.length > 0 ? entries : undefined;
};

const isGlobPattern = (pattern: string): boolean => /[*?[\]{}()]/.test(pattern);

const normalizeFilesPattern = (pattern: string, cwd: string): string | undefined => {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return undefined;
  }
  const isNegated = trimmed.startsWith('!');
  const raw = isNegated ? trimmed.slice(1) : trimmed;
  if (!raw) {
    return undefined;
  }
  if (isGlobPattern(raw)) {
    return trimmed;
  }
  const fullPath = join(cwd, raw);
  if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
    const dirPattern = `${raw.replace(/\/+$/, '')}/**`;
    return isNegated ? `!${dirPattern}` : dirPattern;
  }
  return trimmed;
};

const isSafeRelativePath = (value: string): boolean => {
  if (isAbsolute(value)) {
    return false;
  }
  const segments = value.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..')) {
    return false;
  }
  return true;
};

const expandFilesPatterns = async (
  patterns: string[],
  cwd: string
): Promise<Set<string>> => {
  const includePatterns: string[] = [];
  const excludePatterns: string[] = [];

  for (const pattern of patterns) {
    const normalized = normalizeFilesPattern(pattern, cwd);
    if (!normalized) {
      continue;
    }
    if (normalized.startsWith('!')) {
      excludePatterns.push(normalized.slice(1));
    } else {
      includePatterns.push(normalized);
    }
  }

  const result = new Set<string>();
  for (const pattern of includePatterns) {
    const matches = await glob(pattern, { cwd, nodir: true });
    for (const match of matches) {
      if (isSafeRelativePath(match)) {
        result.add(match);
      }
    }
  }

  for (const pattern of excludePatterns) {
    const matches = await glob(pattern, { cwd, nodir: true });
    for (const match of matches) {
      result.delete(match);
    }
  }

  return result;
};

const mergeFilesPatterns = (
  parentFiles: string[] | undefined,
  childFiles: string[] | undefined
): string[] | undefined => {
  const merged: string[] = [];
  if (parentFiles?.length) {
    merged.push(...parentFiles);
  }
  if (childFiles?.length) {
    merged.push(...childFiles);
  }
  return merged.length > 0 ? merged : undefined;
};

export interface WorkspaceFilesMergeResult {
  readonly workspaceRoot: string;
  readonly parentFiles?: string[];
  readonly childFiles?: string[];
  readonly mergedFiles?: string[];
}

export const resolveWorkspaceFilesMerge = async (
  targetDir: string,
  logger: Logger
): Promise<WorkspaceFilesMergeResult | undefined> => {
  const workspaceRoot = await findWorkspaceRoot(targetDir, logger);
  if (!workspaceRoot) {
    return undefined;
  }
  const rootPackagePath = join(workspaceRoot, 'package.json');
  const targetPackagePath = join(targetDir, 'package.json');
  if (resolve(rootPackagePath) === resolve(targetPackagePath)) {
    return undefined;
  }

  const [rootPackageJson, childPackageJson] = await Promise.all([
    readPackageJsonFile(rootPackagePath),
    readPackageJsonFile(targetPackagePath),
  ]);
  const parentFiles = getFilesArray(rootPackageJson);
  const childFiles = getFilesArray(childPackageJson);
  const mergedFiles = mergeFilesPatterns(parentFiles, childFiles);

  if (!parentFiles && !childFiles) {
    return undefined;
  }

  return {
    workspaceRoot,
    parentFiles,
    childFiles,
    mergedFiles,
  };
};

/**
 * Execute npm pack and return the generated tarball path
 * @param targetDir - Target directory to pack
 * @param packDestDir - Directory to store the generated tarball (must exist)
 * @returns Path to generated tarball
 */
const runNpmPack = async (
  targetDir: string,
  packDestDir: string
): Promise<string> => {
  return new Promise((res, rej) => {
    const npmProcess = spawn(
      'npm',
      ['pack', '--pack-destination', packDestDir],
      {
        cwd: targetDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

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
        // npm pack outputs the filename on stdout (last line or line ending with .tgz)
        const lines = stdout.trim().split('\n');
        // Find the line that ends with .tgz (actual filename) or use the last line
        const filename =
          lines.find((line) => line.trim().endsWith('.tgz')) ||
          lines[lines.length - 1];
        if (filename && filename.trim().endsWith('.tgz')) {
          const fullPath = join(packDestDir, filename.trim());
          res(fullPath);
        } else {
          rej(new Error('npm pack did not output a valid .tgz filename'));
        }
      } else {
        const errorMessage = `npm pack failed with exit code ${code}`;
        const fullError = stderr
          ? `${errorMessage}\nstderr: ${stderr}`
          : errorMessage;
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
 * Packed result
 */
export interface PackedResult {
  readonly packageFileName: string;
  readonly metadata: any;
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
  peerDepsVersionPrefix: string,
  logger: Logger,
  mergeFiles: boolean = true
): Promise<PackedResult | undefined> => {
  // Check if target directory exists
  if (!existsSync(targetDir)) {
    throw new Error(`Target directory is not found: ${targetDir}`);
  }

  let readmeReplacementCandidatePath = readmeReplacementPath;
  if (
    readmeReplacementCandidatePath &&
    !existsSync(readmeReplacementCandidatePath)
  ) {
    throw new Error(
      `README replacement file is not found: ${readmeReplacementCandidatePath}`
    );
  }

  // Get Git metadata fetcher function
  const fetchGitMetadata = getFetchGitMetadata(
    targetDir,
    checkWorkingDirectoryStatus,
    logger
  );

  // Resolve package metadata with source tracking
  const result = await resolveRawPackageJsonObject(
    targetDir,
    fetchGitMetadata,
    alwaysOverrideVersionFromGit,
    inheritableFields,
    logger
  );

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
      const packageJsonReadmePath = join(
        packageJsonReadmeDir,
        packageJsonReadme
      );
      if (!existsSync(packageJsonReadmePath)) {
        throw new Error(
          `README replacement file is not found: ${packageJsonReadmePath}`
        );
      }
      readmeReplacementCandidatePath = packageJsonReadmePath;
    }
    // Always remove it.
    delete resolvedPackageJson.readme;
  }

  // Replace peerDependencies wildcards if enabled and in workspace
  if (replacePeerDepsWildcards) {
    const workspaceRoot = await findWorkspaceRoot(targetDir, logger);
    if (workspaceRoot) {
      const siblings = await collectWorkspaceSiblings(
        workspaceRoot,
        fetchGitMetadata,
        alwaysOverrideVersionFromGit,
        inheritableFields,
        logger
      );
      if (siblings.size > 0) {
        resolvedPackageJson = replacePeerDependenciesWildcards(
          resolvedPackageJson,
          siblings,
          peerDepsVersionPrefix
        );
      }
    }
  }

  const filesMergeEnabled = mergeFiles && inheritableFields.has('files');
  const workspaceFilesMerge = filesMergeEnabled
    ? await resolveWorkspaceFilesMerge(targetDir, logger)
    : undefined;
  if (filesMergeEnabled && workspaceFilesMerge?.mergedFiles) {
    resolvedPackageJson.files = workspaceFilesMerge.mergedFiles;
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

    // Step 3: Process extracted files (files merge/package.json/README replacement)
    const packageRoot = join(stagingDir, 'package');

    if (filesMergeEnabled && workspaceFilesMerge?.parentFiles?.length) {
      const parentFiles = await expandFilesPatterns(
        workspaceFilesMerge.parentFiles,
        workspaceFilesMerge.workspaceRoot
      );
      for (const parentFile of parentFiles) {
        const destPath = join(packageRoot, parentFile);
        if (existsSync(destPath)) {
          continue;
        }
        await mkdir(dirname(destPath), { recursive: true });
        await copyFile(
          join(workspaceFilesMerge.workspaceRoot, parentFile),
          destPath
        );
      }
    }

    // Replace package.json with our processed version
    const packageJsonPath = join(packageRoot, 'package.json');
    if (existsSync(packageJsonPath)) {
      await writeFile(
        packageJsonPath,
        JSON.stringify(resolvedPackageJson, null, 2)
      );
    }

    // Replace README.md
    if (readmeReplacementCandidatePath) {
      const readmeDestPath = join(packageRoot, 'README.md');
      await copyFile(readmeReplacementCandidatePath, readmeDestPath);
    }

    // Step 4: Re-create tarball with modified files
    const outputFileName = `${resolvedPackageJson?.name?.replace('/', '-') ?? 'package'}-${resolvedPackageJson?.version ?? '0.0.0'}.tgz`;
    await mkdir(outputDir, { recursive: true });
    const outputFile = join(outputDir, outputFileName);

    // Re-packing final tar file from the modified staging directory
    const itemGenerator = createEntryItemGenerator(stagingDir);
    const packer = createTarPacker(itemGenerator, 'gzip');
    await storeReaderToFile(packer, outputFile);

    // PackedResult
    return {
      packageFileName: outputFileName,
      metadata: resolvedPackageJson,
    };
  } finally {
    // Clean up temporary directory
    await rm(baseTempDir, { recursive: true, force: true });
  }
};

/**
 * Get computed package.json object
 * @param targetDir - Target directory to resolve package metadata
 * @param fetchGitMetadata - Git metadata fetcher
 * @param inheritableFields - Package metadata fields that should be inherited from parent
 * @returns Computed package.json object or undefined if failed
 */
export const getComputedPackageJsonObject = async (
  targetDir: string,
  fetchGitMetadata: () => Promise<any>,
  alwaysOverrideVersionFromGit: boolean,
  inheritableFields: Set<string>,
  logger: Logger,
  ignoreNotExist: boolean = false
): Promise<any> => {
  // Check if target directory exists
  if (!existsSync(targetDir)) {
    return undefined;
  }

  // Resolve package metadata
  const result = await resolveRawPackageJsonObject(
    targetDir,
    fetchGitMetadata,
    alwaysOverrideVersionFromGit,
    inheritableFields,
    logger,
    ignoreNotExist
  );
  return result.metadata;
};

//////////////////////////////////////////////////////////////////////////////////

export interface ParsedArgs {
  readonly argv: string[];
  readonly command?: string;
  readonly positional: string[];
  readonly options: Record<string, string | boolean>;
}

/**
 * Parse command line arguments
 * @param args - Command line arguments
 * @param argOptionMap - Map of command options to their argument options
 * @returns Parsed arguments
 */
export const parseArgs = (
  args: string[],
  argOptionMap: Map<string, Set<string>>
): ParsedArgs => {
  const result: any = {
    argv: args,
    positional: [],
    options: {},
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const optionName = arg.slice(2);
      // Found option bedore command
      if (!result.command) {
        // Always flag option
        result.options[optionName] = true;
      } else {
        // Detect an argument option in the command
        const argOptions = argOptionMap.get(result.command);
        if (argOptions?.has(optionName)) {
          // Option has an argument
          i++;
          result.options[optionName] = args[i];
        } else {
          // Option is flag
          result.options[optionName] = true;
        }
      }
      // Single hyphen option is flag unless configured with an argument
    } else if (arg.startsWith('-')) {
      const optionName = arg.slice(1);
      if (optionName.length == 1) {
        const argOptions = result.command
          ? argOptionMap.get(result.command)
          : undefined;
        if (argOptions?.has(optionName)) {
          i++;
          result.options[optionName] = args[i];
        } else {
          result.options[optionName] = true;
        }
      }
    } else if (!result.command) {
      result.command = arg;
    } else {
      result.positional.push(arg);
    }
  }

  return result;
};
