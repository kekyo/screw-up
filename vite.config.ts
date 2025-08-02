import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import dts from 'vite-plugin-dts';
import { screwUp } from './src/vite-plugin';   // Self-hosted

export default defineConfig({
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
        main: resolve(fileURLToPath(new URL('.', import.meta.url)), 'src/main.ts')
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
