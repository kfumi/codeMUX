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

/** 一个顶层窗口的进程身份。 */
export interface WindowIdentity {
  /** 窗口句柄(与 Electron 来源 id 的 `window:<hwnd>:<n>` 中段对应)。 */
  hwnd: number;
  processId: number;
  parentProcessId?: number;
  /** 进程映像名,如 `CodeMUX.exe` / `electron.exe` / `cua-driver.exe`。 */
  processName?: string;
}

/** 拼进 payload 的身份字段(身份缺失时不带任何字段,daemon 按标题回退裁决)。 */
export interface WindowIdentityFields {
  processId?: number;
  parentProcessId?: number;
  processName?: string;
}

function asPositiveInt(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.trunc(numeric);
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
    identities.push({
      hwnd,
      processId,
      ...(parentProcessId !== undefined ? { parentProcessId } : {}),
      ...(processName !== undefined ? { processName } : {}),
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
    processId: identity.processId,
    ...(identity.parentProcessId !== undefined
      ? { parentProcessId: identity.parentProcessId }
      : {}),
    ...(identity.processName !== undefined ? { processName: identity.processName } : {}),
  };
}
