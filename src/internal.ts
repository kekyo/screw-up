// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { glob } from 'glob';
import JSON5 from 'json5';
import { getGitMetadata } from './analyzer.js';
import { PackageMetadata } from './types.js';

// We use async I/O except 'existsSync', because 'exists' will throw an error if the file does not exist.

//////////////////////////////////////////////////////////////////////////////////

/**
 * Result of package resolution with source tracking
 * @template T - Type of the package metadata
 */
export interface PackageResolutionResult<T> {
  metadata: T;
  sourceMap: Map<string, string>;
}

/**
 * Workspace sibling project information
 */
export interface WorkspaceSibling {
  name: string;
  version: string;
  path: string;
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
 * @returns Promise resolving to workspace root path or undefined if not found
 */
export const findWorkspaceRoot = async (startPath: string): Promise<string | undefined> => {
  let currentPath = startPath;
  
  while (currentPath !== dirname(currentPath)) {
    const packageJsonPath = join(currentPath, 'package.json');
    
    if (existsSync(packageJsonPath)) {
      try {
        const content = await readFile(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(content);
        
        // Check for workspace configurations
        if (packageJson.workspaces || 
            existsSync(join(currentPath, 'pnpm-workspace.yaml')) ||
            existsSync(join(currentPath, 'lerna.json'))) {
          return currentPath;
        }
      } catch (error) {
        console.warn(`Failed to parse package.json at ${packageJsonPath}:`, error);
      }
    }
    
    currentPath = dirname(currentPath);
  }
  
  return undefined;
};

/**
 * Collect workspace sibling projects
 * @param workspaceRoot - Workspace root directory
 * @returns Promise resolving to map of sibling projects (name -> WorkspaceSibling)
 */
export const collectWorkspaceSiblings = async (workspaceRoot: string): Promise<Map<string, WorkspaceSibling>> => {
  const siblings = new Map<string, WorkspaceSibling>();
  
  try {
    const rootPackageJsonPath = join(workspaceRoot, 'package.json');
    const content = await readFile(rootPackageJsonPath, 'utf-8');
    const rootPackageJson = JSON.parse(content);
    
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
          const packageContent = await readFile(packageJsonPath, 'utf-8');
          const packageJson = JSON.parse(packageContent);
          
          if (packageJson.name && packageJson.version) {
            siblings.set(packageJson.name, {
              name: packageJson.name,
              version: packageJson.version,
              path: join(workspaceRoot, workspaceDir)
            });
          }
        } catch (error) {
          console.warn(`Failed to read package.json from ${packageJsonPath}:`, error);
        }
      }
    }
  } catch (error) {
    console.warn(`Failed to collect workspace siblings from ${workspaceRoot}:`, error);
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
  const modifiedPackageJson = JSON.parse(JSON.stringify(packageJson));
  
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
 * @param checkWorkingDirectoryStatus - Check working directory status to increase version
 * @param alwaysOverrideVersionFromGit - Always override version from Git
 * @param sourceMap - Map to track field sources
 * @param parentMetadata - Parent package metadata
 * @param childMetadata - Child package metadata
 * @param parentSourceDir - Parent package.json directory (for source tracking)
 * @param childSourceDir - Child package.json directory (for source tracking)
 * @param repositoryPath - Path to Git repository root
 * @returns Merged package metadata
 */
export const mergePackageMetadata = async (
  checkWorkingDirectoryStatus: boolean,
  alwaysOverrideVersionFromGit: boolean,
  sourceMap: Map<string, string>,
  parentMetadata: PackageMetadata, 
  childMetadata: PackageMetadata,
  parentSourceDir: string,
  childSourceDir: string,
  repositoryPath: string): Promise<PackageMetadata> => {
  // Start with default git metadata if repositoryPath is provided
  const metadata = await getGitMetadata(repositoryPath, checkWorkingDirectoryStatus);

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
 * @param checkWorkingDirectoryStatus - Check working directory status to increase version
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
  checkWorkingDirectoryStatus: boolean,
  alwaysOverrideVersionFromGit: boolean,
  inheritableFields: Set<string>,
  sourceMap: Map<string, string>,
  parentMetadata: any,
  childMetadata: any,
  parentSourceDir: string,
  childSourceDir: string,
  repositoryPath: string,
): Promise<any> => {

  // Start with default git metadata if repositoryPath is provided
  const gitMetadata = await getGitMetadata(repositoryPath, checkWorkingDirectoryStatus) as any;
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
 * @param readPackageMetadataFn - Function to read package metadata
 * @param mergePackageMetadataFn - Function to merge package metadata
 * @returns Promise resolving to resolved package metadata
 */
const resolvePackageMetadataT = async <T>(
  projectRoot: string,
  readPackageMetadataFn: (path: string) => Promise<T>,
  mergePackageMetadataFn: (a: T, b: T, aDir: string, bDir: string, repositoryPath: string) => Promise<T>): Promise<T> => {

  const workspaceRoot = await findWorkspaceRoot(projectRoot);

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
 * @param packagePath - Path to package.json
 * @returns Promise resolving to package metadata
 */
const readPackageMetadata = async (packagePath: string): Promise<PackageMetadata> => {
  try {
    const content = await readFile(packagePath, 'utf-8');
    const json = JSON5.parse(content);
    const map: PackageMetadata = {};
    flattenObject(json, '', map);
    return map;
  } catch (error) {
    console.error(`Failed to read package.json from ${packagePath}:`, error);
    return {};
  }
};

/**
 * Resolve package metadata for current project with workspace inheritance
 * @param projectRoot - Current project root
 * @param checkWorkingDirectoryStatus - Check working directory status to increase version
 * @param alwaysOverrideVersionFromGit - Always override version from Git
 * @returns Promise resolving to resolved package metadata
 */
export const resolvePackageMetadata = async (
  projectRoot: string,
  checkWorkingDirectoryStatus: boolean,
  alwaysOverrideVersionFromGit: boolean): Promise<PackageResolutionResult<PackageMetadata>> => {
  const sourceMap = new Map<string, string>();
  const metadata = await resolvePackageMetadataT<PackageMetadata>(
    projectRoot,
    readPackageMetadata,
    mergePackageMetadata.bind(null, checkWorkingDirectoryStatus, alwaysOverrideVersionFromGit, sourceMap));

  return {
    metadata,
    sourceMap
  };
};

/**
 * Read and parse package.json file without flattening
 * @param packagePath - Path to package.json
 * @returns Promise resolving to raw package object
 */
const readRawPackageJson = async (packagePath: string): Promise<any> => {
  try {
    const content = await readFile(packagePath, 'utf-8');
    return JSON5.parse(content);
  } catch (error) {
    console.error(`Failed to read package.json from ${packagePath}:`, error);
    throw error;
  }
};

/**
 * Resolve raw package.json for current project with workspace inheritance
 * @param projectRoot - Current project root
 * @param checkWorkingDirectoryStatus - Check working directory status
 * @param alwaysOverrideVersionFromGit - Always override version from Git
 * @param inheritableFields - Package metadata fields that should be inherited from parent
 * @returns Promise resolving to resolved raw package.json object with source tracking
 */
export const resolveRawPackageJsonObject = async (
  projectRoot: string,
  checkWorkingDirectoryStatus: boolean,
  alwaysOverrideVersionFromGit: boolean,
  inheritableFields: Set<string>): Promise<PackageResolutionResult<any>> => {
  const sourceMap = new Map<string, string>();
  const packageJson = await resolvePackageMetadataT<any>(
    projectRoot,
    readRawPackageJson,
    mergeRawPackageJson.bind(null, checkWorkingDirectoryStatus, alwaysOverrideVersionFromGit, inheritableFields, sourceMap));

  return {
    metadata: packageJson,
    sourceMap
  };
};
