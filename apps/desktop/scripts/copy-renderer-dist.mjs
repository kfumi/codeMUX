// 工单 06:打包前把仓库根渲染层 dist/ 拷入 apps/desktop/renderer-dist,
// 经 electron-builder `files: renderer-dist/**` 随安装包分发(main.ts 打包态
// 经 app:// 从 app.getAppPath()/renderer-dist 读取)。正式资源根布局由工单 09 收口。
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageDir, '..', '..');
const source = path.resolve(repoRoot, 'dist');
const target = path.join(packageDir, 'renderer-dist');

if (!existsSync(source)) {
  console.error(`[copy-renderer-dist] source not found: ${source} (先在仓库根运行 \`npm run build:renderer\`)`);
  process.exit(1);
}

// dist/ 比源码旧 = 大概率忘了编渲染层,安装包会带着旧前端(桌面窗口只加载
// renderer-dist/,dev 态走 Vite dev server 察觉不到)。宁可拦住也不要发布旧包;
// 确实要拷旧产物时用 CODEMUX_ALLOW_STALE_RENDERER=1 跳过。
const distIndex = path.join(source, 'index.html');
if (!process.env.CODEMUX_ALLOW_STALE_RENDERER && existsSync(distIndex)) {
  const newestSourceMtime = newestMtime([
    path.join(repoRoot, 'src'),
    path.join(repoRoot, 'index.html'),
    path.join(repoRoot, 'vite.config.ts'),
  ]);
  if (newestSourceMtime > statSync(distIndex).mtimeMs) {
    console.error(
      '[copy-renderer-dist] dist/ 比源码旧,安装包会带旧渲染层:先在仓库根运行 `npm run build:renderer`'
      + '(或确认无误后设 CODEMUX_ALLOW_STALE_RENDERER=1 跳过该检查)',
    );
    process.exit(1);
  }
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`[copy-renderer-dist] ${source} -> ${target}`);

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
