//! 桌面只读观测(工单 04)main 进程侧:窗口清单、截图、活动窗口。
//!
//! 与浏览器自动化共用同一条控制面接缝(daemon 下发 op,结果 POST 回去),
//! 但目标不是页面而是整个桌面 —— 因此本模块只读:不注入键鼠、不改窗口状态。
//!
//! 隐私边界:
//! - 只报来源名(窗口标题)与像素,不读取窗口内容文本;
//! - 密码管理器一类应用的窗口由 daemon 侧的拒绝列表拦在闸门外(见
//!   `computer_use::policy`),壳不做二次判断;
//! - 活动窗口在 Windows 上经 PowerShell 读前台窗口,失败即降级报错,
//!   不猜。
//!
//! 本文件不 import electron(依赖以最小结构接口注入),便于 Node(vitest)
//! 契约测试。

/** 桌面来源(屏或窗口)的可见信息。 */
export interface DesktopSourceInfo {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  displayId?: string;
  /** 窗口所属进程身份(工单 11):解不到就不带,daemon 退回按标题裁决。 */
  processId?: number;
  parentProcessId?: number;
  processName?: string;
}

/** 截图结果:base64 PNG + 尺寸 + 来源名与类型(daemon 据此判可操作范围)。 */
export interface DesktopScreenshot {
  image: string;
  width: number;
  height: number;
  name: string;
  sourceId: string;
  kind: 'screen' | 'window';
  /** 窗口截图时附带的来源进程身份(工单 11)。 */
  processId?: number;
  parentProcessId?: number;
  processName?: string;
  /** 整屏截图时附带的前台窗口标题与身份(daemon 据此拒绝受保护前台)。 */
  foregroundTitle?: string;
  foregroundProcessId?: number;
  foregroundParentProcessId?: number;
  foregroundProcessName?: string;
}

/** 活动窗口信息(前台窗口)。 */
export interface DesktopActiveWindow {
  title: string;
  processId?: number;
  parentProcessId?: number;
  processName?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  /** 能在来源清单里按标题对上的窗口 id(供随后截图用)。 */
  sourceId?: string;
}

/**
 * 整屏截图附带的前台窗口事实(标题 + 身份):受保护应用在前台时,daemon 据此
 * 拒绝整屏截图。读不到就不带(非 Windows / PowerShell 失败)。
 */
async function foregroundFacts(deps: DesktopCaptureDeps): Promise<{
  foregroundTitle?: string;
  foregroundProcessId?: number;
  foregroundParentProcessId?: number;
  foregroundProcessName?: string;
}> {
  if (!deps.readForegroundWindow) return {};
  try {
    const foreground = await deps.readForegroundWindow();
    if (!foreground?.title) return {};
    return {
      foregroundTitle: foreground.title,
      ...(foreground.processId !== undefined
        ? { foregroundProcessId: foreground.processId }
        : {}),
      ...(foreground.parentProcessId !== undefined
        ? { foregroundParentProcessId: foreground.parentProcessId }
        : {}),
      ...(foreground.processName ? { foregroundProcessName: foreground.processName } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * 窗口 → 进程身份(工单 11)。壳只把事实报给 daemon,自己不做裁决;
 * 平台不支持或枚举失败时返回空表 —— 身份未知时按标题裁决,不因此拒掉一切。
 */
async function windowIdentities(deps: DesktopCaptureDeps): Promise<WindowIdentity[]> {
  if (!deps.readWindowIdentities) return [];
  try {
    return await deps.readWindowIdentities();
  } catch {
    return [];
  }
}

interface CaptureThumbnail {
  toPNG(): Uint8Array;
  getSize(): { width: number; height: number };
}

interface CaptureSource {
  id: string;
  name: string;
  displayId?: string;
  thumbnail: CaptureThumbnail;
}

/** 注入面:main 进程传 Electron 的 desktopCapturer 与前台窗口读数。 */
export interface DesktopCaptureDeps {
  getSources(options: {
    types: Array<'screen' | 'window'>;
    thumbnailSize: { width: number; height: number };
  }): Promise<CaptureSource[]>;
  /** 主显示器(缺省来源)。 */
  primaryDisplay(): { id: number | string; size: { width: number; height: number } };
  /** 前台窗口读数;缺省表示平台不支持(工具据此报错而不是猜)。 */
  readForegroundWindow?: () => Promise<{
    title: string;
    processId?: number;
    parentProcessId?: number;
    processName?: string;
    bounds?: { x: number; y: number; width: number; height: number };
  } | null>;
  /** 顶层窗口的进程身份(工单 11);缺省表示平台不支持。 */
  readWindowIdentities?: () => Promise<WindowIdentity[]>;
}

/** 截图尺寸上限:避免一张 4K 截图把模型上下文撑爆。 */
const MAX_CAPTURE_EDGE = 1920;

import { identityFields, identityOfSource, type WindowIdentity } from './window-identity';

export type DesktopOpOutcome =
  | { ok: true; payload: unknown }
  | { ok: false; error: string };

function toSourceInfo(source: CaptureSource, kind: 'screen' | 'window'): DesktopSourceInfo {
  return {
    id: source.id,
    name: source.name,
    kind,
    ...(source.displayId ? { displayId: source.displayId } : {}),
  };
}

/**
 * 窗口清单:不取缩略图(thumbnailSize 0),避免为一次列举编码整屏位图。
 * 窗口条目带上进程身份(来源 id 里的窗口句柄 ↔ PowerShell 枚举的句柄)。
 */
export async function listDesktopSources(deps: DesktopCaptureDeps): Promise<DesktopSourceInfo[]> {
  const [screens, windows, identities] = await Promise.all([
    deps.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }),
    deps.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }),
    windowIdentities(deps),
  ]);
  return [
    ...screens.map((source) => toSourceInfo(source, 'screen')),
    ...windows.map((source) => ({
      ...toSourceInfo(source, 'window'),
      ...identityFields(identityOfSource(source.id, identities)),
    })),
  ];
}

