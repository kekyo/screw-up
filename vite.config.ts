// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import dts from 'vite-plugin-dts';
import prettierMax from 'prettier-max';
import { screwUp } from './src/vite-plugin'; // Self-hosted

export default defineConfig({
  logLevel: 'info',
  plugins: [
    dts({
      rollupTypes: true,
    }),
    prettierMax(),
    screwUp({
      outputMetadataFile: true,
    }),
  ],
  build: {
    lib: {
      entry: {
        index: resolve(
          fileURLToPath(new URL('.', import.meta.url)),
          'src/index.ts'
        ),
        main: resolve(
          fileURLToPath(new URL('.', import.meta.url)),
          'src/main.ts'
        ),
      },
      name: 'screw-up',
      fileName: (format, entryName) =>
        `${entryName}.${format === 'es' ? 'mjs' : 'cjs'}`,
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [
        'fs',
        'os',
        'path',
        'fs/promises',
        'vite',
        'crypto',
        'tar',
        'zlib',
        'events',
        'stream',
        'stream/promises',
        'isomorphic-git',
        'tar-stream',
        'glob',
        'string_decoder',
        'child_process',
        'simple-git',
      ],
    },
    target: 'es2018',
    minify: false,
    sourcemap: true,
  },
});
