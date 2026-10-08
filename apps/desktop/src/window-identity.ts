//! 窗口 → 进程身份(main 进程侧,工单 11)。
//!
//! 存在的原因:Electron 的 `desktopCapturer` 只给窗口标题,不给进程身份 —— 而
//! 「不可操作范围」不能只靠标题串匹配:宿主自己的窗口可能没有标题(自绘的无边框
//! 窗口、驱动面板、DevTools),标题也可能随手改。进程身份(pid / 父进程 / 映像名)
//! 是稳的那一半,由 PowerShell 枚举(`desktop-capture-host.ts` 里的脚本)提供,
//! 本文件只做**解析与拼接**的纯函数,便于 Node 契约测试。
//!
//! 注意:daemon 才是裁决者;壳只负责把事实(pid/父进程/映像名)报上去,不做二次
//! 判断(与 `desktop-capture.ts` 的隐私边界一致)。

/** 窗口矩形(系统坐标,与鼠标定位同一坐标系)。 */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 一个顶层窗口的进程身份。 */
export interface WindowIdentity {
  /** 窗口句柄(与 Electron 来源 id 的 `window:<hwnd>:<n>` 中段对应)。 */
  hwnd: number;
  processId: number;
  parentProcessId?: number;
  /** 进程映像名,如 `CodeMUX.exe` / `electron.exe` / `cua-driver.exe`。 */
  processName?: string;
  /** 窗口矩形:模型按截图定位点击时靠它换算坐标,不必自己猜缩放。 */
  bounds?: WindowBounds;
}

/** 拼进 payload 的身份字段(身份缺失时不带任何字段,daemon 按标题回退裁决)。 */
export interface WindowIdentityFields {
  /**
   * 窗口号(即 hwnd)——桌面输入工具(`computer_click` 等)的寻址字段。
   *
   * 与来源 id 里的 hwnd 是同一个值:模型在窗口清单里一次拿齐「截哪扇窗」
   * 与「点哪扇窗」,不必自己去解析来源 id。
   */
  windowId?: number;
  processId?: number;
  parentProcessId?: number;
  processName?: string;
}

function asPositiveInt(value: unknown): number | undefined {
  const numeric = asNumber(value);
  if (numeric === undefined || numeric <= 0) return undefined;
  return Math.trunc(numeric);
}

/** 矩形解析:四个分量都要有,宽高必须为正(否则当作没读到)。 */
function asBounds(record: Record<string, unknown>): WindowBounds | undefined {
  const x = asNumber(record.x);
  const y = asNumber(record.y);
  const width = asNumber(record.width);
  const height = asNumber(record.height);
  if (x === undefined || y === undefined) return undefined;
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;
  return {
    x: Math.trunc(x),
    y: Math.trunc(y),
    width: Math.trunc(width),
    height: Math.trunc(height),
  };
}

/** 数字读数:只接受数字与数字字符串 —— `null`/布尔不能被 `Number()` 悄悄变成 0。 */
function asNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

/**
 * 解析 PowerShell 枚举输出(数组或单个对象都接受);任何一条不合法就跳过。
 * 输出里 `-1`/`0` 这类伪 pid 一律丢弃 —— 宁缺勿错(错的身份会让 daemon 误放行)。
 */
export function parseWindowIdentities(raw: string): WindowIdentity[] {
  const text = raw.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const identities: WindowIdentity[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const hwnd = asPositiveInt(record.hwnd);
    const processId = asPositiveInt(record.processId);
    if (hwnd === undefined || processId === undefined) continue;
    const parentProcessId = asPositiveInt(record.parentProcessId);
    const processName =
      typeof record.processName === 'string' && record.processName.trim()
        ? record.processName.trim()
        : undefined;
    const bounds = asBounds(record);
    identities.push({
      hwnd,
      processId,
      ...(parentProcessId !== undefined ? { parentProcessId } : {}),
      ...(processName !== undefined ? { processName } : {}),
      ...(bounds !== undefined ? { bounds } : {}),
    });
  }
  return identities;
}

/**
 * 从 Electron 的窗口来源 id 里取窗口句柄。
 * 形如 `window:<hwnd>:<n>`;不是这个形状(屏幕来源、未知格式)返回 null。
 */
export function windowHandleFromSourceId(sourceId: string): number | null {
  const match = /^window:(\d+)(?::\d+)?$/.exec(sourceId.trim());
  if (!match) return null;
  const hwnd = Number(match[1]);
  return Number.isFinite(hwnd) && hwnd > 0 ? hwnd : null;
}

/** 按来源 id 查身份;查不到返回 undefined(daemon 会退回按标题裁决)。 */
export function identityOfSource(
  sourceId: string,
  identities: readonly WindowIdentity[],
): WindowIdentity | undefined {
  const hwnd = windowHandleFromSourceId(sourceId);
  if (hwnd === null) return undefined;
  return identities.find((identity) => identity.hwnd === hwnd);
}

/** 身份 → payload 字段(缺失的字段不出现,避免 `null` 被当成「已解析」)。 */
export function identityFields(identity: WindowIdentity | undefined): WindowIdentityFields {
  if (!identity) return {};
  return {
    windowId: identity.hwnd,
    processId: identity.processId,
    ...(identity.parentProcessId !== undefined
      ? { parentProcessId: identity.parentProcessId }
      : {}),
    ...(identity.processName !== undefined ? { processName: identity.processName } : {}),
  };
}

/**
 * 窗口清单条目里的矩形字段(键名 `bounds`)。
 *
 * 截图元数据里用 [`windowBoundsField`] —— 那里已有 `width`/`height`(图像像素),
 * 同一个 `bounds` 会把两套坐标系混在一起。
 */
export function boundsField(
  identity: WindowIdentity | undefined,
): { bounds?: WindowBounds } {
  return identity?.bounds ? { bounds: identity.bounds } : {};
}

/** 截图元数据里的窗口矩形(键名 `windowBounds`,与图像像素的 `width`/`height` 区分开)。 */
export function windowBoundsField(
  identity: WindowIdentity | undefined,
): { windowBounds?: WindowBounds } {
  return identity?.bounds ? { windowBounds: identity.bounds } : {};
}
