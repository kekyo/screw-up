// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import dts from 'unplugin-dts/vite';
import prettierMax from 'prettier-max';
import { screwUp } from './src/vite-plugin'; // Self-hosted

type BuildTarget = 'es' | 'cjs-index' | 'cjs-main';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const entries = {
  index: resolve(projectRoot, 'src/index.ts'),
  main: resolve(projectRoot, 'src/main.ts'),
};

const external = [
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
  'typescript',
];

const resolveBuildTarget = (): BuildTarget => {
  const buildTarget = process.env.SCREW_UP_BUILD_TARGET;
  if (
    buildTarget === 'es' ||
    buildTarget === 'cjs-index' ||
    buildTarget === 'cjs-main'
  ) {
    return buildTarget;
  }
  return 'es';
};

export default defineConfig(() => {
  const buildTarget = resolveBuildTarget();

  const plugins = [];
  if (buildTarget === 'es') {
    plugins.push(
      dts({
        entryRoot: 'src',
      }),
      prettierMax()
    );
  }
  plugins.push(
    screwUp({
      outputMetadataFile: buildTarget === 'es',
    })
  );

  // Rolldown currently panics on multi-entry CJS library builds, so split CJS
  // output into separate single-entry builds while keeping the ES build batched.
  const lib =
    buildTarget === 'cjs-index'
      ? {
          entry: {
            index: entries.index,
          },
          name: 'screw-up',
          fileName: (format: string, entryName: string) =>
            `${entryName}.${format === 'es' ? 'mjs' : 'cjs'}`,
          formats: ['cjs'],
        }
      : buildTarget === 'cjs-main'
        ? {
            entry: {
              main: entries.main,
            },
            name: 'screw-up',
            fileName: (format: string, entryName: string) =>
              `${entryName}.${format === 'es' ? 'mjs' : 'cjs'}`,
            formats: ['cjs'],
          }
        : {
            entry: entries,
            name: 'screw-up',
            fileName: (format: string, entryName: string) =>
              `${entryName}.${format === 'es' ? 'mjs' : 'cjs'}`,
            formats: ['es'],
          };

  return {
    logLevel: 'info',
    plugins,
    build: {
      emptyOutDir: buildTarget === 'es',
      lib,
      rolldownOptions: {
        external,
      },
      target: 'es2018',
      minify: false,
      sourcemap: true,
    },
  };
});
