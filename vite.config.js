import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { APP_NAME } from './shared/brand.js';

export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [react(), { name: 'brand', transformIndexHtml: (html) => html.replaceAll('%APP_NAME%', APP_NAME) }],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2023',
    chunkSizeWarningLimit: 900,
  },
});
