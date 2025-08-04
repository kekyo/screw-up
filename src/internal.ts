// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { glob } from 'glob';
import JSON5 from 'json5';
import { PackageMetadata } from './types';

// We use async I/O except 'existsSync', because 'exists' will throw an error if the file does not exist.

//////////////////////////////////////////////////////////////////////////////////

/**
 * Logger interface
 */
export interface Logger {
  /**
   * Log an debug message
   * @param msg - The message to log
   */
  readonly debug: (msg: string) => void;
  /**
   * Log an info message
   * @param msg - The message to log
   */
  readonly info: (msg: string) => void;
  /**
   * Log a warning message
   * @param msg - The message to log
   */
  readonly warn: (msg: string) => void;
  /**
   * Log an error message
   * @param msg - The message to log
   */
  readonly error: (msg: string) => void;
}

/**
* Default console logger implementation
*/
export const createConsoleLogger = (): Logger => {
  return {
    debug: (msg: string) => console.debug(msg),
    info: (msg: string) => console.info(msg),
    warn: (msg: string) => console.warn(msg),
    error: (msg: string) => console.error(msg)
  };
};

//////////////////////////////////////////////////////////////////////////////////

/**
 * Result of package resolution with source tracking
 * @template T - Type of the package metadata
 */
export interface PackageResolutionResult<T> {
  readonly metadata: T;
  readonly sourceMap: Map<string, string>;
}

/**
 * Workspace sibling project information
 */
export interface WorkspaceSibling {
  readonly name: string;
  readonly version: string;
  readonly path: string;
}

/**
 * Recursively flatten an object into dot-notation key-value pairs
 * @param obj - Object to flatten
 * @param prefix - Current key prefix
 * @param map - Store key-value entries into this
 */
const flattenObject = (obj: any, prefix: string, map: PackageMetadata) => {
  for (const [key, value] of Object.entries(obj)) {
    if (!value)
      continue;
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      map[fullKey] = value;
    } else if (Array.isArray(value)) {
      map[fullKey] = value.map(v => String(v)).join(',');
    } else if (typeof value === 'object') {
      // Recursively flatten nested objects
      flattenObject(value, fullKey, map);
    } else {
      // Convert other types to string
      map[fullKey] = String(value);
    }
  }
};

/**
 * Find workspace root by looking for workspace configuration files
 * @param startPath - Starting directory path
 * @param logger - Logger instance
 * @returns Promise resolving to workspace root path or undefined if not found
 */
export const findWorkspaceRoot = async (startPath: string, logger: Logger): Promise<string | undefined> => {
  let currentPath = startPath;
  
  while (currentPath !== dirname(currentPath)) {
    const packageJsonPath = join(currentPath, 'package.json');
    
    if (existsSync(packageJsonPath)) {
      try {
        const content = await readFile(packageJsonPath, 'utf-8');
        const packageJson = JSON5.parse(content);
        
        // Check for workspace configurations
        if (packageJson.workspaces || 
            existsSync(join(currentPath, 'pnpm-workspace.yaml')) ||
            existsSync(join(currentPath, 'lerna.json'))) {
          return currentPath;
        }
      } catch (error) {
        logger.warn(`Failed to parse package.json at ${packageJsonPath}: ${error}`);
      }
    }
    
    currentPath = dirname(currentPath);
  }
  
  return undefined;
};

/**
 * Collect workspace sibling projects
 * @param workspaceRoot - Workspace root directory
 * @param fetchGitMetadata - Git metadata fetcher
 * @param alwaysOverrideVersionFromGit - Always override version from Git
 * @param inheritableFields - Package metadata fields that should be inherited from parent
 * @param logger - Logger instance
 * @returns Promise resolving to map of sibling projects (name -> WorkspaceSibling)
 */
