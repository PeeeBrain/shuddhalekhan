import { defineConfig } from 'vite';
import { builtinModules } from 'module';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: resolve('out/agent'),
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: resolve('src/agent/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: ['better-sqlite3', ...builtinModules, ...builtinModules.map((moduleName) => `node:${moduleName}`)],
    },
  },
});
