// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import JSON5 from 'json5';
import { getGitMetadata } from './analyzer.js';
import { PackageMetadata } from './types.js';

/**
 * Result of package resolution with source tracking
 */
export interface PackageResolutionResult {
  packageJson: any;
  sourceMap: Map<string, string>;
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

//////////////////////////////////////////////////////////////////////////////////////

/**
 * Merge package metadata with inheritance (child overrides parent)
 * @param parentMetadata - Parent package metadata
 * @param childMetadata - Child package metadata
 * @param repositoryPath - Path to Git repository root
 * @param checkWorkingDirectoryStatus - Check working directory status to increase version
 * @returns Merged metadata
 */
export const mergePackageMetadata = async (
  parentMetadata: PackageMetadata, 
  childMetadata: PackageMetadata,
  repositoryPath: string,
  checkWorkingDirectoryStatus: boolean) => {
  // Start with default git metadata if repositoryPath is provided
  const metadata = await getGitMetadata(repositoryPath, checkWorkingDirectoryStatus);

  const merged: PackageMetadata = { };
  flattenObject(metadata, '', merged);

  // Start with parent metadata
  for (const key in parentMetadata) {
    const value = parentMetadata[key];
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  // Override with child metadata
  for (const key in childMetadata) {
    const value = childMetadata[key];
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  
  return merged;
};

/**
 * Merge raw package.json objects with inheritance (child overrides parent)
 * Only inherits package metadata fields, not project-specific configurations
 * @param parentMetadata - Parent package object
 * @param childMetadata - Child package object
 * @param parentSourceDir - Parent package.json directory (for source tracking)
 * @param childSourceDir - Child package.json directory (for source tracking)
 * @param repositoryPath - Path to Git repository root
 * @param checkWorkingDirectoryStatus - Check working directory status to increase version
 * @param inheritableFields - Package metadata fields that should be inherited from parent
 * @param sourceMap - Map to track field sources
 * @returns Merged package object with only metadata fields
 */
const mergeRawPackageJson = async (
  parentMetadata: any,
  childMetadata: any,
  parentSourceDir: string,
  childSourceDir: string,
  repositoryPath: string,
  checkWorkingDirectoryStatus: boolean,
  inheritableFields: Set<string>,
  sourceMap: Map<string, string>) => {
  // Start with default git metadata if repositoryPath is provided
  const merged = await getGitMetadata(repositoryPath, checkWorkingDirectoryStatus) as any;
  
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
 
  return merged;
};


//////////////////////////////////////////////////////////////////////////////////////

/**
 * Resolve package metadata for current project with workspace inheritance
 * @param projectRoot - Current project root
 * @param checkWorkingDirectoryStatus - Check working directory status to increase version
 * @param readPackageMetadataFn - Function to read package metadata
 * @param mergePackageMetadataFn - Function to merge package metadata
 * @returns Promise resolving to resolved package metadata
 */
const resolvePackageMetadataT = async <T>(
  projectRoot: string,
  checkWorkingDirectoryStatus: boolean,
  readPackageMetadataFn: (path: string) => Promise<T>,
  mergePackageMetadataFn: (a: T, b: T, aDir: string, bDir: string, repositoryPath: string, checkWorkingDirectoryStatus: boolean) => Promise<T>): Promise<T> => {
  
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
      projectRoot,
      checkWorkingDirectoryStatus);
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
      projectRoot,
      checkWorkingDirectoryStatus);
  } else {
    return mergePackageMetadataFn(
      {} as T,
      metadata,
      '',  // dummy
      workspaceRoot,
      projectRoot,
      checkWorkingDirectoryStatus);
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
 * @returns Promise resolving to resolved package metadata
 */
export const resolvePackageMetadata = (projectRoot: string, checkWorkingDirectoryStatus: boolean): Promise<PackageMetadata> => {
  return resolvePackageMetadataT<PackageMetadata>(
    projectRoot,
    checkWorkingDirectoryStatus,
    readPackageMetadata,
    (parentMetadata, childMetadata, _parentDir, _childDir, repositoryPath, checkWorkingDirectoryStatus) =>
      mergePackageMetadata(parentMetadata, childMetadata, repositoryPath, checkWorkingDirectoryStatus));
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
 * @param inheritableFields - Package metadata fields that should be inherited from parent
 * @returns Promise resolving to resolved raw package.json object with source tracking
 */
export const resolveRawPackageJsonObject = async (
  projectRoot: string,
  checkWorkingDirectoryStatus: boolean,
  inheritableFields: Set<string>): Promise<PackageResolutionResult> => {
  const sourceMap = new Map<string, string>();
  const packageJson = await resolvePackageMetadataT<any>(
    projectRoot,
    checkWorkingDirectoryStatus,
    readRawPackageJson,
    (parentMetadata, childMetadata, parentSourceDir, childSourceDir, repositoryPath, checkWorkingDirectoryStatus) =>
      mergeRawPackageJson(
        parentMetadata, childMetadata, parentSourceDir, childSourceDir, repositoryPath, checkWorkingDirectoryStatus, inheritableFields, sourceMap));
  return {
    packageJson,
    sourceMap
  };
};