export const collectWorkspaceSiblings = async (
  workspaceRoot: string,
  fetchGitMetadata: () => Promise<any>,
  alwaysOverrideVersionFromGit: boolean,
  inheritableFields: Set<string>,
  logger: Logger
): Promise<Map<string, WorkspaceSibling>> => {
  const siblings = new Map<string, WorkspaceSibling>();
  
  try {
    const rootPackageJsonPath = join(workspaceRoot, 'package.json');
    const content = await readFile(rootPackageJsonPath, 'utf-8');
    const rootPackageJson = JSON5.parse(content);
    
    // Get workspace patterns
    const workspacePatterns = rootPackageJson.workspaces;
    if (!workspacePatterns || !Array.isArray(workspacePatterns)) {
      return siblings;
    }
    
    // Find all workspace directories
    const workspaceDirs = new Set<string>();
    for (const pattern of workspacePatterns) {
      const matches = await glob(pattern, { 
        cwd: workspaceRoot
      });
      matches.forEach(match => workspaceDirs.add(match));
    }

    // Read package.json from each workspace directory
    for (const workspaceDir of workspaceDirs) {
      const packageJsonPath = join(workspaceRoot, workspaceDir, 'package.json');
      if (existsSync(packageJsonPath)) {
        try {
          const packagePath = join(workspaceRoot, workspaceDir);
          
          // Use resolveRawPackageJsonObject to get the resolved version with Git tag consideration
          const resolvedPackage = await resolveRawPackageJsonObject(
            packagePath,
            fetchGitMetadata,
            alwaysOverrideVersionFromGit,
            inheritableFields,
            logger
          );
          
          const packageJson = resolvedPackage.metadata;
          
          if (packageJson.name && packageJson.version) {
            siblings.set(packageJson.name, {
              name: packageJson.name,
              version: packageJson.version,
              path: packagePath
            });
          }
        } catch (error) {
          logger.warn(`Failed to resolve package.json from ${packageJsonPath}: ${error}`);
        }
      }
    }
  } catch (error) {
    logger.warn(`Failed to collect workspace siblings from ${workspaceRoot}: ${error}`);
  }
  
  return siblings;
};

/**
 * Replace "*" wildcards in peerDependencies with actual workspace sibling versions
 * @param packageJson - Package.json object to modify
 * @param siblings - Map of workspace sibling projects
 * @param versionPrefix - Version prefix to add (e.g., "^", "~", "")
 * @returns Modified package.json object
 */
