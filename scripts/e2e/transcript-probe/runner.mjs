/**
 * 真实引擎探针运行器。
 *
 * 流程：
 *   1. 校验构建产物与源码同步（`[data-long-thread] [data-message-row]` 的声明集合）——
 *      产物落后于源码时明确失败，绝不在旧产物上给结论；
 *   2. 用 esbuild 把探针入口（真实 store + 真实 CodeMuxThread）打成临时目录里的 ESM 包；
 *   3. 生成页面并在无头 Electron 里跑：{窗口模式} × {跳过规则生效 / 被 !important 中和}；
 *      页面 link 的都是 dist 里构建出来的样式表；
 *   4. 用「动画是否真的逐帧推进」（页面内测得的 rAF 速率）挑出有效的那对读数，合成结论。
 *
 * 为什么有窗口模式这一维：`show: false` 时 Chromium 把 rAF 压到 ~1-2Hz，平滑滚动退化成
 * 一次「瞬移」，目标行之上的行根本不会被途经渲染——那正是这条回归的触发条件。offscreen
 * 模式把窗口 showInactive 到屏幕外，换回 ~60Hz 的合成器。两种模式的读数都报出来，
 * 结论取动画真正跑起来的那一对（没有一对跑起来就判 inconclusive）。
 *
 * 退出码：0 = 探针跑通并给出结论（无论结论是证实还是未复现）；
 *         2 = 基础设施失败（缺 Electron、缺 dist、产物漂移、spawn 失败、超时、没拿到读数）。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertLongThreadStylesheetInSync, LONG_THREAD_SELECTOR } from './stylesheet-contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '..', '..', '..');

/** 跳过规则生效 / 被 !important 中和。 */
const PROBE_MODES = ['with-skip', 'without-skip'];
const PRIMARY_MODE = 'with-skip';
const BASELINE_MODE = 'without-skip';
/** headless = show:false（工单要求）；offscreen = showInactive 到屏幕外，动画才是逐帧的。 */
const WINDOW_MODES = (process.env.CODEMUX_PROBE_WINDOWS ?? 'headless,offscreen')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
/** rAF 速率高于这个值才认为「平滑滚动是逐帧推进的」，也就是这次测量具备触发条件。 */
const LIVE_FRAME_RATE_HZ = 20;
const DELTA_TOLERANCE_PX = 1;
const PER_RUN_TIMEOUT_MS = Number(process.env.CODEMUX_PROBE_TIMEOUT_MS || 300_000);
const KEEP_TEMP = process.env.CODEMUX_PROBE_KEEP_TEMP === '1';

const startedAt = Date.now();
const step = (message) => {
  process.stdout.write(`[transcript-probe] ${message}\n`);
};

/** 基础设施失败：抛出来，让 main 在清理临时目录之后再以非零码退出。 */
class InfraFailure extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'InfraFailure';
    this.extra = extra;
  }
}

function failInfra(message, extra = {}) {
  throw new InfraFailure(message, extra);
}

function resolveElectronExe() {
  const candidates = process.platform === 'win32'
    ? [path.join(rootDir, 'desktop-electron', 'node_modules', 'electron', 'dist', 'electron.exe')]
    : [
      path.join(rootDir, 'desktop-electron', 'node_modules', 'electron', 'dist', 'Electron'),
      path.join(rootDir, 'node_modules', 'electron', 'dist', 'electron'),
    ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    failInfra(`找不到 Electron 二进制，尝试过：${candidates.join('、')}`);
  }
  return found;
}

