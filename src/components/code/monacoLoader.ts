import { loader } from '@monaco-editor/react';

/**
 * Monaco 的运行时来源:构建产物根部的 /vs。
 *
 * `@monaco-editor/react` 默认从 jsdelivr 拉取 Monaco,而 CodeMUX 是 local-first:
 * daemon 要把前端伺服给手机/配对设备(可能经 relay),运行时依赖外网不可接受。
 * `/vs` 由 `scripts/vendor-monaco.mjs` 从 `node_modules/monaco-editor/min/vs` 拷进
 * `public/`,三条加载链路都由已有静态服务直接吐文件:
 *
 * - dev:Vite 把 public/ 挂在根路径
 * - 桌面壳生产:app:// 协议处理器(apps/desktop/src/main.ts)
 * - 浏览器/移动形态:daemon 的 dist-web 静态服务(crates/daemon/src/companion/server.rs)
 *
 * 用根相对路径(而不是完整 URL),三种 origin 下都能解析到各自服务的 /vs。
 */
export const MONACO_VENDOR_BASE_PATH = '/vs';

let configured = false;

/**
 * 幂等。必须在任何 Monaco 实例创建之前调用(AMD loader 一旦开始加载就无法改路径),
 * 所以由 lazy 加载的 Monaco 组件在模块顶层直接调用。
 */
export function configureMonacoLoader(): void {
  if (configured) {
    return;
  }
  configured = true;
  loader.config({ paths: { vs: MONACO_VENDOR_BASE_PATH } });
}
