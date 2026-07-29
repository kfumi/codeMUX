import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return;
          }

          // @assistant-ui 与 streamdown 系列存在双向引用，必须放在同一 chunk，
          // 否则会产生 chunk 级别的循环依赖。
          if (
            id.includes("@assistant-ui") ||
            id.includes("streamdown") ||
            id.includes("@streamdown")
          ) {
            return "assistant-ui";
          }

          if (id.includes("@uiw") || id.includes("codemirror")) {
            return "editor";
          }

          if (id.includes("@tauri-apps")) {
            return "tauri";
          }

          if (id.includes("lucide-react") || id.includes("@lobehub")) {
            return "icons";
          }
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
