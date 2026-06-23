import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return;
          }

          if (
            id.includes("@assistant-ui/react-markdown") ||
            id.includes("@assistant-ui/react-streamdown") ||
            id.includes("streamdown")
          ) {
            return "assistant-ui-markdown";
          }

          if (id.includes("@assistant-ui")) {
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
