// 开发态启动器:以 dev server 渲染层启动 Electron 壳。
// 前置:根目录 `npm run dev`(vite,1420 端口)、`npm run build:daemon`,
//       以及本包 `npm install`(提供 electron 二进制)。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// electron 包的主入口就是其二进制路径(跨平台)。
const electronBinary = require('electron');

const mainPath = path.join(moduleDir, '..', 'dist-electron', 'main.js');
const child = spawn(electronBinary, [mainPath], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CODEMUX_DEV_SERVER_URL: process.env.CODEMUX_DEV_SERVER_URL || 'http://localhost:1420',
  },
});

child.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
