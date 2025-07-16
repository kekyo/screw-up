// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import type { Plugin } from 'vite';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { generateBanner, insertBannerHeader, resolvePackageMetadata, generateMetadataFile } from './internal.js';

/**
 * screw-up options
 */
export interface ScrewUpOptions {
  /**
   * Array of keys to output in banner in the specified order
   * @default ['name', 'version', 'description', 'author', 'license', 'repository.url']
   */
  outputKeys?: string[];
  /**
   * Array of asset file regex to add banner to
   * @default ['\.d\.ts$']
   */
  assetFilters?: string[];
  /**
   * Enable TypeScript metadata file generation
   * @default false
   */
  outputMetadataFile?: boolean;
  /**
   * Output path for TypeScript metadata file
   * @default 'src/generated/packageMetadata.ts'
   */
  outputMetadataFilePath?: string;
  /**
   * Array of keys to output in metadata file in the specified order
   * @default ['name', 'version', 'description', 'author', 'license', 'repository.url']
   */
  outputMetadataKeys?: string[];
}

/**
 * Vite plugin that adds banner to the bundled code
 * @param options - Plugin options
 * @returns Vite plugin
 */
const screwUp = (options: ScrewUpOptions = {}): Plugin => {
  const {
    outputKeys = ['name', 'version', 'description', 'author', 'license', 'repository.url'],
    assetFilters = ['\\.d\\.ts$'],
    outputMetadataFile = false,
    outputMetadataFilePath = 'src/generated/packageMetadata.ts',
    outputMetadataKeys = ['name', 'version', 'description', 'author', 'license', 'repository.url']} = options;

  const assetFiltersRegex = assetFilters.map(filter => new RegExp(filter));
  let banner: string;
  let metadata: any;
  let projectRoot: string;

  return {
    name: 'screw-up',
    apply: 'build',
    async configResolved(config) {
      projectRoot = config.root;
      metadata = await resolvePackageMetadata(config.root);
      banner = generateBanner(metadata, outputKeys);
    },
    async buildStart() {
      // Generate metadata TypeScript file
      if (outputMetadataFile) {
        const metadataContent = generateMetadataFile(metadata, outputMetadataKeys);
        const metadataPath = join(projectRoot, outputMetadataFilePath);
        
        try {
          // Ensure directory exists
          await mkdir(dirname(metadataPath), { recursive: true });
          // Write metadata file
          await writeFile(metadataPath, metadataContent);
        } catch (error) {
          console.warn(`Failed to write metadata file to ${metadataPath}:`, error);
        }
      }
    },
    generateBundle(_options, bundle) {
      // Add banner to each output file
      for (const fileName in bundle) {
        const chunk = bundle[fileName];
        if (chunk.type === 'chunk') {
          chunk.code = insertBannerHeader(chunk.code, banner);
        } else if (chunk.type === 'asset' && assetFiltersRegex.some(filter => filter.test(fileName))) {
          if (typeof chunk.source === 'string') {
            chunk.source = insertBannerHeader(chunk.source, banner + '\n');  // insert more blank line
          }
        }
      }
    },
    async writeBundle(options) {
      // Handle files written by other plugins (like vite-plugin-dts)
      if (!options.dir) return;

      try {
        // Read all files in the output directory
        const files = await readdir(options.dir, { recursive: true });

        // Iterate over all files
        for (const file of files) {
          const filePath = join(options.dir, file);

          // Check if the file is target asset file
          if (assetFiltersRegex.some(filter => filter.test(file))) {
            try {
              // Read the asset file
              const content = await readFile(filePath, 'utf-8');
              // Append banner to the asset file if it doesn't already contain it
              if (!content.includes(banner)) {
                await writeFile(filePath, insertBannerHeader(content, banner + '\n'));
              }
            } catch (error) {
              // Skip files that can't be read/written
            }
          }
        }
      } catch (error) {
        // Skip files that can't be read/written
      }
    }
  };
};

export default screwUp;
