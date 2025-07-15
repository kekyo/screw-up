// Screw-UP - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import type { Plugin } from 'vite';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { globSync } from 'glob';

interface PackageMetadata {
  name?: string;
  version?: string;
  description?: string;
  author?: string | { name: string; email?: string };
  license?: string;
}

/**
 * Generate banner string from package.json metadata
 * @param metadata - Package metadata
 * @returns Banner string
 */
export const generateBanner = (metadata: PackageMetadata): string => {
  const name = metadata.name || 'Unknown Package';
  const version = metadata.version || '0.0.0';
  const description = metadata.description || '';
  
  let author = '';
  if (metadata.author) {
    if (typeof metadata.author === 'string') {
      author = metadata.author;
    } else {
      author = metadata.author.email 
        ? `${metadata.author.name} <${metadata.author.email}>`
        : metadata.author.name;
    }
  }
  
  const license = metadata.license || '';

  const parts = [
    `${name} ${version}`,
    description && `${description}`,
    author && `Author: ${author}`,
    license && `License: ${license}`
  ].filter(Boolean);

  return `/*!\n * ${parts.join('\n * ')}\n */`;
};

/**
 * Read and parse package.json file
 * @param packagePath - Path to package.json
 * @returns Package metadata
 */
export const readPackageMetadata = (packagePath: string): PackageMetadata => {
  try {
    const content = readFileSync(packagePath, 'utf-8');
    return JSON.parse(content) as PackageMetadata;
  } catch (error) {
    console.warn(`Failed to read package.json from ${packagePath}:`, error);
    return {};
  }
};

export interface ScrewUpOptions {
  /**
   * Custom banner template
   * @default undefined (uses built-in template)
   */
  bannerTemplate?: string;
}

/**
 * Find workspace root by looking for workspace configuration files
 * @param startPath - Starting directory path
 * @returns Workspace root path or null if not found
 */
export const findWorkspaceRoot = (startPath: string): string | null => {
  let currentPath = startPath;
  
  while (currentPath !== dirname(currentPath)) {
    const packageJsonPath = join(currentPath, 'package.json');
    
    if (existsSync(packageJsonPath)) {
      const content = readFileSync(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(content);
      
      // Check for workspace configurations
      if (packageJson.workspaces || 
          existsSync(join(currentPath, 'pnpm-workspace.yaml')) ||
          existsSync(join(currentPath, 'lerna.json'))) {
        return currentPath;
      }
    }
    
    currentPath = dirname(currentPath);
  }
  
  return null;
};

/**
 * Get all workspace package.json paths
 * @param workspaceRoot - Workspace root directory
 * @returns Array of package.json paths
 */
export const getWorkspacePackages = (workspaceRoot: string): string[] => {
  const packageJsonPath = join(workspaceRoot, 'package.json');
  const packages: string[] = [packageJsonPath];
  
  if (!existsSync(packageJsonPath)) {
    return packages;
  }
  
  try {
    const content = readFileSync(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(content);
    
    if (packageJson.workspaces) {
      const workspacePatterns = Array.isArray(packageJson.workspaces) 
        ? packageJson.workspaces 
        : packageJson.workspaces.packages || [];
      
      for (const pattern of workspacePatterns) {
        const matches = globSync(join(workspaceRoot, pattern, 'package.json'));
        packages.push(...matches);
      }
    }
  } catch (error) {
    console.warn('Failed to parse workspace configuration:', error);
  }
  
  return [...new Set(packages)];
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
  return {
    ...parentMetadata,
    ...childMetadata,
    // Special handling for author field
    author: childMetadata.author || parentMetadata.author
  };
};

/**
 * Resolve package metadata for current project with workspace inheritance
 * @param projectRoot - Current project root
 * @returns Resolved package metadata
 */
export const resolvePackageMetadata = (projectRoot: string): PackageMetadata => {
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  
  if (!workspaceRoot) {
    // No workspace, just read local package.json
    const localPackagePath = join(projectRoot, 'package.json');
    return readPackageMetadata(localPackagePath);
  }
  
  // Get all workspace packages
  const packagePaths = getWorkspacePackages(workspaceRoot);
  const projectPackagePath = join(projectRoot, 'package.json');
  
  // Start with root package metadata
  const rootPackagePath = join(workspaceRoot, 'package.json');
  let metadata = readPackageMetadata(rootPackagePath);
  
  // If current project is not the root, merge with project-specific metadata
  if (projectPackagePath !== rootPackagePath && existsSync(projectPackagePath)) {
    const projectMetadata = readPackageMetadata(projectPackagePath);
    metadata = mergePackageMetadata(metadata, projectMetadata);
  }
  
  return metadata;
};

/**
 * Vite plugin that adds banner to the bundled code
 * @param options - Plugin options
 * @returns Vite plugin
 */
export const screwUp = (options: ScrewUpOptions = {}): Plugin => {
  const { bannerTemplate } = options;
  let banner: string;
  
  return {
    name: 'screw-up',
    apply: 'build',
    configResolved(config) {
      const metadata = resolvePackageMetadata(config.root);
      banner = bannerTemplate || generateBanner(metadata);
    },
    generateBundle(_options, bundle) {
      // Add banner to each output file
      for (const fileName in bundle) {
        const chunk = bundle[fileName];
        if (chunk.type === 'chunk') {
          chunk.code = banner + '\n' + chunk.code;
        }
      }
    }
  };
};
