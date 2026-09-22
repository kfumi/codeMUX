/**
 * 流式绘制（paced reveal）A/B 实测运行器。
 *
 * 回答工单 6：`useStreamingTextReveal` 的分帧绘制保留、加大节拍，还是移除？
 *
 * 流程与 `scripts/e2e/transcript-probe` 同构，并且**共用它的 Electron 宿主**
 * （`../transcript-probe/electron-probe-main.cjs`）——窗口模式、后台节流开关、
 * 结论搬运都已在那里解决，不重复实现：
 *   1. 用 esbuild 把探针入口打成临时目录里的 ESM 包；
 *   2. 逐臂生成页面（`?mode=<arm>`）并在**offscreen** 无头 Electron 里跑
 *      （`show:false` 会把 rAF 压到 ~1-2Hz，那样分帧绘制根本不会被驱动，读数无意义）；
 *   3. 每臂重复 N 次取中位数，抵消无头机器的抖动；
 *   4. 打印对照表 + 一个机械判据。
 *
 * 退出码：0 = 跑通并给出读数；2 = 基础设施失败（缺 Electron / 打包失败 / 没拿到读数）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '..', '..', '..');
const hostEntry = path.join(rootDir, 'scripts', 'e2e', 'transcript-probe', 'electron-probe-main.cjs');

/** profiling 构建：生产版 React 下 `<Profiler>` 的 onRender 不会回调。 */
const profilingDom = path.join(rootDir, 'node_modules', 'react-dom', 'profiling.js');

/**
 * `reveal-plain` / `reveal-nocode` 是**诊断臂**：与 `reveal-default` 逐项相同，只替换 Markdown 的渲染方式。
 * `reveal-nocode` 保留 Markdown 解析与 DOM、去掉 Shiki 高亮；`reveal-plain` 两者都不要。
 * 它们存在的唯一目的是把"Markdown 渲染成本"拆成高亮 / 解析+DOM 两段，**不参与**保留/移除判定。
 */
const ALL_ARMS = [
  'direct',
  'reveal-default',
  'reveal-slow',
  'horizon-zero',
  'reveal-plain',
  'reveal-nocode',
  'reveal-warm',
  'reveal-lazy-code',
  'reveal-tail-lex',
  'reveal-tail-plain',
  'reveal-frame',
];

/**
 * 只跑指定臂（逗号分隔），迭代诊断时省时间，例如：
 * `CODEMUX_REVEAL_PROBE_ARMS=reveal-default,reveal-nocode node scripts/e2e/stream-reveal-probe/runner.mjs`
 */