function readElectronVersion(electronExe) {
  try {
    const packageJsonPath = path.join(path.dirname(path.dirname(electronExe)), 'package.json');
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function buildHtml({ cssHref, neutralize, bundleHref }) {
  const neutralizeStyle = neutralize
    ? `<style id="probe-neutralize-skip">
      /* 中和跳过规则：DOM 与 data-long-thread 属性都不变，只是让规则不生效。 */
      ${LONG_THREAD_SELECTOR} { content-visibility: visible !important; contain-intrinsic-size: none !important; }
    </style>
    <style id="probe-neutralize-mark">/* probe:neutralized */</style>`
    : '<style id="probe-neutralize-mark">/* probe:untouched */</style>';

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>CodeMUX transcript probe</title>
    <link rel="stylesheet" href="${cssHref}" />
    ${neutralizeStyle}
    <style>
      html, body { height: 100%; margin: 0; }
      #probe-root { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
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
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGKILL');
}

/** 跑一次无头 Electron，返回页面里的读数或失败信息。 */
function runProbe({ electronExe, probeMode, windowMode, htmlPath, userDataDir }) {
  return new Promise((resolve) => {
    const child = spawn(electronExe, [path.join(here, 'electron-probe-main.cjs')], {
      cwd: rootDir,
      env: {
        ...process.env,
        CODEMUX_PROBE_HTML: htmlPath,
        CODEMUX_PROBE_MODE: `${probeMode}/${windowMode}`,
        CODEMUX_PROBE_WINDOW: windowMode,
        CODEMUX_PROBE_USER_DATA: userDataDir,
        CODEMUX_PROBE_TIMEOUT_MS: String(PER_RUN_TIMEOUT_MS),
        ELECTRON_ENABLE_LOGGING: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const startedAtMs = Date.now();

    const finish = (outcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ probeMode, windowMode, ...outcome, elapsedMs: Date.now() - startedAtMs, stderr });
    };

    const timeout = setTimeout(() => {
      step(`运行 ${probeMode}/${windowMode} 超过 ${PER_RUN_TIMEOUT_MS}ms，强杀进程树`);
      killTree(child);
      finish({ failure: { kind: 'timeout', message: `运行 ${probeMode}/${windowMode} 超时` } });
    }, PER_RUN_TIMEOUT_MS + 15_000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      finish({ failure: { kind: 'spawn', message: error.message } });
    });
    child.on('close', (code) => {
      const lines = stdout.split(/\r?\n/);
      for (const line of lines) {
        if (line.startsWith('[page:')) {
          // 渲染进程 console 直接转发，出错时是第一现场。
          process.stdout.write(`  ${line}\n`);
        } else if (line.startsWith('[probe:')) {
          step(line);
        }
      }
      if (stderr.trim().length > 0) {
        step(`运行 ${probeMode}/${windowMode} stderr 片段：${stderr.trim().split(/\r?\n/).slice(0, 4).join(' | ')}`);
      }

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
          message: `Electron 退出码 ${code}，但没有拿到结论行`,
          tail: lines.filter((line) => line.length > 0).slice(-8).join(' | '),
        },
      });
    });
  });
}

function describeMeasurement(label, result) {
  if (!result) {
    return `${label}: 无读数`;
  }
  return `${label}: residual=${result.residualPx.toFixed(2)}px `
    + `(漂移 ${result.targetDocTopDriftPx.toFixed(2)} 滚动误差 ${result.scrollTopErrorPx.toFixed(2)}) `
    + `目标行高 ${result.targetHeightBeforeClickPx.toFixed(1)}→${result.targetHeightAfterSettlePx.toFixed(1)}px `
    + `占位行数=${result.rowDiagnostics.placeholderRowCount}(目标之上 ${result.rowDiagnostics.placeholderRowsAboveTarget}) `
    + `目标索引=${result.rowDiagnostics.targetRowIndex} 路径=${result.navPath} `
    + `内容高度 ${result.scrollHeightBeforeClickPx}→${result.scrollHeightAfterSettlePx} `
    + `落定=${result.settleTimedOut ? '超时' : '稳定'}(${result.settleStableMs.toFixed(0)}ms) `
    + `轨迹点=${result.settleTrajectory.length}`;
}

