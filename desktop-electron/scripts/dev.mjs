// 开发态启动器:以 dev server 渲染层启动 Electron 壳。
// 前置:根目录 `npm run dev`(vite,1420 端口)、`npm run build:daemon`,
//       以及本包 `npm install`(提供 electron 二进制)。
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows 控制台默认 GBK,切到 UTF-8 避免壳进程中文日志乱码(仅显示层,失败忽略)。
if (process.platform === 'win32') {
  spawnSync('chcp.com', ['65001'], { stdio: 'ignore', shell: true });
}

const require = createRequire(import.meta.url);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const shellRoot = path.join(moduleDir, '..');

// 壳 TS → dist-electron 需先编译:启动器不会热编译,直接跑旧 main.js 会静默
// 运行改动前的行为(daemon/sidecar 同类陷阱)。dev/typecheck 共用 tsconfig。
const tscPath = require.resolve('typescript/bin/tsc');
const build = spawnSync(process.execPath, [tscPath, '-p', path.join(shellRoot, 'tsconfig.json')], {
  stdio: 'inherit',
  cwd: shellRoot,
});
if (build.status !== 0) {
  process.exitCode = build.status ?? 1;
  process.exit(process.exitCode);
}

// electron 包的主入口就是其二进制路径(跨平台)。
const electronBinary = require('electron');

// 按应用目录(而非 main.js 文件路径)启动:传文件路径会把 app path 解析到
// dist-electron/,那里没有 package.json,app.getVersion() 会回退成 Electron
// 自身版本(如 33.4.11)而非应用版本。目录启动按 package.json main 字段加载。
const child = spawn(electronBinary, [shellRoot], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CODEMUX_DEV_SERVER_URL: process.env.CODEMUX_DEV_SERVER_URL || 'http://localhost:1420',
  },
});

child.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
