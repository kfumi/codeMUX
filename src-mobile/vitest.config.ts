import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@mobile': path.resolve(__dirname, './src'),
      '@shared/lib/agentPermissions': path.resolve(__dirname, '../src/lib/agentPermissions.ts'),
      '@shared/lib/companion-connection': path.resolve(__dirname, '../src/lib/companion-connection/index.ts'),
      '@shared/types/session': path.resolve(__dirname, '../src/types/session.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
