// 打包前把 daemon 二进制暂存到 apps/desktop/daemon-bin/,经 electron-builder
// 的 extraResources(from: daemon-bin → to: daemon)落到资源根 <resource_dir>/daemon/。
//
// 为什么需要这一步:electron-builder.yml 里没法按目标平台写条件分支,而 daemon
// 的产物文件名随平台变化(Windows 带 .exe,unix 不带)。直接从
// crates/daemon/target/release/codemux-daemon[.exe] 取,在另一个平台上就是
// "文件不存在"。所以先按当前 runner 的平台把二进制放进一个内容确定的目录,
// 配置里只写目录名,一份配置就通吃 win/mac/linux。
//
// 落地后的文件名与 apps/desktop/src/main.ts 的 resolveDaemonExe() 一致
// (win32 → codemux-daemon.exe,其余 → codemux-daemon),不用改壳的代码。
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageDir, '..', '..');

const binaryName = process.platform === 'win32' ? 'codemux-daemon.exe' : 'codemux-daemon';
const source = path.join(repoRoot, 'crates', 'daemon', 'target', 'release', binaryName);
const targetDir = path.join(packageDir, 'daemon-bin');
const target = path.join(targetDir, binaryName);

if (!existsSync(source)) {
  console.error(
    `[stage-daemon-bin] source not found: ${source} (先在仓库根运行 \`npm run build:daemon:release\`)`,
  );
  process.exit(1);
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);

console.log(`[stage-daemon-bin] ${source} -> ${target}`);
