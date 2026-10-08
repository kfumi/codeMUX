//! 桌面只读观测的 Electron 适配层(工单 04):把 desktopCapturer / screen /
//! 前台窗口读数接到 `desktop-capture` 的注入面上。
//!
//! 单独成文件的原因:`desktop-capture.ts` 要在 Node 里做纯契约测试,不能
//! import electron;electron 相关的活全在这里。
//!
//! 前台窗口在 Windows 上经 PowerShell 走 user32(GetForegroundWindow +
//! GetWindowText + GetWindowRect)。首次调用要编译内联 C#,通常 1 秒内;
//! 超时或输出无法解析即返回 null(调用方报「读不到」而不是猜)。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { desktopCapturer, screen } from 'electron';

import type { DesktopCaptureDeps } from './desktop-capture';

const execFileAsync = promisify(execFile);

const FOREGROUND_WINDOW_SCRIPT = `Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public struct CxRect { public int Left, Top, Right, Bottom; }
public class CxWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out CxRect r);
}
"@
$h = [CxWin]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][CxWin]::GetWindowText($h, $sb, 512)
$procId = 0
[void][CxWin]::GetWindowThreadProcessId($h, [ref]$procId)
$r = New-Object CxRect
[void][CxWin]::GetWindowRect($h, [ref]$r)
[pscustomobject]@{ title = $sb.ToString(); processId = $procId; x = $r.Left; y = $r.Top; width = $r.Right - $r.Left; height = $r.Bottom - $r.Top } | ConvertTo-Json -Compress`;

interface ForegroundWindowJson {
  title?: unknown;
  processId?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** PowerShell 输出解析(纯函数,便于单测)。 */
export function parseForegroundWindow(raw: string): {
  title: string;
  processId?: number;
  bounds?: { x: number; y: number; width: number; height: number };
} | null {
  let parsed: ForegroundWindowJson;
  try {
    parsed = JSON.parse(raw.trim()) as ForegroundWindowJson;
  } catch {
    return null;
  }
  if (typeof parsed.title !== 'string') return null;
  const x = asNumber(parsed.x);
  const y = asNumber(parsed.y);
  const width = asNumber(parsed.width);
  const height = asNumber(parsed.height);
  const processId = asNumber(parsed.processId);
  return {
    title: parsed.title,
    ...(processId !== undefined ? { processId } : {}),
    ...(x !== undefined && y !== undefined && width !== undefined && height !== undefined
      ? { bounds: { x, y, width, height } }
      : {}),
  };
}

async function readForegroundWindow(): Promise<{
  title: string;
  processId?: number;
  bounds?: { x: number; y: number; width: number; height: number };
} | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', FOREGROUND_WINDOW_SCRIPT],
      { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    return parseForegroundWindow(stdout);
  } catch {
    return null;
  }
}

export function createDesktopCaptureHost(): DesktopCaptureDeps {
  return {
    getSources: async (options) => {
      const sources = await desktopCapturer.getSources({
        types: options.types,
        thumbnailSize: options.thumbnailSize,
      });
      return sources.map((source) => ({
        id: source.id,
        name: source.name,
        displayId: source.display_id || undefined,
        thumbnail: {
          toPNG: () => source.thumbnail.toPNG(),
          getSize: () => source.thumbnail.getSize(),
        },
      }));
    },
    primaryDisplay: () => {
      const display = screen.getPrimaryDisplay();
      return { id: display.id, size: display.size };
    },
    readForegroundWindow,
  };
}

/** 手动贴屏(需求 17):用户点一下截主屏,返回 base64 PNG。 */
export async function capturePrimaryScreen(): Promise<{ image: string; width: number; height: number }> {
  const display = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: display.size,
  });
  const primary = sources.find((source) => source.display_id === String(display.id)) ?? sources[0];
  if (!primary) {
    throw new Error('没有可截取的屏幕来源');
  }
  const image = primary.thumbnail;
  const size = image.getSize();
  return {
    image: image.toPNG().toString('base64'),
    width: size.width,
    height: size.height,
  };
}
