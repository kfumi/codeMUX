import { useEffect, useRef, useState } from 'react';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { isWebPairingRequestFresh, parseWebPairingRequest, type WebPairingRequest } from '@/lib/bootstrap/pairing-requests';
import { shellEventBridge } from '@/lib/bootstrap/shell-event-bridge';

/**
 * 桌面壳侧的配对确认(工单 02,用户故事 3)。
 *
 * daemon 在收到同机浏览器的配对申请后,经控制面 WS → 壳 → `web-pairing-request`
 * 事件把请求送到渲染层;这里弹一次确认,批准即由 daemon 给浏览器颁发 Pairing
 * Token。浏览器侧全程不接触 Local Daemon Token。
 */
export function WebPairingConfirmHost() {
  const [queue, setQueue] = useState<WebPairingRequest[]>([]);
  const deciding = useRef(false);

  useEffect(() => {
    return shellEventBridge.subscribe('web-pairing-request', (payload) => {
      const request = parseWebPairingRequest(payload);
      if (!request || !isWebPairingRequestFresh(request)) return;
      setQueue((current) => (
        current.some((item) => item.requestId === request.requestId)
          ? current
          : [...current, request]
      ));
    });
  }, []);

  const current = queue[0] ?? null;

  const decide = async (approve: boolean) => {
    if (!current || deciding.current) return;
    deciding.current = true;
    try {
      const { daemonFacade } = await import('@/lib/facades/daemon-facade');
      await daemonFacade.decideLocalPairing(current.requestId, approve);
    } catch {
      // 失败时仅从队列移除:浏览器侧仍在轮询,会自己给出过期/失败提示。
    } finally {
      deciding.current = false;
      setQueue((list) => list.filter((item) => item.requestId !== current.requestId));
    }
  };

  return (
    <ConfirmDialog
      open={current != null}
      onOpenChange={(open) => {
        if (!open) void decide(false);
      }}
      title="浏览器请求本机访问"
      description={current
        ? `「${current.name}」请求在本机浏览器中使用 CodeMUX。确认码 ${current.code}。仅当你本人正在该浏览器中操作时确认。`
        : ''}
      confirmLabel="允许访问"
      cancelLabel="拒绝"
      onConfirm={() => decide(true)}
    />
  );
}