function collectWarnings(result) {
  const warnings = [];
  if (!result) {
    return warnings;
  }
  if (Math.abs(result.initialBottomOffsetPx) > 1) {
    warnings.push(`起点没有停在底部（偏差 ${result.initialBottomOffsetPx.toFixed(1)}px）`);
  }
  for (const measurement of [result.primary, result.literalEarliest]) {
    if (!measurement.scrollStarted) {
      warnings.push(`${measurement.targetId} 触发跳转后没有观察到滚动`);
    }
    if (measurement.settleTimedOut) {
      warnings.push(`${measurement.targetId} 平滑滚动在超时前没有落定`);
    }
    if (measurement.navPath !== 'nav-marker-click') {
      warnings.push(`${measurement.targetId} 走的是退化路径（${measurement.navPath}）而不是真实导航标记点击`);
    }
  }
  if (result.pageErrors.length > 0) {
    warnings.push(`页面报错：${result.pageErrors.join(' | ')}`);
  }
  return warnings;
}

function summarizeWindowMode(samples, windowMode) {
  const withSkip = samples[PRIMARY_MODE]?.result ?? null;
  const withoutSkip = samples[BASELINE_MODE]?.result ?? null;
  const residualWithSkip = withSkip?.primary?.residualPx ?? null;
  const residualWithoutSkip = withoutSkip?.primary?.residualPx ?? null;
  const deltaPx = residualWithSkip != null && residualWithoutSkip != null
    ? residualWithSkip - residualWithoutSkip
    : null;
  const rafRateHz = withSkip?.rafRateHz ?? withoutSkip?.rafRateHz ?? null;
  const mechanismActive = Boolean(
    withSkip
    && withSkip.primary.rowDiagnostics.placeholderRowCount > 0
    && withSkip.primary.targetWasSkippedBeforeClick,
  );

  const primaryDriftPx = withSkip?.primary?.targetDocTopDriftPx ?? null;
  const baselineDriftPx = withoutSkip?.primary?.targetDocTopDriftPx ?? null;

  return {
    windowMode,
    rafRateHz,
    animated: rafRateHz != null && rafRateHz >= LIVE_FRAME_RATE_HZ,
    residualWithSkip,
    residualWithoutSkip,
    deltaPx,
    /** 残差分解：布局漂移（跳转途中目标行位置被改变）与滚动落点误差各自贡献多少。 */
    driftWithSkipPx: primaryDriftPx,
    driftWithoutSkipPx: baselineDriftPx,
    driftDeltaPx: primaryDriftPx != null && baselineDriftPx != null ? primaryDriftPx - baselineDriftPx : null,
    scrollTopErrorWithSkipPx: withSkip?.primary?.scrollTopErrorPx ?? null,
    scrollTopErrorWithoutSkipPx: withoutSkip?.primary?.scrollTopErrorPx ?? null,
    contentHeightDeltaWithSkipPx: withSkip?.primary?.scrollHeightDeltaPx ?? null,
    contentHeightDeltaWithoutSkipPx: withoutSkip?.primary?.scrollHeightDeltaPx ?? null,
    /** 中和是否真的生效：目标行上的计算样式 + 有没有行塌成 0 高度。 */
    neutralization: {
      withSkipContentVisibility: withSkip?.primary?.computedContentVisibility ?? null,
      withoutSkipContentVisibility: withoutSkip?.primary?.computedContentVisibility ?? null,
      withSkipContainIntrinsicSize: withSkip?.primary?.computedContainIntrinsicSize ?? null,
      withoutSkipContainIntrinsicSize: withoutSkip?.primary?.computedContainIntrinsicSize ?? null,
      withoutSkipZeroHeightRows: withoutSkip?.primary?.rowCountWithZeroHeight ?? null,
    },
    mechanismActive,
    placeholderRowsAboveTarget: withSkip?.primary?.rowDiagnostics?.placeholderRowsAboveTarget ?? null,
    targetWasSkippedBeforeClick: withSkip?.primary?.targetWasSkippedBeforeClick ?? null,
    /** 工单 02/03 的最后一项断言：滚动/跳转落定后，导航高亮与视口一致（真实引擎）。 */
    highlight: withSkip?.highlight ?? null,
    complete: residualWithSkip != null && residualWithoutSkip != null,
    warnings: [
      ...collectWarnings(withSkip).map((warning) => `${PRIMARY_MODE}: ${warning}`),
      ...collectWarnings(withoutSkip).map((warning) => `${BASELINE_MODE}: ${warning}`),
    ],
  };
}

