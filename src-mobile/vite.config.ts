import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../src'),
      '@mobile': path.resolve(__dirname, './src'),
      '@shared/lib/agentPermissions': path.resolve(__dirname, '../src/lib/agentPermissions.ts'),
      '@shared/lib/companion-connection': path.resolve(__dirname, '../src/lib/companion-connection/index.ts'),
      '@shared/types/session': path.resolve(__dirname, '../src/types/session.ts'),
    },
  },
  server: {
    port: 1422,
    host: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return;
          }
          if (id.includes('streamdown') || id.includes('@streamdown')) {
            return 'streamdown';
          }
        },
      },
    },
  },
});
