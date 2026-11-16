import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  build: { outDir: fileURLToPath(new URL('../dist', import.meta.url)), emptyOutDir: true, sourcemap: false },
  plugins: [react()],
  server: {
    host: '127.0.0.1', port: 5174, strictPort: true,
    proxy: Object.fromEntries(['/api', '/login'].map(path => [path, {
      target: process.env.TYHR_API_TARGET || 'http://127.0.0.1:8787', changeOrigin: false,
    }])),
  },
});
