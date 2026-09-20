// 一键开发启动:等价于顺序执行 `npm run dev` + `npm run dev:electron`。
// Electron 壳加载渲染层没有重试逻辑(main.ts 直接 loadURL),所以必须等
// Vite 在 1420 就绪后再拉壳;daemon 由壳内 supervisor 自行拉起,无需照管。
// 退出(壳关闭 / Ctrl+C / 任一子进程意外退出)时统一清理全部子进程。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
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

/**
 * sidecar 构建产物(apps/sidecar/dist)的陈旧检测。
 *
 * 守护进程按会话惰性加载 `sidecar/dist/index.js`,而 `dev:desktop` 自己不构建它:
 * 改了 sidecar 源码却没重建时,dev 会静默跑旧产物(实测踩过:sidecar 新加的 `model`
 * 字段一直不生效,查到最后才发现 dist 落后了三天)。全量 tsc 实测 3~5s,不该每次
 * 启动都付;所以先比 mtime —— 平时一次递归 stat 约几十毫秒,只有源码更新才构建。
 */
const SIDECAR_DIR = path.join(rootDir, 'apps', 'sidecar');
const SIDECAR_DIST_ENTRY = path.join(SIDECAR_DIR, 'dist', 'index.js');
const SIDECAR_INPUTS = [
  path.join(SIDECAR_DIR, 'src'),
  path.join(SIDECAR_DIR, 'package.json'),
  path.join(SIDECAR_DIR, 'tsconfig.json'),
];

function newestMtimeMs(target) {
  let newest = 0;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    let stat;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      newest = Math.max(newest, stat.mtimeMs);
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      stack.push(path.join(current, entry));
    }
  }
  return newest;
}

/** 需要构建的原因;`null` 表示 dist 比所有输入都新,可以直接用。 */
function sidecarStaleReason() {
  let distMtimeMs;
  try {
    distMtimeMs = fs.statSync(SIDECAR_DIST_ENTRY).mtimeMs;
  } catch {
    return 'dist/index.js 不存在';
  }
  for (const input of SIDECAR_INPUTS) {
    if (newestMtimeMs(input) > distMtimeMs) {
      return `${path.relative(rootDir, input)} 比 dist 新`;
    }
  }
  return null;
}

async function ensureSidecarBuilt() {
  const reason = sidecarStaleReason();
  if (!reason) {
    console.log('[dev-desktop] sidecar dist 是最新的,跳过构建');
    return;
  }
  console.log(`[dev-desktop] sidecar 需要构建(${reason}),运行 build:sidecar…`);
  const started = Date.now();
  const result = spawnSync(isWin ? 'npm.cmd' : 'npm', ['run', 'build:sidecar'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: isWin,
  });
  if (result.status === 0) {
    console.log(`[dev-desktop] sidecar 构建完成(${((Date.now() - started) / 1000).toFixed(1)}s)`);
    return;
  }
  // 构建失败不阻塞 dev:渲染层照旧起来,错误留给控制台与启动会话时的 sidecar 报错。
  console.error('[dev-desktop] sidecar 构建失败,dev 继续;会话可能跑旧 dist 或起不来');
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

// sidecar 构建与 Vite 并行推进:它必须在拉 Electron 之前就绪,但不占用 Vite 的启动
// 时间——需要构建时最多省下 3~5s 的串行等待。
const sidecarReady = ensureSidecarBuilt();

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

await sidecarReady;

// 3. daemon + Electron 壳(apps/desktop/scripts/dev.mjs,内部 supervisor 保证 daemon)
const electron = spawn(process.execPath, [path.join(rootDir, 'apps', 'desktop', 'scripts', 'dev.mjs')], {
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