const requestedArms = (process.env.CODEMUX_REVEAL_PROBE_ARMS || '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
for (const name of requestedArms) {
  if (!ALL_ARMS.includes(name)) {
    throw new Error(`未知臂 ${name}；可用：${ALL_ARMS.join('、')}`);
  }
}
const ARMS = requestedArms.length > 0 ? requestedArms : ALL_ARMS;
/** 真基线 = 完全不调用 hook（"移除分帧绘制"）。 */
const BASE_ARM = 'direct';
const CURRENT_ARM = 'reveal-default';
const SLOW_ARM = 'reveal-slow';
const HORIZON_ZERO_ARM = 'horizon-zero';

const REPS = Math.max(1, Number(process.env.CODEMUX_REVEAL_PROBE_REPS || 2));
const PER_RUN_TIMEOUT_MS = Number(process.env.CODEMUX_REVEAL_PROBE_TIMEOUT_MS || 120_000);
const KEEP_TEMP = process.env.CODEMUX_REVEAL_PROBE_KEEP_TEMP === '1';
/** 打印每条臂的长任务时间线（细节诊断用，不参与判据）。 */
const LONG_TASK_DETAIL = process.env.CODEMUX_REVEAL_PROBE_LONG_TASKS === '1';

/** 判据阈值（写在这里，方便复核与复算）。 */
/** 提交耗时相对基线允许上浮的比例——但只在"绝对代价不可忽略"时才用它否决。 */
const CPU_TOLERANCE_RATIO = 1.1;
/** p95 更新间隔至少改善这么多毫秒，才算"手感真的更好"。 */
const SMOOTHNESS_GAIN_MS = 20;
/** 提交耗时增量占整段流式挂钟时间的比例上限——低于它就算"绝对代价可忽略"。 */
const NEGLIGIBLE_WALL_SHARE = 0.05;
/** 长任务合计允许的相对上浮。超过它说明不是"把工作摊匀"，而是真把帧预算顶穿了。 */
const LONG_TASK_TOLERANCE_RATIO = 1.15;

const step = (message) => {
  process.stdout.write(`[stream-reveal-probe] ${message}\n`);
};

class InfraFailure extends Error {}

function resolveElectronExe() {
  const candidates = process.platform === 'win32'
    ? [path.join(rootDir, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe')]
    : [
      path.join(rootDir, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'Electron'),
      path.join(rootDir, 'node_modules', 'electron', 'dist', 'electron'),
    ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new InfraFailure(`找不到 Electron 二进制，尝试过：${candidates.join('、')}`);
  }
  return found;
}

/** 用构建产物里的样式表，让字体/行高/换行接近生产，而不是拿浏览器默认值量。 */
function resolveAppCss() {
  const assetsDir = path.join(rootDir, 'dist', 'assets');
  if (!fs.existsSync(assetsDir)) {
    return null;
  }
  const files = fs.readdirSync(assetsDir).filter((name) => name.endsWith('.css'));
  const preferred = files.find((name) => /^index-.*\.css$/.test(name));
  const chosen = preferred ?? files[0];
  return chosen ? path.join(assetsDir, chosen) : null;
}

function buildHtml({ cssHref, bundleHref }) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>CodeMUX stream reveal probe</title>
    ${cssHref ? `<link rel="stylesheet" href="${cssHref}" />` : ''}
    <style>
      html, body { height: 100%; margin: 0; }
      #probe-root { height: 100%; }
    </style>
  </head>
  <body>
    <div id="probe-root" class="bg-background text-foreground"></div>
    <script type="module" src="${bundleHref}"></script>
  </body>
</html>
`;
}

function killTree(child) {
  if (!child || child.killed || child.pid == null) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGKILL');
}

function runArm({ electronExe, arm, htmlPath, userDataDir }) {
  return new Promise((resolve) => {
    const child = spawn(electronExe, [hostEntry], {
      cwd: rootDir,
      env: {
        ...process.env,
        CODEMUX_PROBE_HTML: htmlPath,
        // 宿主把 MODE 原样放进页面 query，探针从 `?mode=` 读臂名。
        CODEMUX_PROBE_MODE: arm,
        CODEMUX_PROBE_WINDOW: 'offscreen',
        CODEMUX_PROBE_USER_DATA: userDataDir,
        CODEMUX_PROBE_TIMEOUT_MS: String(PER_RUN_TIMEOUT_MS),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (outcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ arm, ...outcome, stderr });
    };

    const timeout = setTimeout(() => {
      step(`  ${arm} 超过 ${PER_RUN_TIMEOUT_MS}ms，强杀进程树`);
      killTree(child);
      finish({ failure: { kind: 'timeout', message: `${arm} 超时` } });
    }, PER_RUN_TIMEOUT_MS + 15_000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => finish({ failure: { kind: 'spawn', message: error.message } }));
    child.on('close', (code) => {
      const lines = stdout.split(/\r?\n/);
      const failureLine = lines.find((line) => line.startsWith('CODEMUX_TRANSCRIPT_PROBE_FAILURE '));
      const resultLine = lines.find((line) => line.startsWith('CODEMUX_TRANSCRIPT_PROBE_MODE '));
      if (failureLine) {
        finish({ failure: JSON.parse(failureLine.slice('CODEMUX_TRANSCRIPT_PROBE_FAILURE '.length)) });
        return;
      }
      if (resultLine) {
        finish({ result: JSON.parse(resultLine.slice('CODEMUX_TRANSCRIPT_PROBE_MODE '.length)) });
        return;
      }
      finish({
        failure: {
          kind: 'no-result',
          message: `Electron 退出码 ${code}，没有拿到结论行`,
          tail: lines.filter((line) => line.length > 0).slice(-6).join(' | '),
        },
      });
    });
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function summarize(resultsByArm) {
  const summary = {};
  for (const arm of ARMS) {
    const runs = resultsByArm[arm] ?? [];
    const pick = (selector) => median(runs.map(selector).filter((value) => value != null));
    const medians = {
      commitMs: pick((entry) => entry.result?.profiler.totalMs),
      commits: pick((entry) => entry.result?.profiler.commits),
      maxCommitMs: pick((entry) => entry.result?.profiler.maxMs),
      longTaskTotalMs: pick((entry) => entry.result?.longTask.totalMs),
      longTaskCount: pick((entry) => entry.result?.longTask.count),
      visibleUpdates: pick((entry) => entry.result?.visible.updates),
      visiblePerSecond: pick((entry) => entry.result?.visible.perSecond),
      p50Ms: pick((entry) => entry.result?.visible.intervalP50),
      p95Ms: pick((entry) => entry.result?.visible.intervalP95),
      cv: pick((entry) => entry.result?.visible.charsPerUpdateCv),
      biggestJump: pick((entry) => entry.result?.visible.charsPerUpdateMax),
      hookFrames: pick((entry) => entry.result?.hookSmoothness.sampledFrames),
      framesObserved: pick((entry) => entry.result?.framesObserved),
      propUpdates: pick((entry) => entry.result?.propUpdates),
      scheduledChars: pick((entry) => entry.result?.scheduledChars),
      durationMs: pick((entry) => entry.result?.durationMs),
      storeTextAtStreamEnd: pick((entry) => entry.result?.storeTextAtStreamEnd),
      renderedAtHalf: pick((entry) => entry.result?.renderedAtHalf),
      renderedAtStreamEnd: pick((entry) => entry.result?.renderedAtStreamEnd),
    };
    summary[arm] = {
      runs: runs.length,
      ok: runs.filter((entry) => entry.result).length,
      medians,
      /** 长任务时间线（每次运行一份）：中位数表达不了"发生在哪一刻"，所以原样保留。 */
      longTaskRuns: runs.map((entry) => entry.result?.longTask?.entries ?? []),
    };
  }
  return summary;
}

function fmt(value, digits = 1) {
  return value == null ? '—' : value.toFixed(digits);
}

function printTable(summary) {
  const rows = [
    ['提交耗时合计 (ms)', 'commitMs', 1],
    ['提交次数', 'commits', 0],
    ['单次提交最长 (ms)', 'maxCommitMs', 1],
    ['长任务合计 (ms)', 'longTaskTotalMs', 1],
    ['长任务次数', 'longTaskCount', 0],
    ['可见更新次数', 'visibleUpdates', 0],
    ['可见更新/秒', 'visiblePerSecond', 1],
    ['可见更新间隔 p50 (ms)', 'p50Ms', 1],
    ['可见更新间隔 p95 (ms)', 'p95Ms', 1],
    ['字符/次 变异系数', 'cv', 3],
    ['单次最大推进 (字符)', 'biggestJump', 0],
    ['hook 的 rAF 回调数', 'hookFrames', 0],
    ['独立 rAF 帧数', 'framesObserved', 0],
    ['正文 prop 更新次数', 'propUpdates', 0],
    ['排程字符总数', 'scheduledChars', 0],
    ['流式结束时 store 正文字符', 'storeTextAtStreamEnd', 0],
    ['流式中点屏上字符', 'renderedAtHalf', 0],
    ['流式结束时屏上字符', 'renderedAtStreamEnd', 0],
    ['运行时长 (ms)', 'durationMs', 0],
  ];

  process.stdout.write('\n');
  process.stdout.write(`| 指标 | ${ARMS.join(' | ')} |\n`);
  process.stdout.write('|---|---|---|\n');
  for (const [label, key, digits] of rows) {
    const cells = ARMS.map((arm) => fmt(summary[arm].medians[key], digits));
    process.stdout.write(`| ${label} | ${cells.join(' | ')} |\n`);
  }
  process.stdout.write('\n');
  process.stdout.write(`每臂各字段取 ${REPS} 次运行的中位数。\n`);
  process.stdout.write('「可见更新」= 被渲染文本发生变化的次数（两臂同口径）；'
    + '「hook 的 rAF 回调数」是分帧绘制那条常驻帧循环是否还存在的直接证据。\n\n');
}
/** 长任务时间线：`t` 相对本次流式开始（ms），用来区分"一次性初始化"与"每次提交都在做"。 */
function printLongTasks(summary) {
  process.stdout.write('\n长任务明细：\n');
  for (const arm of ARMS) {
    const runs = summary[arm]?.longTaskRuns ?? [];
    const lines = runs.map((entries, index) => {
      if (entries.length === 0) {
        return `  第 ${index + 1} 次：无`;
      }
      return `  第 ${index + 1} 次：`
        + entries.map((entry) => `t=${entry.startMs}ms ${entry.durationMs}ms`).join('、');
    });
    process.stdout.write(`${arm}\n${lines.join('\n')}\n`);
  }
}


function classify(summary) {
  // 判定依赖 base / current / slow 三条臂同时在场；只跑子集时不做保留/移除判定。
  if (!summary[BASE_ARM] || !summary[CURRENT_ARM] || !summary[SLOW_ARM]) {
    return {
      verdict: 'subset',
      reason: `只跑了子集（${ARMS.join('、')}），判定所需的三条臂不全，跳过保留/移除判定。`,
    };
  }

  const base = summary[BASE_ARM].medians;
  const current = summary[CURRENT_ARM].medians;
  const slow = summary[SLOW_ARM].medians;

  if (base.commitMs == null || current.commitMs == null) {
    return { verdict: 'inconclusive', reason: '基线或现状臂没有拿到提交耗时读数。' };
  }

  const costRatio = current.commitMs / base.commitMs;
  const p95Gain = base.p95Ms != null && current.p95Ms != null ? base.p95Ms - current.p95Ms : null;
  const slowCostRatio = slow.commitMs != null ? slow.commitMs / base.commitMs : null;
  const slowP95Gain = slow.p95Ms != null && base.p95Ms != null ? base.p95Ms - slow.p95Ms : null;

  // 关键：判断"更贵"必须同时看**绝对代价**，不能只看比值。
  // 多出来的提交耗时如果只占整段流式挂钟的百分之几，而且长任务合计没有变差，
  // 那它就是"把同样的工作摊到更多更小的提交里"，不是把帧预算顶穿。
  const addedMs = current.commitMs - base.commitMs;
  const wallShare = current.durationMs != null ? addedMs / current.durationMs : null;
  const longTaskRatio = base.longTaskTotalMs != null && base.longTaskTotalMs > 0
    && current.longTaskTotalMs != null
    ? current.longTaskTotalMs / base.longTaskTotalMs
    : null;
  const absolutelyCheap = wallShare != null && wallShare <= NEGLIGIBLE_WALL_SHARE
    && longTaskRatio != null && longTaskRatio <= LONG_TASK_TOLERANCE_RATIO;
  const smoothnessHelps = p95Gain != null && p95Gain >= SMOOTHNESS_GAIN_MS;

  const notes = [];
  notes.push(`提交耗时 ${fmt(base.commitMs, 0)}ms → ${fmt(current.commitMs, 0)}ms`
    + `（${costRatio.toFixed(2)}×，绝对增量 ${fmt(addedMs, 0)}ms`
    + `${wallShare == null ? '' : ` = 挂钟的 ${(wallShare * 100).toFixed(1)}%`}）`);
  if (p95Gain != null) {
    notes.push(`可见更新间隔 p95 ${fmt(base.p95Ms, 0)}ms → ${fmt(current.p95Ms, 0)}ms（改善 ${p95Gain.toFixed(1)}ms）`);
  }
  notes.push(`长任务合计 ${fmt(base.longTaskTotalMs, 0)}ms → ${fmt(current.longTaskTotalMs, 0)}ms`
    + `${longTaskRatio == null ? '' : `（${longTaskRatio.toFixed(2)}×）`}`);
  if (slowCostRatio != null) {
    notes.push(`降低节拍臂 提交耗时比 ${slowCostRatio.toFixed(2)}×，p95 改善 ${fmt(slowP95Gain)}ms`);
  }
  notes.push(`hook 的 rAF 回调 基线 ${fmt(base.hookFrames, 0)} vs 现状 ${fmt(current.hookFrames, 0)}`
    + `（独立帧钟 ${fmt(base.framesObserved, 0)} / ${fmt(current.framesObserved, 0)}）`);

  // 核实"关闭分帧绘制"这个开关到底做了什么。
  const horizonZero = summary[HORIZON_ZERO_ARM]?.medians;
  if (horizonZero?.renderedAtStreamEnd != null && horizonZero?.storeTextAtStreamEnd != null) {
    notes.push(`horizon=0 臂：流式结束时 store 正文 ${fmt(horizonZero.storeTextAtStreamEnd, 0)} 字，`
      + `屏上 ${fmt(horizonZero.renderedAtStreamEnd, 0)} 字`);
  }

  const tail = notes.join('；');

  if (absolutelyCheap && smoothnessHelps) {
    return {
      verdict: 'keep',
      reason: `保留：分帧绘制把 p95 压下来了，而绝对代价可忽略`
        + `（占挂钟 ≤${(NEGLIGIBLE_WALL_SHARE * 100).toFixed(0)}% 且长任务没有变差）。${tail}`,
    };
  }
  if (costRatio <= CPU_TOLERANCE_RATIO && smoothnessHelps) {
    return { verdict: 'keep', reason: `保留：没有额外主线程成本且手感更好。${tail}` };
  }
  if (costRatio <= CPU_TOLERANCE_RATIO) {
    return {
      verdict: 'neutral',
      reason: `无额外主线程成本，但 p95 改善不足 ${SMOOTHNESS_GAIN_MS}ms，只能算白拿。${tail}`,
    };
  }
  if (slowCostRatio != null && slowCostRatio <= CPU_TOLERANCE_RATIO
    && slowP95Gain != null && slowP95Gain >= SMOOTHNESS_GAIN_MS) {
    return { verdict: 'raise-horizon', reason: `现状臂更贵且代价不可忽略，降低节拍臂更好。${tail}` };
  }
  return { verdict: 'remove', reason: `分帧绘制更贵、代价不可忽略，且没有换回足够的手感改善。${tail}` };
}

async function main() {
  const electronExe = resolveElectronExe();
  step(`Electron：${electronExe}`);
  if (!fs.existsSync(hostEntry)) {
    throw new InfraFailure(`找不到共用的 Electron 宿主入口：${hostEntry}`);
  }

  const appCss = resolveAppCss();
  step(appCss ? `样式表：${path.relative(rootDir, appCss)}` : '样式表：未找到 dist 产物，用浏览器默认值（会影响布局手感，但不影响提交耗时对比）');
  const cssHref = appCss ? pathToFileURL(appCss).href : null;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codemux-stream-reveal-probe-'));
  step(`临时目录：${tempDir}`);

  try {
    const esbuild = await import('esbuild');
    step('esbuild 打包探针入口（真实 store 无关，真实 hook + 真实 Streamdown）…');
    const buildResult = await esbuild.build({
      entryPoints: [path.join(here, 'probe-entry.tsx')],
      outdir: tempDir,
      bundle: true,
      format: 'esm',
      splitting: true,
      platform: 'browser',
      target: ['chrome130'],
      jsx: 'automatic',
      tsconfig: path.join(rootDir, 'tsconfig.json'),
      alias: {
        '@': path.join(rootDir, 'src'),
        // 生产版 React 里 `<Profiler>` 的 onRender 不会被调用，
        // 必须指向 profiling 构建才能拿到提交耗时。
        // 注意：esbuild 的别名也匹配子路径，所以 `react-dom` 与 `react-dom/client`
        // 必须分别写明，否则 `react-dom/client` 会被重映射成 `<profiling.js>/client`。
        'react-dom': profilingDom,
        'react-dom/client': profilingDom,
      },
      define: {
        'process.env.NODE_ENV': '"production"',
        'import.meta.env.DEV': 'false',
        'import.meta.env.PROD': 'true',
        'import.meta.env.MODE': '"production"',
        'import.meta.env.SSR': 'false',
      },
      loader: {
        // 真实样式表由页面单独 link dist 产物；JS 里 import 的 CSS 一律留空。
        '.css': 'empty',
        '.png': 'file',
        '.jpg': 'file',
        '.jpeg': 'file',
        '.gif': 'file',
        '.webp': 'file',
        '.svg': 'file',
        '.woff': 'file',
        '.woff2': 'file',
      },
      assetNames: 'asset-[hash]',
      entryNames: 'probe-entry-[hash]',
      chunkNames: 'chunk-[hash]',
      logLevel: 'warning',
      metafile: true,
    });

    const entryFile = Object.keys(buildResult.metafile.outputs)
      .find((file) => /probe-entry-.*\.js$/.test(file));
    if (!entryFile) {
      throw new InfraFailure('esbuild 没有产出探针入口文件');
    }
    step(`打包完成：${path.basename(entryFile)}`);

    const resultsByArm = {};
    for (const arm of ARMS) {
      resultsByArm[arm] = [];
      for (let rep = 0; rep < REPS; rep += 1) {
        const htmlPath = path.join(tempDir, `index-${arm}-${rep}.html`);
        await writeFile(htmlPath, buildHtml({
          cssHref,
          bundleHref: `./${path.basename(entryFile)}`,
        }), 'utf8');
        const userDataDir = path.join(tempDir, `user-data-${arm}-${rep}`);
        fs.mkdirSync(userDataDir, { recursive: true });

        step(`运行 ${arm}（第 ${rep + 1}/${REPS} 次）…`);
        const outcome = await runArm({ electronExe, arm, htmlPath, userDataDir });
        resultsByArm[arm].push(outcome);

        if (outcome.result) {
          const r = outcome.result;
          step(`  提交 ${r.profiler.commits} 次 / ${r.profiler.totalMs.toFixed(1)}ms`
            + `（最长 ${r.profiler.maxMs.toFixed(1)}ms）· 长任务 ${r.longTask.count} 次 / ${r.longTask.totalMs.toFixed(1)}ms`
            + ` · 可见更新 ${r.visible.updates} 次 / ${r.visible.perSecond.toFixed(1)}s`
            + ` · 间隔 p50 ${r.visible.intervalP50.toFixed(1)}ms p95 ${r.visible.intervalP95.toFixed(1)}ms`
            + ` · CV ${r.visible.charsPerUpdateCv.toFixed(3)}`
            + ` · hook帧 ${r.hookSmoothness.sampledFrames} · 独立帧 ${r.framesObserved}`
            + ` · prop更新 ${r.propUpdates}`
            + ` · store 正文 ${r.storeTextAtStreamEnd} / 屏上 ${r.renderedAtStreamEnd}`);
          if (r.tailLex && r.tailLex.calls > 0) {
            step(`  增量分块自检：${r.tailLex.calls} 次输入，`
              + `${r.tailLex.mismatches} 次与参考实现不一致`
              + `${r.tailLex.mismatches === 0 ? '（逐项一致）' : '（**有偏差，此臂读数不可用**）'}`);
          }
          if (r.pageErrors.length > 0) {
            step(`  页面报错：${r.pageErrors.slice(0, 3).join(' | ')}`);
          }
        } else {
          step(`  失败：${JSON.stringify(outcome.failure)}`);
        }
      }
    }

    const summary = summarize(resultsByArm);
    const anyReading = Object.values(summary).some((entry) => entry.ok > 0);
    if (!anyReading) {
      process.stdout.write('CODEMUX_STREAM_REVEAL_PROBE_FAILURE '
        + `${JSON.stringify({ kind: 'no-reading', message: '所有臂都没有拿到读数' })}\n`);
      process.exitCode = 2;
      return;
    }

    printTable(summary);
    if (LONG_TASK_DETAIL) {
      printLongTasks(summary);
    }
    const verdict = classify(summary);
    step(`判据：${verdict.verdict}`);
    step(`理由：${verdict.reason}`);

    process.stdout.write(`CODEMUX_STREAM_REVEAL_PROBE ${JSON.stringify({ verdict, summary })}\n`);
  } finally {
    if (KEEP_TEMP) {
      step(`保留临时目录：${tempDir}`);
    } else {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  const failure = error instanceof InfraFailure
    ? { kind: 'infra', message: error.message }
    : { kind: 'runner', message: error && error.stack ? error.stack : String(error) };
  process.stdout.write(`CODEMUX_STREAM_REVEAL_PROBE_FAILURE ${JSON.stringify(failure)}\n`);
  process.exit(2);
});
