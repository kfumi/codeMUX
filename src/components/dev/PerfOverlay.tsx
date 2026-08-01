import { Gauge } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
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
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
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
      const win = getCurrentWebviewWindow();
      await invoke('plugin:webview|internal_toggle_devtools', { label: win.label });
    } catch (error) {
      console.warn('[PerfOverlay] open devtools failed:', error);
    }
  }, []);

  const openConsole = useCallback(async () => {
    try {
      const info = await invoke<{ enabled: boolean; addr: string }>('get_tokio_console_info');
      if (info.enabled) {
        await navigator.clipboard.writeText(info.addr);
        toast.success(`已复制 tokio-console gRPC 地址：${info.addr}（浏览器打不开，请在终端运行 \`tokio-console\`）`);
      } else {
        toast.info('tokio-console 未启用，请运行: $env:RUSTFLAGS="--cfg tokio_unstable"; npm run tauri dev -- --features tokio-console');
      }
    } catch {
      toast.error('获取 tokio-console 信息失败');
    }
  }, []);

  const exportSnapshot = useCallback(async () => {
    try {
      const snap = usePerfStore.getState().snapshot();
      const filePath = await save({
        defaultPath: `codemux-perf-${Date.now()}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!filePath) {
        toast.info('已取消');
        return;
      }
      await invoke('export_perf_snapshot', { path: filePath, content: JSON.stringify(snap, null, 2) });
      toast.success('快照已保存');
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
      <PerfRow label="内存 (MB)" value={memoryMb !== null ? memoryMb.toFixed(1) : 'N/A'} />
      <PerfRow label="IPC/秒" value={String(ipcRate)} />

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
        <button onClick={openConsole}>Console</button>
        <button onClick={exportSnapshot}>快照</button>
      </div>
    </div>
  );
}
