// 打包前把 agent sidecar 的编译产物拷入 apps/desktop/sidecar-dist,
// 经 electron-builder `extraResources`(from: sidecar-dist → to: sidecar)落到资源根,
// 对齐 daemon 的期望路径 <resource_dir>/sidecar/dist/index.js
// (crates/daemon/src/agent/mod.rs 的 SIDECAR_RELATIVE_DIR/SIDECAR_ENTRYPOINT)。
//
// 为什么还要写 package.json:sidecar 是 ESM("type": "module"),打包态 dist/ 的
// 最近父级若无 package.json,Node 会把 index.js 当 CJS 解析并抛
// "Cannot use import statement outside a module"。
//
// node_modules 不随包分发:sidecar 只在类型层引用 provider SDK(import type),
// 运行时由托管 Runtime 目录(%LOCALAPPDATA%/CodeMUX/runtimes)动态加载。
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageDir, '..', '..');
const sidecarDir = path.join(repoRoot, 'apps', 'sidecar');
const source = path.join(sidecarDir, 'dist');
const sourceEntry = path.join(source, 'index.js');
const target = path.join(packageDir, 'sidecar-dist');

if (!existsSync(sourceEntry)) {
  console.error(`[copy-sidecar-dist] source not found: ${sourceEntry} (先运行 \`npm run build:sidecar\`)`);
  process.exit(1);
}

// dist/ 比源码旧 = 忘了编 sidecar,安装包会带着旧 sidecar 发出去(dev 态直接跑
// apps/sidecar/dist,同样察觉不到)。确实要拷旧产物时用
// CODEMUX_ALLOW_STALE_SIDECAR=1 跳过。
if (!process.env.CODEMUX_ALLOW_STALE_SIDECAR) {
  const newestSourceMtime = newestMtime([path.join(sidecarDir, 'src'), path.join(sidecarDir, 'tsconfig.json')]);
  if (newestSourceMtime > statSync(sourceEntry).mtimeMs) {
    console.error(
      '[copy-sidecar-dist] sidecar dist/ 比源码旧,安装包会带旧 sidecar:先运行 `npm run build:sidecar`'
      + '(或确认无误后设 CODEMUX_ALLOW_STALE_SIDECAR=1 跳过该检查)',
    );
    process.exit(1);
  }
}

rmSync(target, { recursive: true, force: true });
cpSync(source, path.join(target, 'dist'), { recursive: true });

// 只保留 ESM 标记所需字段:devDependencies/scripts 是源码侧的事,拷进资源根
// 只会误导(让人以为打包态带着 node_modules)。
const sidecarManifest = JSON.parse(readFileSync(path.join(sidecarDir, 'package.json'), 'utf8'));
writeFileSync(
  path.join(target, 'package.json'),
  `${JSON.stringify(
    {
      name: sidecarManifest.name,
      private: true,
      version: sidecarManifest.version,
      type: sidecarManifest.type,
    },
    null,
    2,
  )}\n`,
);

console.log(`[copy-sidecar-dist] ${source} -> ${path.join(target, 'dist')}`);

function newestMtime(entries) {
  let newest = 0;
  const visit = (entryPath) => {
    const stats = statSync(entryPath);
    if (stats.isDirectory()) {
      for (const name of readdirSync(entryPath)) {
        visit(path.join(entryPath, name));
      }
      return;
    }
    if (stats.mtimeMs > newest) {
      newest = stats.mtimeMs;
    }
  };
  for (const entry of entries) {
    if (existsSync(entry)) {
      visit(entry);
    }
  }
  return newest;
}
