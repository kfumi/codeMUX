import path from "path";
import { existsSync, statSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { publicVendorDir, vendorMonaco } from "./scripts/vendor-monaco.mjs";

/**
 * `/vs/**` 是 Monaco 的 AMD 运行时(见 scripts/vendor-monaco.mjs)。
 *
 * 三处静态服务都把这个前缀排除在 SPA 回退之外:缺失的 vendor 资源返回真实 404,
 * 而不是被回退成 200 + index.html —— 后者会让 AMD loader 拿入口页当脚本执行,
 * 报出的语法错误与「少了一个文件」这个真因完全脱节。
   * 另外两处:apps/desktop/src/main.ts 与 crates/daemon/src/companion/server.rs。
 */
function isVendorAssetPath(pathname: string): boolean {
  return pathname === "/vs" || pathname.startsWith("/vs/");
}

/**
 * Monaco 的 AMD 运行时不是 bundle 进来的,而是构建产物里的静态资源
 * (`public/vs` → `dist/vs` / `dist-web/vs`,由各自的静态服务吐给浏览器),
 * 所以必须在 Vite 真正读 publicDir 之前把它准备好。
 *
 * 挂在 buildStart 而不是 npm postinstall:dev、`build`、`build:renderer`、
 * `build:web` 四个入口全部经过 Vite,一处覆盖全部;脚本自带版本戳,幂等,
 * public/vs 被误删或 monaco 升级后忘了重装都能自愈。
 */
function monacoVendor(): Plugin {
  return {
    name: "codemux:vendor-monaco",
    buildStart() {
      vendorMonaco();
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        if (!isVendorAssetPath(pathname)) {
          next();
          return;
        }
        const target = path.join(publicVendorDir, pathname.replace(/^\/vs\/?/, ""));
        if (existsSync(target) && statSync(target).isFile()) {
          next();
          return;
        }
        res.statusCode = 404;
        res.end(`vendor asset not found: ${pathname}`);
      });
    },
  };
}

export default defineConfig(async () => ({
  plugins: [react(), monacoVendor()],
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
    watch: {
      ignored: ["**/crates/**", "**/apps/**", "**/.worktrees/**"],
    },
  },
}));
