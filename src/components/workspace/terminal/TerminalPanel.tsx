import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';

import { terminalApi, type TerminalEvent } from '../../../lib/tauri';
import { useSidePanelStore } from '../../../stores/sidePanelStore';
import { useSettingsStore } from '../../../stores/settingsStore';

function terminalTheme() {
  const isDark = document.documentElement.classList.contains('dark');

  return isDark
    ? {
      background: '#111111',
      foreground: '#e5e7eb',
      cursor: '#f8fafc',
      selectionBackground: '#334155',
      black: '#0f172a',
      red: '#f87171',
      green: '#86efac',
      yellow: '#fde047',
      blue: '#93c5fd',
      magenta: '#d8b4fe',
      cyan: '#67e8f9',
      white: '#e5e7eb',
      brightBlack: '#64748b',
      brightRed: '#fca5a5',
      brightGreen: '#bbf7d0',
      brightYellow: '#fef08a',
      brightBlue: '#bfdbfe',
      brightMagenta: '#e9d5ff',
      brightCyan: '#a5f3fc',
      brightWhite: '#ffffff',
    }
    : {
      background: '#ffffff',
      foreground: '#1f2937',
      cursor: '#475569',
      selectionBackground: '#d4d4d8',
    };
}

export function TerminalPanel({ tabId, projectPath }: { tabId: string; projectPath: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const setTerminalId = useSidePanelStore((state) => state.setTerminalId);
  const theme = useSettingsStore((state) => state.config?.theme);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = terminalTheme();
    }
  }, [theme]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !projectPath) return;

    const terminal = new XTerm({
      cursorBlink: true,
      fontFamily: 'Consolas, "JetBrains Mono", monospace',
      fontSize: 13,
      lineHeight: 1.35,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    fit.fit();
    terminalRef.current = terminal;
    fitRef.current = fit;

    let disposed = false;
    const handleEvent = (event: TerminalEvent) => {
      if (disposed) return;
      if (event.type === 'output') {
        terminal.write(event.data);
      } else if (event.type === 'error') {
        setError(event.error);
      } else if (event.type === 'exit') {
        terminal.writeln('');
        terminal.writeln(`[进程已退出${event.code == null ? '' : `: ${event.code}`}]`);
      }
    };

    terminalApi.start(projectPath, terminal.cols || 100, terminal.rows || 30, handleEvent)
      .then((terminalId) => {
        if (disposed) {
          void terminalApi.close(terminalId);
          return;
        }
        terminalIdRef.current = terminalId;
        setTerminalId(tabId, terminalId);
      })
      .catch((err) => setError(String(err)));

    const dataDisposable = terminal.onData((data) => {
      const terminalId = terminalIdRef.current;
      if (terminalId) void terminalApi.write(terminalId, data);
    });

    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      const terminalId = terminalIdRef.current;
      if (terminalId) void terminalApi.resize(terminalId, terminal.cols, terminal.rows);
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      dataDisposable.dispose();
      resizeObserver.disconnect();
      const terminalId = terminalIdRef.current;
      if (terminalId) void terminalApi.close(terminalId);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      terminalIdRef.current = null;
    };
  }, [projectPath, setTerminalId, tabId]);

  return (
    <div className="relative h-full bg-white dark:bg-[#111111]">
      <div ref={containerRef} className="h-full w-full overflow-hidden p-3" />
      {error && (
        <div className="absolute inset-x-4 top-4 rounded-lg border border-destructive/30 bg-background/95 px-3 py-2 text-sm text-destructive shadow-sm">
          {error}
        </div>
      )}
    </div>
  );
}