function pickAuthoritative(byWindowMode) {
  const ordered = WINDOW_MODES.map((windowMode) => byWindowMode[windowMode]).filter(Boolean);
  return ordered.find((entry) => entry.complete && entry.animated)
    ?? ordered.find((entry) => entry.complete)
    ?? null;
}

function buildConclusion({ samples, neutralization, electronVersion, stylesheet }) {
  const byWindowMode = Object.fromEntries(
    WINDOW_MODES.map((windowMode) => [windowMode, summarizeWindowMode(samples[windowMode] ?? {}, windowMode)]),
  );
  const authoritative = pickAuthoritative(byWindowMode);
  const expectedResidualPx = samples[authoritative?.windowMode]?.[PRIMARY_MODE]?.result?.primary?.expectedResidualPx ?? 22;

  const residualWithSkip = authoritative?.residualWithSkip ?? null;
  const residualWithoutSkip = authoritative?.residualWithoutSkip ?? null;
  const deltaPx = authoritative?.deltaPx ?? null;
  const mechanismActive = authoritative?.mechanismActive ?? false;

  const warnings = [];
  for (const entry of Object.values(byWindowMode)) {
    for (const warning of entry.warnings) {
      warnings.push(`${entry.windowMode}: ${warning}`);
    }
    if (entry.complete && !entry.animated) {
      warnings.push(`${entry.windowMode}: rAF 只有 ${entry.rafRateHz}Hz，平滑滚动是「瞬移」的，`
        + '目标行之上的行不会被途经渲染，这次读数不具备触发条件');
    }
  }

  const headless = byWindowMode.headless;
  const offscreen = byWindowMode.offscreen;
  if (headless?.complete && offscreen?.complete
    && headless.deltaPx != null && offscreen.deltaPx != null
    && Math.abs(headless.deltaPx - offscreen.deltaPx) > DELTA_TOLERANCE_PX) {
    warnings.push(`两种窗口模式的差值不同（headless ${headless.deltaPx.toFixed(2)}px vs `
      + `offscreen ${offscreen.deltaPx.toFixed(2)}px）：说明动画是否逐帧推进会改变结论，`
      + '结论取 offscreen（动画真实推进）那一组。');
  }

  let verdict;
  let interpretation;
  if (deltaPx == null) {
    verdict = 'inconclusive';
    interpretation = '两种状态没有同时拿到读数，无法比较。';
  } else if (!mechanismActive) {
    verdict = 'inconclusive';
    interpretation = 'with-skip 下没有观察到「跳过渲染」参与布局（没有行落在 200px 占位高度上，'
      + '或目标行在点击前已经被渲染过），因此这次的差值说明不了跳过规则的影响。';
  } else if (Math.abs(deltaPx) <= DELTA_TOLERANCE_PX) {
    verdict = 'not-reproduced';
    interpretation = `跳过渲染与中和后的落点差 ${deltaPx.toFixed(2)}px（≤${DELTA_TOLERANCE_PX}px 视为一致）：`
      + `在 ${authoritative.windowMode} 窗口下，离屏跳过没有让跳转落点偏离。`;
  } else {
    verdict = 'reproduced';
    const driftDelta = authoritative.driftDeltaPx;
    const scrollErrorDelta = authoritative.scrollTopErrorWithSkipPx != null
      && authoritative.scrollTopErrorWithoutSkipPx != null
      ? authoritative.scrollTopErrorWithSkipPx - authoritative.scrollTopErrorWithoutSkipPx
      : null;
    interpretation = `跳过渲染使落点偏离 ${deltaPx.toFixed(2)}px`
      + '（deltaPx = 跳过时残差 − 中和后残差；正数表示跳过时目标行停得更靠下）。'
      + ` 这一差值由两部分构成：跳转途中的布局漂移差 ${driftDelta == null ? '?' : driftDelta.toFixed(2)}px `
      + `与滚动落点误差差 ${scrollErrorDelta == null ? '?' : scrollErrorDelta.toFixed(2)}px。`;
  }

  const baselinePenaltyPx = residualWithoutSkip != null ? residualWithoutSkip - expectedResidualPx : null;
  if (baselinePenaltyPx != null && Math.abs(baselinePenaltyPx) > 4) {
    interpretation += ` 注意：中和后的落点本身也偏离目标 ${baselinePenaltyPx.toFixed(2)}px`
      + `（其中布局漂移 ${authoritative.driftWithoutSkipPx?.toFixed(2) ?? '?'}px、`
      + `滚动误差 ${authoritative.scrollTopErrorWithoutSkipPx?.toFixed(2) ?? '?'}px）——`
      + '说明长会话里跳转落点还有与跳过规则无关的偏差，不能只归因于跳过。';
  }

  const withSkipResult = samples[authoritative?.windowMode]?.[PRIMARY_MODE]?.result ?? null;
  const withoutSkipResult = samples[authoritative?.windowMode]?.[BASELINE_MODE]?.result ?? null;
  const earliestDeltaPx = withSkipResult && withoutSkipResult
    ? withSkipResult.literalEarliest.residualPx - withoutSkipResult.literalEarliest.residualPx
    : null;

  return {
    ok: deltaPx != null && mechanismActive,
    okDefinition: 'ok = 有效的那一组两次读数都拿到、且 with-skip 下确实观察到跳过渲染参与布局（结论本身不参与 ok）。',
    authoritativeWindowMode: authoritative?.windowMode ?? null,
    animationLive: authoritative?.animated ?? false,
    target: {
      id: withSkipResult?.primary.targetId ?? null,
      turn: withSkipResult?.primary.targetTurn ?? null,
      selector: withSkipResult?.primary.targetSelector ?? null,
      note: '主目标是「较早但不是第一条」的用户消息：最早那条之上没有任何行，无法体现累计偏移。',
    },
    residualWithSkip,
    residualWithoutSkip,
    deltaPx,
    deltaDefinition: 'deltaPx = residualWithSkip - residualWithoutSkip（正数 = 跳过渲染时目标行落得更靠下）。',
    expectedResidualPx,
    skipPenaltyPx: residualWithSkip != null ? residualWithSkip - expectedResidualPx : null,
    baselinePenaltyPx,
    literalEarliest: {
      turn: withSkipResult?.literalEarliest.targetTurn ?? withoutSkipResult?.literalEarliest.targetTurn ?? null,
      residualWithSkip: withSkipResult?.literalEarliest.residualPx ?? null,
      residualWithoutSkip: withoutSkipResult?.literalEarliest.residualPx ?? null,
      deltaPx: earliestDeltaPx,
      note: '字面意义上的最早一条用户消息；它之上的累计行数为 0，两种状态都会被 scrollTop 下界截断。',
    },
    verdict,
    mechanismActive,
    highlight: authoritative?.highlight ?? null,
    interpretation,
    warnings,
    neutralization,
    rule: LONG_THREAD_SELECTOR,
    stylesheet,
    electronVersion,
    byWindowMode,
    samples,
    totalElapsedMs: Date.now() - startedAt,
  };
}

