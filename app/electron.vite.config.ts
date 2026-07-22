import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

export default defineConfig({
  main: {
    build: {
      lib: {
        entry: resolve('src/main/index.ts'),
        formats: ['cjs'],
        fileName: () => 'index.cjs',
      },
      sourcemap: true,
    },
  },
  preload: {
    build: {
      lib: {
        entry: resolve('src/preload/index.ts'),
        formats: ['cjs'],
        fileName: () => 'index.cjs',
      },
      sourcemap: true,
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@': resolve('src/renderer'),
      },
    },
    plugins: [react(), tailwindcss()],
    build: {
      outDir: resolve('out/renderer'),
      sourcemap: true,
    },
  },
});
