// Screw-UP - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import type { Plugin } from 'vite';
import { generateBanner, resolvePackageMetadata } from './internal.js';

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