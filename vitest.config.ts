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
      // Electron 壳 supervisor 契约测试(工单 05;apps/desktop 不装独立 vitest)
      'apps/desktop/test/**/*.test.ts',
    ],
    // 注意:**/apps/** 会把上面 include 的 apps/desktop/test 也一起排除掉,壳的
    // 契约测试从来没真正跑过;这里只排 sidecar(它自带独立 vitest)。
    exclude: ['**/node_modules/**', '**/dist/**', '**/crates/**', 'apps/sidecar/**'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
