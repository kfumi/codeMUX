// 工单 06:打包前把仓库根渲染层 dist/ 拷入 desktop-electron/renderer-dist,
// 经 electron-builder `files: renderer-dist/**` 随安装包分发(main.ts 打包态
// 经 app:// 从 app.getAppPath()/renderer-dist 读取)。正式资源根布局由工单 09 收口。
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(packageDir, '..', 'dist');
const target = path.join(packageDir, 'renderer-dist');

if (!existsSync(source)) {
  console.error(`[copy-renderer-dist] source not found: ${source} (先在仓库根运行 \`npm run build\`)`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`[copy-renderer-dist] ${source} -> ${target}`);
