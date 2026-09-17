import { Gauge } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { saveDialog } from '../../lib/desktopDialogs';
import { shellFacade } from '../../lib/facades/shell-facade';
import {
  installLayoutFlickerProbe,
  type LayoutProbeResult,
} from '../../lib/dev/layoutFlickerProbe';
import { readAndResetSmoothness, type SmoothnessSnapshot } from '../../lib/streamSmoothness';
import { usePerfStore } from '../../stores/perfStore';
import { TooltipHint } from '../ui/tooltip';
import './PerfOverlay.css';

const STORAGE_KEY = 'codemux.perfOverlay';
const FPS_BAD_THRESHOLD = 30;

interface StoredPosition {
  x: number;
  y: number;
  collapsed: boolean;
}

function loadStored(): StoredPosition {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { x: -1, y: -1, collapsed: false };
    const parsed = JSON.parse(raw) as Partial<StoredPosition>;
    return {
      x: typeof parsed.x === 'number' ? parsed.x : -1,
      y: typeof parsed.y === 'number' ? parsed.y : -1,
      collapsed: Boolean(parsed.collapsed),
    };
  } catch {
    return { x: -1, y: -1, collapsed: false };
  }
}

function PerfRow({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className={`perf-overlay__row${bad ? ' perf-overlay__row--bad' : ''}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function PerfOverlay() {
  const [pos, setPos] = useState<StoredPosition>(() => loadStored());
  const dragging = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const [isLight, setIsLight] = useState(false);

  const fps = usePerfStore((s) => s.fps);
  const memoryMb = usePerfStore((s) => s.memoryMb);
  const ipcRate = usePerfStore((s) => s.ipcTimestamps.length);
  const slowIpc = usePerfStore((s) => s.slowIpcSamples);
  const renderAggregates = usePerfStore((s) => s.renderAggregates);
  const topRenders = useMemo(
    () => Object.values(renderAggregates).sort((a, b) => b.commitCount - a.commitCount).slice(0, 5),
    [renderAggregates],
  );
  const slowThresholdMs = usePerfStore((s) => s.slowThresholdMs);
  // Long-task totals for the last sampling window. This answers the question
  // the FPS number alone cannot: a low FPS caused by the main thread actually
  // blocking shows up here, while a low FPS caused by the browser throttling a
  // window it considers backgrounded does not. Reading those two apart matters
  // — otherwise a throttle artifact reads as a renderer performance problem.
  const [longTasks, setLongTasks] = useState({ count: 0, maxMs: 0, totalMs: 0 });
  // 流式平滑度。单独一行是因为 FPS 与长任务都看不出"手感"：一个完全停顿的流
  // 是完美平滑的（变异系数为 0），所以必须同时显示"推进帧占比"与"更新间隔 p95"。
  const [smoothness, setSmoothness] = useState<SmoothnessSnapshot | null>(null);
  // 系统级"减少动效"会让 `DotMatrix`（`motion-reduce:[animation-name:none]`）与
  // `RunningElapsedTimer` 的 `.shimmer`（`motion-reduce:animate-none`）被**显式**
  // 关掉，表现为"所有 loading 动效一起失效"。把它显出来，这类症状就不必再靠猜。
  const [reduceMotion, setReduceMotion] = useState(false);
  // 布局闪动诊断：装上即**常驻**记录（只在数值变化时记账），这样"滚动条占位
  // 10→0 的那一瞬"不会因为采样起点在点击之后而被漏掉；再点一次即导出并停止。
  const [layoutProbeOn, setLayoutProbeOn] = useState(false);
  const [layoutProbeResult, setLayoutProbeResult] = useState<LayoutProbeResult | null>(null);
  const layoutProbeRef = useRef<{ uninstall: () => void; dump: () => LayoutProbeResult } | null>(null);

  useEffect(() => () => layoutProbeRef.current?.uninstall(), []);

  const toggleLayoutProbe = useCallback(() => {
    if (layoutProbeRef.current) {
      // 导出并停止。
      const result = layoutProbeRef.current.dump();
      layoutProbeRef.current.uninstall();
      layoutProbeRef.current = null;
      setLayoutProbeResult(result);
      setLayoutProbeOn(false);
      return;
    }
    setLayoutProbeResult(null);
    layoutProbeRef.current = installLayoutFlickerProbe();
    setLayoutProbeOn(true);
  }, []);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    setReduceMotion(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduceMotion(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const update = () => setIsLight(!root.classList.contains('dark'));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // FPS + memory sampling loop
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    const setFps = usePerfStore.getState().setFps;
    const setMemoryMb = usePerfStore.getState().setMemoryMb;

    // longtask is Chromium-only; where it is missing the row stays at zero and
    // simply carries no signal.
    let taskCount = 0;
    let taskMaxMs = 0;
    let taskTotalMs = 0;
    let longTaskObserver: PerformanceObserver | null = null;
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            taskCount += 1;
            taskTotalMs += entry.duration;
            if (entry.duration > taskMaxMs) {
              taskMaxMs = entry.duration;
            }
          }
        });
        longTaskObserver.observe({ entryTypes: ['longtask'] });
      } catch {
        longTaskObserver = null;
      }
    }

    const tick = () => {
      frames++;
      const now = performance.now();
      if (now - last >= 1000) {
        setFps(Math.round((frames * 1000) / (now - last)));
        frames = 0;
        last = now;
        const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
        setMemoryMb(mem?.usedJSHeapSize ? mem.usedJSHeapSize / 1048576 : null);
        usePerfStore.getState().pruneIpc();
        setLongTasks({
          count: taskCount,
          maxMs: Math.round(taskMaxMs),
          totalMs: Math.round(taskTotalMs),
        });
        taskCount = 0;
        taskMaxMs = 0;
        taskTotalMs = 0;
        const smooth = readAndResetSmoothness(now);
        // 非流式期间采样数为 0 —— 保留上一次读数，避免数字每秒闪成 0。
        if (smooth.sampledFrames > 0) {
          setSmoothness(smooth);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      longTaskObserver?.disconnect();
    };
  }, []);

  const persist = useCallback((next: StoredPosition) => {
    setPos(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, select')) return;
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    dragging.current = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const x = e.clientX - dragging.current.offsetX;
    const y = e.clientY - dragging.current.offsetY;
    persist({ ...pos, x, y });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragging.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  };

  const toggleCollapsed = () => persist({ ...pos, collapsed: !pos.collapsed });

  const openDevtools = useCallback(async () => {
    try {
      // 工单 05:平台分流 —— Electron 走 webContents.toggleDevTools,Tauri 走原命令。
      await shellFacade.toggleDevtools();
    } catch (error) {
      console.warn('[PerfOverlay] open devtools failed:', error);
    }
  }, []);

  const exportSnapshot = useCallback(async () => {
    try {
      const snap = usePerfStore.getState().snapshot();
      const filePath = await saveDialog({
        defaultPath: `codemux-perf-${Date.now()}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!filePath) {
        toast.info('已取消');
        return;
      }
      // 工单 05:平台分流 —— Electron 由主进程写文件;Tauri 走原命令。
      await shellFacade.exportPerfSnapshot(filePath, JSON.stringify(snap, null, 2));      toast.success('快照已保存');
    } catch {
      toast.error('保存失败');
    }
  }, []);

  const left = pos.x >= 0 ? pos.x : undefined;
  const top = pos.y >= 0 ? pos.y : undefined;
  const style: React.CSSProperties = left !== undefined ? { left, top, right: 'auto' } : {};

  if (pos.collapsed) {
    return (
      <div className={`perf-overlay is-${isLight ? 'light' : 'dark'}`} style={style}>
        <button className="perf-overlay__collapsed" onClick={toggleCollapsed}>
          <Gauge size={12} /> Perf
        </button>
      </div>
    );
  }

  const slowTop5 = [...slowIpc].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);

  return (
    <div className={`perf-overlay is-${isLight ? 'light' : 'dark'}`} style={style}>
      <div className="perf-overlay__header" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        <span>Performance</span>
        <TooltipHint content="折叠">
          <button className="perf-overlay__toggle" onClick={toggleCollapsed} aria-label="折叠">–</button>
        </TooltipHint>
      </div>
      <PerfRow label="FPS" value={String(fps)} bad={fps > 0 && fps < FPS_BAD_THRESHOLD} />
      <PerfRow
        label="长任务/秒"
        value={
          longTasks.count === 0
            ? '无'
            : `${longTasks.count} · 最长 ${longTasks.maxMs}ms · 共 ${longTasks.totalMs}ms`
        }
        bad={longTasks.totalMs >= 200}
      />
      <PerfRow label="内存 (MB)" value={memoryMb !== null ? memoryMb.toFixed(1) : 'N/A'} />
      <PerfRow label="IPC/秒" value={String(ipcRate)} />
      {reduceMotion ? <PerfRow label="系统动效" value="已被系统关闭" bad /> : null}
      {layoutProbeResult ? (
        <PerfRow
          label="闪动诊断"
          value={`视口宽 ${layoutProbeResult.viewportWidths.length} 种 · 占位 ${JSON.stringify(layoutProbeResult.scrollbarSpaces)} · 元素 ${layoutProbeResult.elementSwaps} 个`}
          bad={layoutProbeResult.scrollbarSpaces.length > 1 || layoutProbeResult.elementSwaps > 1}
        />
      ) : null}
      <PerfRow
        label="流式平滑度"
        value={smoothness
          ? `CV ${smoothness.charsPerUpdateCv.toFixed(2)} · ${smoothness.updatesPerSecond.toFixed(1)} 次/秒`
          : '无'}
        bad={Boolean(smoothness && (smoothness.charsPerUpdateCv > 2 || smoothness.updatesPerSecond < 4))}
      />
      <PerfRow
        label="更新间隔 p50/p95"
        value={smoothness
          ? `${Math.round(smoothness.updateIntervalP50)}ms / ${Math.round(smoothness.updateIntervalP95)}ms`
          : '无'}
        bad={Boolean(smoothness && smoothness.updateIntervalP95 > 120)}
      />

      <div style={{ marginTop: 4, opacity: 0.8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>慢 IPC Top-5 (&gt;</span>
        <select
          value={slowThresholdMs}
          onChange={(e) => usePerfStore.getState().setSlowThresholdMs(Number(e.target.value))}
          style={{ background: 'transparent', color: 'inherit', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 3, fontSize: 10 }}
        >
          <option value={10}>10ms</option>
          <option value={50}>50ms</option>
          <option value={100}>100ms</option>
          <option value={250}>250ms</option>
        </select>
        <span>)</span>
      </div>
      <ul className="perf-overlay__list">
        {slowTop5.length === 0 ? (
          <li style={{ opacity: 0.5 }}>无</li>
        ) : (
          slowTop5.map((s, i) => (
            <li key={`${s.command}-${i}`}>
              <TooltipHint content={s.command}>
                <span>{s.command}</span>
              </TooltipHint>
              <span>{s.durationMs.toFixed(0)}ms</span>
            </li>
          ))
        )}
      </ul>

      <div style={{ marginTop: 4, opacity: 0.8 }}>Re-render Top-5</div>
      <ul className="perf-overlay__list">
        {topRenders.length === 0 ? (
          <li style={{ opacity: 0.5 }}>无</li>
        ) : (
          topRenders.map((r) => (
            <li key={r.id}>
              <TooltipHint content={r.id}>
                <span>{r.id}</span>
              </TooltipHint>
              <span>{r.commitCount}× / {r.totalMs.toFixed(0)}ms</span>
            </li>
          ))
        )}
      </ul>

      <div className="perf-overlay__actions">
        <button onClick={openDevtools}>DevTools</button>
        <button onClick={exportSnapshot}>快照</button>
        <button onClick={toggleLayoutProbe}>
          {layoutProbeOn ? '导出闪动记录' : '开始闪动记录'}
        </button>
      </div>
    </div>
  );
}