export const replacePeerDependenciesWildcards = (
  packageJson: any,
  siblings: Map<string, WorkspaceSibling>,
  versionPrefix: string
): any => {
  // Deep clone the package.json to avoid modifying the original
  const modifiedPackageJson = JSON5.parse(JSON.stringify(packageJson));
  
  if (!modifiedPackageJson.peerDependencies || typeof modifiedPackageJson.peerDependencies !== 'object') {
    return modifiedPackageJson;
  }
  
  // Process each peer dependency
  for (const [depName, depVersion] of Object.entries(modifiedPackageJson.peerDependencies)) {
    if (depVersion === '*' && siblings.has(depName)) {
      const sibling = siblings.get(depName)!;
      modifiedPackageJson.peerDependencies[depName] = `${versionPrefix}${sibling.version}`;
    }
  }
  
  return modifiedPackageJson;
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Merge package metadata with inheritance (child overrides parent)
 * @param fetchGitMetadata - Git metadata fetcher
 * @param alwaysOverrideVersionFromGit - Always override version from Git
 * @param sourceMap - Map to track field sources
 * @param parentMetadata - Parent package metadata
 * @param childMetadata - Child package metadata
 * @param parentSourceDir - Parent package.json directory (for source tracking)
 * @param childSourceDir - Child package.json directory (for source tracking)
 * @returns Merged package metadata
 */
export const mergePackageMetadata = async (
  fetchGitMetadata: () => Promise<any>,
  alwaysOverrideVersionFromGit: boolean,
  sourceMap: Map<string, string>,
  parentMetadata: PackageMetadata, 
  childMetadata: PackageMetadata,
  parentSourceDir: string,
  childSourceDir: string,
  _repositoryPath: string): Promise<PackageMetadata> => {
  // Fetch git metadata
  const metadata = await fetchGitMetadata();

  const merged: PackageMetadata = { };
  flattenObject(metadata, '', merged);

  // Start with parent metadata
  for (const key in parentMetadata) {
    const value = parentMetadata[key];
    if (value !== undefined) {
      merged[key] = value;
      sourceMap.set(key, parentSourceDir);
    }
  }

  // Override with child metadata
  for (const key in childMetadata) {
    const value = childMetadata[key];
    if (value !== undefined) {
      merged[key] = value;
      sourceMap.set(key, childSourceDir);
    }
  }

  // Always override version from Git if enabled (new default behavior)
  if (alwaysOverrideVersionFromGit && metadata.version) {
    merged.version = metadata.version;
  }
  
  return merged;
};

/**
 * Merge raw package.json objects with inheritance (child overrides parent)
 * Only inherits package metadata fields, not project-specific configurations
 * @param fetchGitMetadata - Git metadata fetcher
 * @param alwaysOverrideVersionFromGit - Always override version from Git
 * @param inheritableFields - Package metadata fields that should be inherited from parent
 * @param sourceMap - Map to track field sources
 * @param parentMetadata - Parent package object
 * @param childMetadata - Child package object
 * @param parentSourceDir - Parent package.json directory (for source tracking)
 * @param childSourceDir - Child package.json directory (for source tracking)
 * @param repositoryPath - Path to Git repository root
 * @returns Merged package object with only metadata fields
 */
const mergeRawPackageJson = async (
  fetchGitMetadata: () => Promise<any>,
  alwaysOverrideVersionFromGit: boolean,
  inheritableFields: Set<string>,
  sourceMap: Map<string, string>,
  parentMetadata: any,
  childMetadata: any,
  parentSourceDir: string,
  childSourceDir: string,
  repositoryPath: string
): Promise<any> => {

  // Fetch git metadata
  const gitMetadata = await fetchGitMetadata();
  const merged = { ...gitMetadata };

  // Start with parent metadata
  for (const key in parentMetadata) {
    if (inheritableFields.has(key)) {
      const value = parentMetadata[key];
      if (value !== undefined) {
        merged[key] = value;
        sourceMap.set(key, parentSourceDir);
      }
    }
  }

  // Override with child metadata
  for (const key in childMetadata) {
    const value = childMetadata[key];
    if (value !== undefined) {
      merged[key] = value;
      sourceMap.set(key, childSourceDir);
    }
  }

  // Always override version from Git if enabled (new default behavior)
  if (alwaysOverrideVersionFromGit && gitMetadata.version) {
    merged.version = gitMetadata.version;
    sourceMap.set('version', repositoryPath); // Mark as Git-sourced
  }

  return merged;
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Resolve package metadata for current project with workspace inheritance
 * @param projectRoot - Current project root
 * @param logger - Logger instance
 * @param readPackageMetadataFn - Function to read package metadata
 * @param mergePackageMetadataFn - Function to merge package metadata
 * @returns Promise resolving to resolved package metadata
 */
const resolvePackageMetadataT = async <T>(
  projectRoot: string,
  logger: Logger,
  readPackageMetadataFn: (path: string) => Promise<T>,
  mergePackageMetadataFn: (a: T, b: T, aDir: string, bDir: string, repositoryPath: string) => Promise<T>): Promise<T> => {

  const workspaceRoot = await findWorkspaceRoot(projectRoot, logger);

  if (!workspaceRoot) {
    // No workspace, just read local package.json
    const localPackagePath = join(projectRoot, 'package.json');
    const localMetadata = await readPackageMetadataFn(localPackagePath);
    return mergePackageMetadataFn(
      {} as T,
      localMetadata,
      '',  // dummy
      projectRoot,
      projectRoot);
  }

  const projectPackagePath = join(projectRoot, 'package.json');

  // Start with root package metadata
  const rootPackagePath = join(workspaceRoot, 'package.json');
  const metadata = await readPackageMetadataFn(rootPackagePath);

  // If current project is not the root, merge with project-specific metadata
  if (projectPackagePath !== rootPackagePath && existsSync(projectPackagePath)) {
    const projectMetadata = await readPackageMetadataFn(projectPackagePath);
    return mergePackageMetadataFn(
      metadata, projectMetadata,
      workspaceRoot, projectRoot,
      projectRoot);
  } else {
    return mergePackageMetadataFn(
      {} as T,
      metadata,
      '',  // dummy
      workspaceRoot,
      projectRoot);
  }
};

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Read and parse package.json file
 * @param logger - Logger instance
 * @param packagePath - Path to package.json
 * @returns Promise resolving to package metadata
 */
const readPackageMetadata = async (logger: Logger, packagePath: string): Promise<PackageMetadata> => {
  try {
    const content = await readFile(packagePath, 'utf-8');
    const json = JSON5.parse(content);
    const map: PackageMetadata = {};
    flattenObject(json, '', map);
    return map;
  } catch (error) {
    logger.error(`Failed to read package.json from ${packagePath}: ${error}`);
    return {};
  }
};

/**
 * Resolve package metadata for current project with workspace inheritance
 * @param projectRoot - Current project root
 * @param fetchGitMetadata - Git metadata fetcher
 * @param alwaysOverrideVersionFromGit - Always override version from Git
 * @param logger - Logger instance
 * @returns Promise resolving to resolved package metadata
 */
export const resolvePackageMetadata = async (
  projectRoot: string,
  fetchGitMetadata: () => Promise<any>,
  alwaysOverrideVersionFromGit: boolean,
  logger: Logger): Promise<PackageResolutionResult<PackageMetadata>> => {
  const sourceMap = new Map<string, string>();
  const metadata = await resolvePackageMetadataT<PackageMetadata>(
    projectRoot,
    logger,
    readPackageMetadata.bind(undefined, logger),
    mergePackageMetadata.bind(undefined, fetchGitMetadata, alwaysOverrideVersionFromGit, sourceMap));

  return {
    metadata,
    sourceMap
  };
};

/**
 * Read and parse package.json file without flattening
 * @param logger - Logger instance
 * @param packagePath - Path to package.json
 * @returns Promise resolving to raw package object
 */
const readRawPackageJson = async (logger: Logger, packagePath: string): Promise<any> => {
  try {
    const content = await readFile(packagePath, 'utf-8');
    return JSON5.parse(content);
  } catch (error) {
    logger.error(`Failed to read package.json from ${packagePath}: ${error}`);
    throw error;
  }
};

/**
 * Resolve raw package.json for current project with workspace inheritance
 * @param projectRoot - Current project root
 * @param fetchGitMetadata - Git metadata fetcher
 * @param alwaysOverrideVersionFromGit - Always override version from Git
 * @param inheritableFields - Package metadata fields that should be inherited from parent
 * @param logger - Logger instance
 * @returns Promise resolving to resolved raw package.json object with source tracking
 */
export const resolveRawPackageJsonObject = async (
  projectRoot: string,
  fetchGitMetadata: () => Promise<any>,
  alwaysOverrideVersionFromGit: boolean,
  inheritableFields: Set<string>,
  logger: Logger): Promise<PackageResolutionResult<any>> => {
  const sourceMap = new Map<string, string>();
  const packageJson = await resolvePackageMetadataT<any>(
    projectRoot,
    logger,
    readRawPackageJson.bind(undefined, logger),
    mergeRawPackageJson.bind(undefined, fetchGitMetadata, alwaysOverrideVersionFromGit, inheritableFields, sourceMap));

  return {
    metadata: packageJson,
    sourceMap
  };
};
