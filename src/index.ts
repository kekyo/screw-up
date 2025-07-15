// Screw-UP - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import type { Plugin } from 'vite';
import { readFile, access } from 'fs/promises';
import { dirname, join } from 'path';

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
 * Check if file exists
 * @param filePath - Path to check
 * @returns Promise resolving to true if file exists
 */
export const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
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
    return JSON.parse(content) as PackageMetadata;
  } catch (error) {
    console.warn(`Failed to read package.json from ${packagePath}:`, error);
    return {};
  }
};

/**
 * Find workspace root by looking for workspace configuration files
 * @param startPath - Starting directory path
 * @returns Promise resolving to workspace root path or null if not found
 */
export const findWorkspaceRoot = async (startPath: string): Promise<string | null> => {
  let currentPath = startPath;
  
  while (currentPath !== dirname(currentPath)) {
    const packageJsonPath = join(currentPath, 'package.json');
    
    if (await fileExists(packageJsonPath)) {
      try {
        const content = await readFile(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(content);
        
        // Check for workspace configurations
        if (packageJson.workspaces || 
            await fileExists(join(currentPath, 'pnpm-workspace.yaml')) ||
            await fileExists(join(currentPath, 'lerna.json'))) {
          return currentPath;
        }
      } catch (error) {
        console.warn(`Failed to parse package.json at ${packageJsonPath}:`, error);
      }
    }
    
    currentPath = dirname(currentPath);
  }
  
  return null;
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
  if (projectPackagePath !== rootPackagePath && await fileExists(projectPackagePath)) {
    const projectMetadata = await readPackageMetadata(projectPackagePath);
    metadata = mergePackageMetadata(metadata, projectMetadata);
  }
  
  return metadata;
};

export interface ScrewUpOptions {
  /**
   * Custom banner template
   * @default undefined (uses built-in template)
   */
  bannerTemplate?: string;
}

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
    async configResolved(config) {
      const metadata = await resolvePackageMetadata(config.root);
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
