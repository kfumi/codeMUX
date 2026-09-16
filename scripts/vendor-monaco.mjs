// Monaco 的 AMD 运行时 vendoring:node_modules/monaco-editor/min/vs → public/vs。
//
// 为什么走「拷进 public/ + 运行时 AMD 拉取」而不是 `import monaco-editor`:
// monaco 的 ESM 路径依赖 MonacoEnvironment.getWorker 与五个 `?worker` 导入,会和
// vite.config.ts 的 manualChunks、以及桌面壳(app://)与 daemon(dist-web)两套静态
// 服务互相牵扯,默认还会去 CDN 取运行时。`min/vs` 是纯静态资源,bundler 完全不
// 参与,三条加载链路(Vite dev / 壳 app:// / daemon dist-web)都由各自已有的静态
// 服务直接吐文件,没有新增机制。
//
// 版本戳的意义:public/vs 只在 node_modules 里的 monaco 版本变化时才真的重拷,
// 所以这个函数可以安全地挂在 Vite 的 buildStart 上(覆盖 dev 与全部构建入口),
// 每次启动的额外成本只是一次 stat。这同时消除了「public/vs 被误删」和「升级
// monaco 后忘记重装」两种会让发布包带着坏编辑器出去的路径 —— 下次起 Vite 就自愈。
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(scriptDir, '..');
const pkgPath = path.join(rootDir, 'node_modules', 'monaco-editor', 'package.json');
const sourceDir = path.join(rootDir, 'node_modules', 'monaco-editor', 'min', 'vs');
const targetDir = path.join(rootDir, 'public', 'vs');
const stampPath = path.join(targetDir, '.codemux-monaco-version');

/**
 * monaco 的 min 构建把 sourcemap 放在 `min-maps/` 兄弟目录下,而 npm 包里并不
 * 存在这个目录,所以 `//# sourceMappingURL=../../min-maps/vs/loader.js.map` 这类
 * 引用必然指空。两套静态服务都带 SPA 回退,指空不会得到 404 而是 200 + index.html,
 * devtools 会拿入口页当 sourcemap 解析。直接剥掉这些引用。
 */
const SOURCE_MAP_REF = /\n?\s*(?:\/\/#|\/\*#)\s*sourceMappingURL=[^\r\n]*\s*$/;

function stripSourceMapRefs(dir) {
  let stripped = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      stripped += stripSourceMapRefs(full);
      continue;
    }
    if (!entry.name.endsWith('.js') && !entry.name.endsWith('.css')) continue;
    const text = readFileSync(full, 'utf8');
    if (!SOURCE_MAP_REF.test(text)) continue;
    writeFileSync(full, text.replace(SOURCE_MAP_REF, '\n'));
    stripped += 1;
  }
  return stripped;
}

/**
 * 幂等:版本未变且 public/vs 已就位时直接返回,不做任何拷贝。
 * monaco-editor 缺失时抛错而不是静默跳过 —— 静默会让构建出一个加载不出编辑器
 * 的前端,正是最难排查的那类发布问题。
 */
export function vendorMonaco({ force = false, quiet = false } = {}) {
  if (!existsSync(pkgPath) || !existsSync(sourceDir)) {
    throw new Error(
      '[vendor-monaco] 找不到 node_modules/monaco-editor/min/vs。'
      + '请先运行 `npm install`(monaco-editor 是 devDependency,构建期需要它的 min/vs 作为静态资源来源)。',
    );
  }

  const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  const stamped = existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === version;
  if (!force && stamped) {
    return { changed: false, version, stripped: 0 };
  }

  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(path.dirname(targetDir), { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true });
  const stripped = stripSourceMapRefs(targetDir);
  writeFileSync(stampPath, `${version}\n`);

  if (!quiet) {
    console.log(
      `[vendor-monaco] monaco-editor@${version} → public/vs`
      + `(剥离 ${stripped} 处 sourceMappingURL 引用)`,
    );
  }
  return { changed: true, version, stripped };
}

const invokedDirectly = process.argv[1]?.endsWith('vendor-monaco.mjs') ?? false;
if (invokedDirectly) {
  const force = process.argv.includes('--force');
  const result = vendorMonaco({ force });
  if (!result.changed) {
    console.log(`[vendor-monaco] public/vs 已是最新(monaco-editor@${result.version})`);
  }
}

/** vendor 产物目录(即 dev 下 /vs 映射到的实际路径),供 Vite dev 中间件做 404 判定。 */
export { targetDir as publicVendorDir };
