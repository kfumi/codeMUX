/**
 * Monaco 的 AMD 运行时是构建产物里的静态资源,不是 bundle 进来的:由
 * `scripts/vendor-monaco.mjs` 把 `node_modules/monaco-editor/min/vs` 拷进
 * `public/vs`,构建后落在渲染层根部的 `vs/**`,再由各处静态服务直接吐给浏览器。
 *
 * 这个模块只负责「哪些请求属于 vendor 资源」这一个判定,抽出来是为了让壳的
 * app:// 协议处理器可以单独测 —— main.ts 会拉起 Electron 主进程模块,不适合在
 * 单测里 import。daemon 侧的对应实现见 src-tauri/src/companion/server.rs。
 */

/** 构建产物里 vendor 资源的路径前缀。 */
export const VENDOR_ASSET_PREFIX = 'vs/';

/**
 * 判定一个已经剥掉前导斜杠的相对路径是否属于 vendor 资源。
 *
 * 只认路径边界(`vs` 本身或 `vs/` 开头),否则 `vsconfig.js` 这类同前缀的普通文件
 * 会被误判成 vendor 资源、在缺失时得到 404 而不是 SPA 回退。
 */
export function isVendorAssetPath(relativePath: string): boolean {
  return relativePath === 'vs' || relativePath.startsWith(VENDOR_ASSET_PREFIX);
}
