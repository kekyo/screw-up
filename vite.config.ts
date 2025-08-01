import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import dts from 'vite-plugin-dts';
import { screwUp } from './src/vite-plugin';   // Self-hosted

const packageJson = JSON.parse(
  readFileSync(resolve(fileURLToPath(new URL('.', import.meta.url)), 'package.json'), 'utf8'));

export default defineConfig({
  define: {
    __VERSION__: JSON.stringify(packageJson.version),
    __AUTHOR__: JSON.stringify(packageJson.author),
    __REPOSITORY_URL__: JSON.stringify(packageJson.repository.url),
    __LICENSE__: JSON.stringify(packageJson.license),
  },
  plugins: [
    dts({
      insertTypesEntry: true
    }),
    screwUp({
      outputMetadataFile: true
    })
  ],
  build: {
    lib: {
      entry: {
        index: resolve(fileURLToPath(new URL('.', import.meta.url)), 'src/index.ts'),
        cli: resolve(fileURLToPath(new URL('.', import.meta.url)), 'src/cli.ts')
      },
      name: 'ScrewUp',
      fileName: (format, entryName) => `${entryName}.${format === 'es' ? 'js' : 'cjs'}`,
      formats: ['es', 'cjs']
    },
    rollupOptions: {
      external: ['fs', 'os', 'path', 'fs/promises', 'vite', 'tar', 'zlib', 'events', 'stream', 'stream/promises', 'tar-stream', 'glob', 'string_decoder', 'child_process', 'isomorphic-git', 'simple-git']
    },
    target: 'es2018',
    minify: false,
    sourcemap: true
  }
});
