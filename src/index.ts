// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import type { Plugin } from 'vite';
import { readFile, writeFile, readdir } from 'fs/promises';
import { join } from 'path';
import { generateBanner, resolvePackageMetadata } from './internal.js';

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
}

/**
 * Vite plugin that adds banner to the bundled code
 * @param options - Plugin options
 * @returns Vite plugin
 */
const screwUp = (options: ScrewUpOptions = {}): Plugin => {
  const {
    outputKeys = ['name', 'version', 'description', 'author', 'license', 'repository.url'],
    assetFilters = ['\\.d\\.ts$'] } = options;

  const assetFiltersRegex = assetFilters.map(filter => new RegExp(filter));
  let banner: string;

  return {
    name: 'screw-up',
    apply: 'build',
    async configResolved(config) {
      const metadata = await resolvePackageMetadata(config.root);
      banner = generateBanner(metadata, outputKeys);
    },
    generateBundle(_options, bundle) {
      // Add banner to each output file
      for (const fileName in bundle) {
        const chunk = bundle[fileName];
        if (chunk.type === 'chunk') {
          chunk.code = banner + '\n' + chunk.code;
        } else if (chunk.type === 'asset' && assetFiltersRegex.some(filter => filter.test(fileName))) {
          if (typeof chunk.source === 'string') {
            chunk.source = banner + '\n\n' + chunk.source;  // insert more blank line
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
                await writeFile(filePath, banner + '\n\n' + content);
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
