/**
 * 探针的 Electron 主进程（CommonJS，作为 app 入口传给 electron.exe）。
 *
 * 职责：开窗口（默认 show: false；offscreen 模式 showInactive 到屏幕外）、用独立 userData 隔离、
 * 把渲染进程 console 转发出来、等页面里的探针 promise 落地，然后把结论以单行 JSON 打到 stdout。
 * 只负责搬运，不做任何断言——断言在页面里、由真实布局引擎给出。
 *
 * 环境变量：
 *   CODEMUX_PROBE_HTML       探针页面路径
 *   CODEMUX_PROBE_MODE       with-skip | without-skip
 *   CODEMUX_PROBE_USER_DATA  独立 userData 目录
 *   CODEMUX_PROBE_TIMEOUT_MS 页内硬超时（超时即非零退出）
 *   CODEMUX_PROBE_WINDOW     headless（默认，show:false）| offscreen（showInactive 到屏幕外）
 *
 * 为什么要 offscreen：`show: false` 时 Chromium 把 rAF 压到 ~1-2Hz，平滑滚动退化成「瞬移」，
 * 目标行之上的行根本不会被途经渲染——而那正是这条回归的触发条件。offscreen 模式把窗口
 * showInactive 到 (-4000,-4000)（不显示给用户，也不在任何显示器的可见区域内），
 * 换回 ~60Hz 的合成器与真实的逐帧平滑滚动。
 */
const { app, BrowserWindow } = require('electron');

const htmlPath = process.env.CODEMUX_PROBE_HTML;
const mode = process.env.CODEMUX_PROBE_MODE || 'unknown';
const userDataDir = process.env.CODEMUX_PROBE_USER_DATA;
const windowMode = process.env.CODEMUX_PROBE_WINDOW || 'headless';
const timeoutMs = Number(process.env.CODEMUX_PROBE_TIMEOUT_MS || 240000);

const log = (line) => {
  process.stdout.write(`${line}\n`);
};

if (!htmlPath) {
  log('CODEMUX_TRANSCRIPT_PROBE_FAILURE ' + JSON.stringify({
    mode,
    kind: 'infra',
    message: '缺少 CODEMUX_PROBE_HTML 环境变量',
  }));
  process.exit(2);
}

if (userDataDir) {
  app.setPath('userData', userDataDir);
}

// 布局不依赖 GPU；关掉它让无头/无 GPU 的机器上更稳。
app.disableHardwareAcceleration();
// 窗口不可见时默认会节流渲染与动画，而平滑滚动正是靠动画完成的。
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const hardTimeout = setTimeout(() => {
  log(`[probe:${mode}] 硬超时 ${timeoutMs}ms，强制结束`);
  log('CODEMUX_TRANSCRIPT_PROBE_FAILURE ' + JSON.stringify({
    mode,
    kind: 'timeout',
    message: `探针在 ${timeoutMs}ms 内没有给出结论`,
  }));
  process.exit(3);
}, timeoutMs);

function forwardConsoleMessage(...args) {
  const [, levelOrDetails, maybeMessage, maybeLine] = args;
  const details = levelOrDetails && typeof levelOrDetails === 'object' ? levelOrDetails : null;
  const message = details ? details.message : maybeMessage;
  const line = details ? details.lineNumber : maybeLine;
  log(`[page:${mode}]${line != null ? ` (${line})` : ''} ${message}`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    useContentSize: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (windowMode === 'offscreen') {
    // show:false 会被 Chromium 当成 hidden 页面，rAF 掉到 ~1-2Hz；把窗口挪到所有显示器之外
    // 再 showInactive，就能拿回 60Hz 合成器，同时又不会真的显示给用户。
    win.setPosition(-4000, -4000);
    win.showInactive();
    log(`[probe:${mode}] offscreen 窗口：${JSON.stringify(win.getBounds())}`);
  }

  win.webContents.on('console-message', forwardConsoleMessage);
  win.webContents.on('render-process-gone', (_event, details) => {
    log(`[probe:${mode}] 渲染进程退出：${JSON.stringify(details)}`);
  });
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    log(`[probe:${mode}] 页面加载失败：${errorCode} ${errorDescription} ${validatedUrl}`);
  });

  await win.loadFile(htmlPath, { query: { mode, window: windowMode } });
  log(`[probe:${mode}] 页面已加载（window=${windowMode}），等待探针结论`);

  const result = await win.webContents.executeJavaScript(
    'window.__CODEMUX_TRANSCRIPT_PROBE__ && window.__CODEMUX_TRANSCRIPT_PROBE__.promise',
  );

  if (!result) {
    throw new Error('页面里没有 __CODEMUX_TRANSCRIPT_PROBE__——探针脚本没有执行成功，请看上面的 [page:*] 输出');
  }

  clearTimeout(hardTimeout);
  log(`CODEMUX_TRANSCRIPT_PROBE_MODE ${JSON.stringify(result)}`);
  win.destroy();
  app.exit(0);
}).catch((error) => {
  clearTimeout(hardTimeout);
  log('CODEMUX_TRANSCRIPT_PROBE_FAILURE ' + JSON.stringify({
    mode,
    kind: 'page',
    message: error && error.message ? error.message : String(error),
  }));
  app.exit(3);
});
