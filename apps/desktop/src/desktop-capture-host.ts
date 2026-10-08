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
import { parseWindowIdentities, type WindowIdentity } from './window-identity';

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
$parentId = 0
$procName = $null
try {
  $info = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop
  if ($info) { $parentId = [int]$info.ParentProcessId; $procName = $info.Name }
} catch { }
[pscustomobject]@{ title = $sb.ToString(); processId = $procId; parentProcessId = $parentId; processName = $procName; x = $r.Left; y = $r.Top; width = $r.Right - $r.Left; height = $r.Bottom - $r.Top } | ConvertTo-Json -Compress`;

/**
 * 顶层窗口 → 进程身份(工单 11)。一次调用枚举全部句柄,然后**一次性**取
 * Win32_Process 快照(逐窗口查 CIM 会慢一个数量级)。失败返回空行,调用方按
 * 「身份未知」处理(daemon 退回按标题裁决,不会因此拒掉一切)。
 */
const WINDOW_IDENTITY_SCRIPT = `Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public struct CxIdRect { public int Left, Top, Right, Bottom; }
public class CxEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out CxIdRect rect);
  public static List<IntPtr> TopLevel() {
    List<IntPtr> handles = new List<IntPtr>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) { handles.Add(hWnd); return true; }, IntPtr.Zero);
    return handles;
  }
}
"@
$procs = @{}
try {
  Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { $procs[[int]$_.ProcessId] = $_ }
} catch { }
$rows = foreach ($h in [CxEnum]::TopLevel()) {
  $ownerPid = 0
  [void][CxEnum]::GetWindowThreadProcessId($h, [ref]$ownerPid)
  if ($ownerPid -eq 0) { continue }
  $parent = 0
  $name = $null
  if ($procs.ContainsKey([int]$ownerPid)) {
    $parent = [int]$procs[[int]$ownerPid].ParentProcessId
    $name = $procs[[int]$ownerPid].Name
  }
  $rect = New-Object CxIdRect
  [void][CxEnum]::GetWindowRect($h, [ref]$rect)
  [pscustomobject]@{ hwnd = [int64]$h; processId = [int]$ownerPid; parentProcessId = $parent; processName = $name; x = $rect.Left; y = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top }
}
@($rows) | ConvertTo-Json -Compress`;


interface ForegroundWindowJson {
  title?: unknown;
  processId?: unknown;
  parentProcessId?: unknown;
  processName?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asIdentityPart(value: unknown): number | undefined {
  const numeric = asNumber(value);
  return numeric !== undefined && numeric > 0 ? Math.trunc(numeric) : undefined;
}

/** PowerShell 输出解析(纯函数,便于单测)。 */
export function parseForegroundWindow(raw: string): {
  title: string;
  processId?: number;
  parentProcessId?: number;
  processName?: string;
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
  const processId = asIdentityPart(parsed.processId);
  const parentProcessId = asIdentityPart(parsed.parentProcessId);
  const processName =
    typeof parsed.processName === 'string' && parsed.processName.trim()
      ? parsed.processName.trim()
      : undefined;
  return {
    title: parsed.title,
    ...(processId !== undefined ? { processId } : {}),
    ...(parentProcessId !== undefined ? { parentProcessId } : {}),
    ...(processName !== undefined ? { processName } : {}),
    ...(x !== undefined && y !== undefined && width !== undefined && height !== undefined
      ? { bounds: { x, y, width, height } }
      : {}),
  };
}

async function readForegroundWindow(): Promise<{
  title: string;
  processId?: number;
  parentProcessId?: number;
  processName?: string;
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

/** 顶层窗口 → 进程身份;平台不支持或读取失败时返回空表(身份未知)。 */
export async function readWindowIdentities(): Promise<WindowIdentity[]> {
  if (process.platform !== 'win32') return [];
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOW_IDENTITY_SCRIPT],
      { timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    return parseWindowIdentities(stdout);
  } catch {
    return [];
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
    readWindowIdentities,
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
