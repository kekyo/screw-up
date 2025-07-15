// Screw-UP - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import type { Plugin } from 'vite';
import { generateBanner, resolvePackageMetadata } from './internal.js';

export interface ScrewUpOptions {
  /**
   * Array of keys to output in banner in the specified order
   * @default ['name', 'version', 'description', 'author', 'license', 'repository.url']
   */
  outputKeys?: string[];
}

/**
 * Vite plugin that adds banner to the bundled code
 * @param options - Plugin options
 * @returns Vite plugin
 */
export const screwUp = (options: ScrewUpOptions = {}): Plugin => {
  const { outputKeys = ['name', 'version', 'description', 'author', 'license', 'repository.url'] } = options;
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
        }
      }
    }
  };
};