function thumbnailSizeFor(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= MAX_CAPTURE_EDGE) return { width, height };
  const scale = MAX_CAPTURE_EDGE / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * 截图:按 `sourceId` 指定来源;缺省截主屏。
 *
 * `screenOnly`(来源缺失时的兜底)始终只截主屏 —— 不猜窗口,截错窗口比截不到
 * 更糟(可能是密码管理器)。
 */
export async function captureDesktop(
  deps: DesktopCaptureDeps,
  params: { sourceId?: unknown },
): Promise<DesktopOpOutcome> {
  const requested = typeof params.sourceId === 'string' ? params.sourceId : '';
  const primary = deps.primaryDisplay();
  const primaryDisplayId = String(primary.id);
  const size = thumbnailSizeFor(primary.size.width, primary.size.height);
  const screens = await deps.getSources({ types: ['screen'], thumbnailSize: size });

  let source: CaptureSource | undefined;
  let windowsSource = false;
  if (requested) {
    const windows = await deps.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
    source = [...screens, ...windows].find((item) => item.id === requested);
    if (!source) {
      return { ok: false, error: `找不到来源 ${requested}(先用 computer_windows 取最新清单)` };
    }
    windowsSource = windows.some((item) => item.id === requested);
    if (windowsSource) {
      // 窗口源要重新按尺寸取一次缩略图才能截到内容。
      const windowsWithThumb = await deps.getSources({ types: ['window'], thumbnailSize: size });
      source = windowsWithThumb.find((item) => item.id === requested) ?? source;
    }
  } else {
    source = screens.find((item) => item.displayId === primaryDisplayId) ?? screens[0];
  }

  if (!source) {
    return { ok: false, error: '桌面上没有可截取的来源(壳未拿到屏幕捕获权限?)' };
  }
  const png = source.thumbnail.toPNG();
  if (!png || png.length === 0) {
    return { ok: false, error: `来源 ${source.name} 截图为空(窗口可能已关闭或最小化)` };
  }
  const actual = source.thumbnail.getSize();
  const isWindow = windowsSource;
  // 窗口截图带上来源进程身份:daemon 据此按身份拒绝(标题可以没有,身份不会)。
  const identity = isWindow
    ? identityOfSource(source.id, await windowIdentities(deps))
    : undefined;
  const screenshot: DesktopScreenshot = {
    image: Buffer.from(png).toString('base64'),
    width: actual.width,
    height: actual.height,
    name: source.name,
    sourceId: source.id,
    // 来源类型取自它出自哪张清单 —— 不用 display_id 推断(Electron 不保证
    // 窗口源没有 display_id,推断错会让受保护窗口绕过筛查)。
    kind: isWindow ? 'window' : 'screen',
    // 整屏截图时附上前台窗口的标题与身份:受保护应用在前台时,daemon 据此拒绝
    // 整屏截图(密码管理器/宿主自己的窗口不该被整屏拍进去)。
    ...(isWindow ? identityFields(identity) : await foregroundFacts(deps)),
  };
  return { ok: true, payload: screenshot };
}

/**
 * 活动窗口:前台窗口的标题/进程/位置,并尽量对上可截图的来源 id。
 *
 * 平台不支持(非 Windows 或 PowerShell 不可用)时返回错误 —— 读不到就说
 * 读不到,不拿「最近打开的窗口」冒充前台窗口。
 */
export async function activeDesktopWindow(deps: DesktopCaptureDeps): Promise<DesktopOpOutcome> {
  if (!deps.readForegroundWindow) {
    return { ok: false, error: '活动窗口读取需要 Windows 桌面环境' };
  }
  let foreground: Awaited<ReturnType<NonNullable<DesktopCaptureDeps['readForegroundWindow']>>>;
  try {
    foreground = await deps.readForegroundWindow();
  } catch (error) {
    return {
      ok: false,
      error: `读取活动窗口失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!foreground || !foreground.title) {
    return { ok: false, error: '没有可读的前台窗口(桌面被锁屏或前台窗口无标题)' };
  }

  const windows = await deps.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
  const match = windows.find((item) => item.name === foreground.title);
  const payload: DesktopActiveWindow = {
    title: foreground.title,
    ...(foreground.processId !== undefined ? { processId: foreground.processId } : {}),
    ...(foreground.parentProcessId !== undefined
      ? { parentProcessId: foreground.parentProcessId }
      : {}),
    ...(foreground.processName ? { processName: foreground.processName } : {}),
    ...(foreground.bounds ? { bounds: foreground.bounds } : {}),
    ...(match ? { sourceId: match.id } : {}),
  };
  return { ok: true, payload };
}
