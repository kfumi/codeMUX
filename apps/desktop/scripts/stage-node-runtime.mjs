// 打包前把一份独立的 Node.js 运行时暂存到 apps/desktop/node-runtime/,经
// electron-builder 的 extraResources(from: node-runtime → to: node)落到资源根
// <resource_dir>/node/。
//
// 为什么需要这一步:daemon 的 sidecar 启动、托管 Runtime 的 npm 安装与设置页
// 检测都优先用随包运行时,从而不依赖用户机器 PATH 里的 Node.js —— 客户机只有旧版
// (如 Node 14)甚至没有 Node 时也能运行(见 crates/daemon/src/toolchain.rs)。
//
// 布局与官方发行包解压后一致,不额外重排:
//   Windows: node-runtime/node.exe, node-runtime/npm.cmd, node-runtime/node_modules/npm/...
//   unix   : node-runtime/bin/node, node-runtime/bin/npm, node-runtime/lib/node_modules/npm/...
//
// 版本用 CODEMUX_NODE_VERSION 覆盖(默认见下),镜像用 CODEMUX_NODE_MIRROR 覆盖
// (默认 https://nodejs.org/dist,国内可设 https://npmmirror.com/mirrors/node)。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, renameSync, cpSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 默认 22.20.0:满足 pi 运行时的 engines(node >= 22.19.0),同时满足 sidecar 的 18+。
const NODE_VERSION = process.env.CODEMUX_NODE_VERSION ?? '22.20.0';
const MIRROR = (process.env.CODEMUX_NODE_MIRROR ?? 'https://nodejs.org/dist').replace(/\/+$/, '');

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = path.join(packageDir, 'node-runtime');

const platformSegment = { win32: 'win', darwin: 'darwin', linux: 'linux' }[process.platform];
const archSegment = { x64: 'x64', arm64: 'arm64' }[process.arch];
if (!platformSegment || !archSegment) {
  console.error(
    `[stage-node-runtime] 不支持的平台/架构: ${process.platform}/${process.arch}`,
  );
  process.exit(1);
}

const extension = process.platform === 'win32' ? 'zip' : 'tar.gz';
const folderName = `node-v${NODE_VERSION}-${platformSegment}-${archSegment}`;
const url = `${MIRROR}/v${NODE_VERSION}/${folderName}.${extension}`;

// 二进制路径与 daemon 侧 crate::toolchain 的布局约定一致。
const binaryRelative =
  process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node');
const marker = path.join(targetDir, binaryRelative);

if (existsSync(marker)) {
  console.log(`[stage-node-runtime] 已暂存 ${NODE_VERSION},跳过 (${marker})`);
  process.exit(0);
}

const cacheDir = path.join(os.tmpdir(), 'codemux-node-runtime');
const archivePath = path.join(cacheDir, `${folderName}.${extension}`);

async function download(url, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  console.log(`[stage-node-runtime] 下载 ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载失败: HTTP ${response.status} ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(destination, buffer);
}

function extractArchive(archive, destination) {
  mkdirSync(destination, { recursive: true });
  try {
    // Windows 10+ 的 bsdtar、macOS 的 bsdtar、Linux 的 GNU tar 都能解开 zip / tar.gz。
    execFileSync('tar', ['-xf', archive, '-C', destination], { stdio: 'inherit' });
  } catch (error) {
    if (process.platform === 'win32') {
      execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath "${archive}" -DestinationPath "${destination}" -Force`,
        ],
        { stdio: 'inherit' },
      );
      return;
    }
    throw error;
  }
}

function moveInto(sourceDir, destinationDir) {
  for (const entry of readdirSync(sourceDir)) {
    const from = path.join(sourceDir, entry);
    const to = path.join(destinationDir, entry);
    try {
      renameSync(from, to);
    } catch {
      // 跨盘符(临时目录在别的卷)时 rename 会 EXDEV,退回复制。
      cpSync(from, to, { recursive: true });
    }
  }
}

await download(url, archivePath);

const extractRoot = path.join(cacheDir, `${folderName}.extract`);
rmSync(extractRoot, { recursive: true, force: true });
extractArchive(archivePath, extractRoot);

const extracted = path.join(extractRoot, folderName);
if (!existsSync(path.join(extracted, binaryRelative))) {
  console.error(`[stage-node-runtime] 解压后未找到 node 二进制: ${path.join(extracted, binaryRelative)}`);
  process.exit(1);
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
moveInto(extracted, targetDir);

// 剪掉与运行无关的文档/头文件,减小安装包(保留 LICENSE)。
const prunable = [
  'CHANGELOG.md',
  'README.md',
  'include',
  path.join('share', 'doc'),
  path.join('share', 'man'),
  path.join('share', 'systemtap'),
];
for (const relative of prunable) {
  rmSync(path.join(targetDir, relative), { recursive: true, force: true });
}

console.log(`[stage-node-runtime] Node ${NODE_VERSION} -> ${targetDir}`);
