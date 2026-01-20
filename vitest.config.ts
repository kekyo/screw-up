// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}'],
    exclude: ['node_modules', 'dist', '.idea', '.git', '.cache'],
  },
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      'node:buffer': 'buffer',
      'node:events': 'events',
      'node:fs': 'fs',
      'node:path': 'path',
      'node:os': 'os',
    },
  },
});
