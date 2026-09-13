/**
 * 回环浏览器简化配对客户端(工单 02,用户故事 3)。
 *
 * 流程:浏览器(loopback)申请配对 → daemon 把请求推给桌面壳/CLI 呈现一次确认
 * → 浏览器轮询拿到 Pairing Token。浏览器全程不接触 Local Daemon Token。
 */

export interface LocalPairingStart {
  requestId: string;
  code: string;
  name: string;
  desktopId: string;
  expiresAt: string;
}

export type LocalPairingPhase = 'pending' | 'approved' | 'denied' | 'expired';

export interface LocalPairingStatus {
  requestId: string;
  status: LocalPairingPhase;
  desktopId: string;
  token: string | null;
  deviceId: string | null;
  expiresAt: string;
}

export type LocalPairingFailure = 'denied' | 'expired' | 'timeout' | 'request-failed';

export class LocalPairingError extends Error {
  readonly reason: LocalPairingFailure;

  constructor(reason: LocalPairingFailure, message: string) {
    super(message);
    this.name = 'LocalPairingError';
    this.reason = reason;
  }
}

const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 180_000;

function pairUrl(origin: string, path: string): string {
  return `${origin.replace(/\/$/, '')}${path}`;
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text.trim()) return `请求失败(${response.status})`;
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error;
  } catch {
    // 非 JSON 错误体:原样返回文本
  }
  return text;
}

export async function requestLocalPairing(
  origin: string,
  name?: string,
): Promise<LocalPairingStart> {
  let response: Response;
  try {
    response = await fetch(pairUrl(origin, '/api/pair/local/request'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
      cache: 'no-store',
    });
  } catch (error) {
    throw new LocalPairingError('request-failed', String(error));
  }
  if (!response.ok) {
    throw new LocalPairingError('request-failed', await readErrorMessage(response));
  }
  return response.json() as Promise<LocalPairingStart>;
}

export async function fetchLocalPairingStatus(
  origin: string,
  requestId: string,
): Promise<LocalPairingStatus> {
  let response: Response;
  try {
    response = await fetch(
      pairUrl(origin, `/api/pair/local/request/${encodeURIComponent(requestId)}`),
      { cache: 'no-store' },
    );
  } catch (error) {
    throw new LocalPairingError('request-failed', String(error));
  }
  if (response.status === 404) {
    throw new LocalPairingError('expired', '配对请求已失效，请重新发起');
  }
  if (!response.ok) {
    throw new LocalPairingError('request-failed', await readErrorMessage(response));
  }
  return response.json() as Promise<LocalPairingStatus>;
}

export interface AwaitLocalPairingOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onPhase?: (status: LocalPairingStatus) => void;
}

/**
 * 轮询直到确认方给出结果。拒绝/过期/超时都以 [`LocalPairingError`] 结束,
 * 调用方据此回到「重新发起配对」的界面状态。
 */
export async function awaitLocalPairingApproval(
  origin: string,
  requestId: string,
  options: AwaitLocalPairingOptions = {},
): Promise<{ token: string; deviceId: string; desktopId: string }> {
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  for (;;) {
    if (options.signal?.aborted) {
      throw new LocalPairingError('timeout', '配对已取消');
    }
    const status = await fetchLocalPairingStatus(origin, requestId);
    options.onPhase?.(status);
    if (status.status === 'approved' && status.token) {
      return {
        token: status.token,
        deviceId: status.deviceId ?? '',
        desktopId: status.desktopId,
      };
    }
    if (status.status === 'denied') {
      throw new LocalPairingError('denied', '桌面端拒绝了本次配对');
    }
    if (status.status === 'expired') {
      throw new LocalPairingError('expired', '配对请求已过期，请重新发起');
    }
    if (Date.now() >= deadline) {
      throw new LocalPairingError('timeout', '等待确认超时，请重新发起配对');
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, interval);
      options.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
