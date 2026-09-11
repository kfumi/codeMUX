import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'scripts/**/*.test.mjs',
      // Electron 壳 supervisor 契约测试(工单 05;desktop-electron 不装独立 vitest)
      'desktop-electron/test/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/src-tauri/**'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
