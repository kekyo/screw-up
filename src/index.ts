// Screw-UP - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import type { Plugin } from 'vite';
import { readFileSync } from 'fs';
import { resolve } from 'path';

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
   * Path to package.json file
   * @default "./package.json"
   */
  packagePath?: string;
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
  const { packagePath = './package.json', bannerTemplate } = options;
  let banner: string;
  
  return {
    name: 'screw-up',
    apply: 'build',
    configResolved(config) {
      const resolvedPackagePath = resolve(config.root, packagePath);
      const metadata = readPackageMetadata(resolvedPackagePath);
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
