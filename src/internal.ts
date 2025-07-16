// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';

export type PackageMetadata = Record<string, string>;

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
 * Read and parse package.json file
 * @param packagePath - Path to package.json
 * @returns Promise resolving to package metadata
 */
export const readPackageMetadata = async (packagePath: string): Promise<PackageMetadata> => {
  try {
    const content = await readFile(packagePath, 'utf-8');
    const json = JSON.parse(content);
    const map = {};
    flattenObject(json, '', map);
    return map;
  } catch (error) {
    console.warn(`Failed to read package.json from ${packagePath}:`, error);
    return {};
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
 * Merge package metadata with inheritance (child overrides parent)
 * @param parentMetadata - Parent package metadata
 * @param childMetadata - Child package metadata
 * @returns Merged metadata
 */
export const mergePackageMetadata = (
  parentMetadata: PackageMetadata, 
  childMetadata: PackageMetadata
): PackageMetadata => {
  const merged: PackageMetadata = {};
  
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
 * Resolve package metadata for current project with workspace inheritance
 * @param projectRoot - Current project root
 * @returns Promise resolving to resolved package metadata
 */
export const resolvePackageMetadata = async (projectRoot: string): Promise<PackageMetadata> => {
  const workspaceRoot = await findWorkspaceRoot(projectRoot);
  
  if (!workspaceRoot) {
    // No workspace, just read local package.json
    const localPackagePath = join(projectRoot, 'package.json');
    return await readPackageMetadata(localPackagePath);
  }
  
  const projectPackagePath = join(projectRoot, 'package.json');
  
  // Start with root package metadata
  const rootPackagePath = join(workspaceRoot, 'package.json');
  let metadata = await readPackageMetadata(rootPackagePath);
  
  // If current project is not the root, merge with project-specific metadata
  if (projectPackagePath !== rootPackagePath && existsSync(projectPackagePath)) {
    const projectMetadata = await readPackageMetadata(projectPackagePath);
    metadata = mergePackageMetadata(metadata, projectMetadata);
  }
  
  return metadata;
};

/**
 * Generate banner string from package.json metadata
 * @param metadata - Package metadata
 * @param outputKeys - Array of keys to output in specified order
 * @returns Banner string
 */
export const generateBanner = (metadata: PackageMetadata, outputKeys: string[]): string => {
  const parts: string[] = [];
  
  for (const key of outputKeys) {
    const value = metadata[key];
    if (value) {
      parts.push(`${key}: ${value}`);
    }
  }
  
  return parts.length > 0 ? `/*!\n * ${parts.join('\n * ')}\n */` : '';
};

/**
 * Insert banner header at appropriate position considering shebang
 * @param content - The content to insert banner into
 * @param banner - The banner header to insert
 * @returns Content with banner header inserted
 */
export const insertBannerHeader = (content: string, banner: string): string => {
  const lines = content.split('\n');
  
  // Check if first line is shebang
  if (lines.length > 0 && lines[0].startsWith('#!')) {
    // Insert banner after shebang line
    return lines[0] + '\n' + banner + '\n' + lines.slice(1).join('\n');
  } else {
    // Insert banner at the beginning
    return banner + '\n' + content;
  }
};

/**
 * Convert string key to valid TypeScript identifier
 * @param key - The key to convert
 * @returns Valid TypeScript identifier
 */
const sanitizeKey = (key: string): string => {
  // Replace dots and other invalid characters with underscores
  return key.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
};

/**
 * Generate TypeScript metadata file content from package metadata
 * @param metadata - Package metadata
 * @param outputKeys - Array of keys to output
 * @returns TypeScript file content
 */
export const generateMetadataFile = (metadata: PackageMetadata, outputKeys: string[]): string => {
  const lines: string[] = [];
  
  lines.push('// This file is auto-generated by screw-up plugin');
  lines.push('// Do not edit manually');
  lines.push('');
  
  for (const key of outputKeys) {
    const value = metadata[key];
    if (value) {
      const sanitizedKey = sanitizeKey(key);
      const escapedValue = JSON.stringify(value);
      lines.push(`export const ${sanitizedKey} = ${escapedValue};`);
    }
  }
  
  lines.push('');
  
  return lines.join('\n');
};
