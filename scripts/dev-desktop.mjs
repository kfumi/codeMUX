// 一键开发启动:等价于顺序执行 `npm run dev` + `npm run dev:electron`。
// Electron 壳加载渲染层没有重试逻辑(main.ts 直接 loadURL),所以必须等
// Vite 在 1420 就绪后再拉壳;daemon 由壳内 supervisor 自行拉起,无需照管。
// 退出(壳关闭 / Ctrl+C / 任一子进程意外退出)时统一清理全部子进程。
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(moduleDir, '..');
const DEV_SERVER_URL = 'http://localhost:1420';
const VITE_READY_TIMEOUT_MS = 60_000;

const children = [];
let shuttingDown = false;

const isWin = process.platform === 'win32';

// Windows 控制台默认代码页是 GBK,子进程的 UTF-8 中文日志(如
// [browser-automation])会显示成乱码;切到 UTF-8 仅影响本控制台的显示。
// 失败(非 cmd 环境/权限)静默忽略 —— 纯显示层,不值得阻塞启动。
if (isWin) {
  spawnSync('chcp.com', ['65001'], { stdio: 'ignore', shell: true });
}

async function isServerUp(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return true;
  } catch {
    return false;
  }
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerUp(url)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

function killAll() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) {
      continue;
    }
    if (isWin) {
      // Windows 上杀 npm/node 包装进程不会级联,用 taskkill /T 杀整棵进程树。
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  }
}

// Vite 渲染层:1420 已有服务则复用(strictPort,端口不会漂移),否则拉起
let vite = null;
if (await isServerUp(DEV_SERVER_URL)) {
  console.log('[dev-desktop] 1420 已有 dev server,复用现有 Vite');
} else {
  vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], {
    cwd: rootDir,
    stdio: 'inherit',
    detached: !isWin,
  });
  children.push(vite);
  if (!(await waitForServer(DEV_SERVER_URL, VITE_READY_TIMEOUT_MS))) {
    console.error(`[dev-desktop] Vite 在 ${VITE_READY_TIMEOUT_MS / 1000}s 内未就绪,退出`);
    killAll();
    process.exit(1);
  }
  console.log('[dev-desktop] Vite 已就绪');
}

// 3. daemon + Electron 壳(desktop-electron/scripts/dev.mjs,内部 supervisor 保证 daemon)
const electron = spawn(process.execPath, [path.join(rootDir, 'desktop-electron', 'scripts', 'dev.mjs')], {
  cwd: rootDir,
  stdio: 'inherit',
  detached: !isWin,
});
children.push(electron);

electron.on('exit', (code) => {
  killAll();
  process.exitCode = code ?? 0;
});

vite?.on('exit', (code) => {
  if (!shuttingDown) {
    console.error('[dev-desktop] Vite 意外退出,关闭桌面端');
    killAll();
    process.exitCode = code ?? 1;
  }
});

process.on('SIGINT', () => {
  killAll();
  process.exit(130);
});
process.on('SIGTERM', () => {
  killAll();
  process.exit(143);
});
