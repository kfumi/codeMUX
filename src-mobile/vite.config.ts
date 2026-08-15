import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@mobile': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../src'),
    },
  },
  server: {
    port: 1422,
    host: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
