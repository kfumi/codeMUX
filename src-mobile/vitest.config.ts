import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@lobehub\/icons-static-svg\/icons\/.*\.svg\?raw$/,
        replacement: path.resolve(__dirname, './src/test/iconStub.ts'),
      },
      { find: '@', replacement: path.resolve(__dirname, '../src') },
      { find: '@mobile', replacement: path.resolve(__dirname, './src') },
      { find: '@shared/lib/agentPermissions', replacement: path.resolve(__dirname, '../src/lib/agentPermissions.ts') },
      { find: '@shared/lib/companion-connection', replacement: path.resolve(__dirname, '../src/lib/companion-connection/index.ts') },
      { find: '@shared/types/session', replacement: path.resolve(__dirname, '../src/types/session.ts') },
    ],
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
