/**
 * 桌面壳侧的配对请求解析(工单 02)。
 *
 * daemon 把同机浏览器的配对申请作为 UI 事件(`web-pairing-request`)经控制面
 * WS 推给壳,壳再 `webContents.send` 给渲染层;渲染层用本模块解析载荷并弹出
 * 一次确认(用户故事 3:不由用户手工复制 token)。
 */

export interface WebPairingRequest {
  requestId: string;
  code: string;
  name: string;
  expiresAt: string;
  desktopId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWebPairingRequest(payload: unknown): WebPairingRequest | null {
  if (!isRecord(payload)) return null;
  const { requestId, code, name, expiresAt, desktopId } = payload;
  if (typeof requestId !== 'string' || !requestId.trim()) return null;
  if (typeof code !== 'string' || !code.trim()) return null;
  return {
    requestId: requestId.trim(),
    code: code.trim(),
    name: typeof name === 'string' && name.trim() ? name.trim() : '浏览器',
    expiresAt: typeof expiresAt === 'string' ? expiresAt : '',
    desktopId: typeof desktopId === 'string' ? desktopId : '',
  };
}

/** 确认请求是否仍在有效窗口内(过期请求不再打扰用户)。 */
export function isWebPairingRequestFresh(request: WebPairingRequest, now = Date.now()): boolean {
  if (!request.expiresAt) return true;
  const expiresAt = Date.parse(request.expiresAt);
  return Number.isFinite(expiresAt) ? expiresAt > now : true;
}