async function main() {
  let exitCode = 0;
  const electronExe = resolveElectronExe();
  const electronVersion = readElectronVersion(electronExe);
  step(`Electron：${electronExe}（${electronVersion ?? '版本未知'}）`);

  const stylesheet = assertLongThreadStylesheetInSync(rootDir);
  if (!stylesheet.ok) {
    failInfra(stylesheet.reason, { stylesheet });
  }
  step(`样式表契约通过：${stylesheet.builtDeclarations.map(
    (entry) => `${entry.cssFile} {${JSON.stringify(entry.declarations)}}`,
  ).join(' ')}`);

  const cssHref = pathToFileURL(stylesheet.cssFiles[0]).href;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codemux-transcript-probe-'));
  step(`临时目录：${tempDir}`);

  try {
    const esbuild = await import('esbuild');
    step('esbuild 打包探针入口（真实 store + 真实 CodeMuxThread）…');
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
      alias: { '@': path.join(rootDir, 'src') },
      define: {
        'process.env.NODE_ENV': '"production"',
        // Vite 注入的 import.meta.env：浏览器原生 import.meta 没有 env 字段，
        // 不替换的话 logger / daemon-client 等模块一加载就抛 "reading 'DEV'"。
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
      entryNames: 'probe-entry-[hash]',
      chunkNames: 'chunk-[hash]',
      assetNames: 'asset-[hash]',
      logLevel: 'warning',
      metafile: true,
    });

    const entryFile = Object.keys(buildResult.metafile.outputs)
      .find((file) => /probe-entry-.*\.js$/.test(file));
    if (!entryFile) {
      failInfra('esbuild 没有产出探针入口文件');
    }
    step(`打包完成：${path.basename(entryFile)}`);

    const samples = {};
    for (const windowMode of WINDOW_MODES) {
      samples[windowMode] = {};
      for (const probeMode of PROBE_MODES) {
        const htmlPath = path.join(tempDir, `index-${probeMode}-${windowMode}.html`);
        await writeFile(htmlPath, buildHtml({
          cssHref,
          neutralize: probeMode === BASELINE_MODE,
          bundleHref: `./${path.basename(entryFile)}`,
        }), 'utf8');

        const userDataDir = path.join(tempDir, `user-data-${probeMode}-${windowMode}`);
        fs.mkdirSync(userDataDir, { recursive: true });

        step(`运行 ${probeMode} / ${windowMode} …`);
        const outcome = await runProbe({ electronExe, probeMode, windowMode, htmlPath, userDataDir });
        samples[windowMode][probeMode] = outcome;

        if (outcome.result) {
          step(`  ${probeMode}/${windowMode} 读数（${outcome.elapsedMs}ms，rAF ${outcome.result.rafRateHz}Hz）：`);
          step(`    ${describeMeasurement('主目标', outcome.result.primary)}`);
          step(`    ${describeMeasurement('对照目标', outcome.result.literalEarliest)}`);
        } else {
          step(`  ${probeMode}/${windowMode} 失败：${JSON.stringify(outcome.failure)}`);
        }
      }
    }

    const neutralization = samples[WINDOW_MODES[0]]?.[BASELINE_MODE]?.result
      ? 'css-override(!important: content-visibility:visible; contain-intrinsic-size:none)'
      : 'none';
    const conclusion = buildConclusion({
      samples,
      neutralization,
      electronVersion,
      stylesheet: {
        source: path.relative(rootDir, stylesheet.sourcePath),
        built: stylesheet.builtDeclarations.map((entry) => entry.cssFile),
        declarations: stylesheet.sourceDeclarations,
      },
    });

    process.stdout.write(`CODEMUX_TRANSCRIPT_PROBE ${JSON.stringify(conclusion)}\n`);

    if (conclusion.residualWithSkip == null || conclusion.residualWithoutSkip == null) {
      const failures = [];
      for (const windowMode of WINDOW_MODES) {
        for (const probeMode of PROBE_MODES) {
          const failure = samples[windowMode]?.[probeMode]?.failure;
          if (failure) {
            failures.push({ windowMode, probeMode, failure });
          }
        }
      }
      process.stdout.write('CODEMUX_TRANSCRIPT_PROBE_FAILURE '
        + `${JSON.stringify({ kind: 'no-reading', message: '没有任何一组同时拿到两种状态的读数', failures })}\n`);
      exitCode = 2;
    }
  } finally {
    if (KEEP_TEMP) {
      step(`保留临时目录（CODEMUX_PROBE_KEEP_TEMP=1）：${tempDir}`);
    } else {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  process.exit(exitCode);
}

main().catch((error) => {
  const failure = error instanceof InfraFailure
    ? { kind: 'infra', message: error.message, ...error.extra }
    : { kind: 'runner', message: error && error.stack ? error.stack : String(error) };
  process.stdout.write(`CODEMUX_TRANSCRIPT_PROBE_FAILURE ${JSON.stringify(failure)}\n`);
  process.exit(2);
});
