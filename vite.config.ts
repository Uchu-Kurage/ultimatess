import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// renderer(React UI)専用の Vite 設定。base を相対にして Electron の file:// から読めるようにする。
export default defineConfig({
  root: resolve(__dirname, 'app/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
