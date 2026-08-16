import { useMemo, useState } from 'react';
import { Copy, RefreshCw, Smartphone, Square, Trash2 } from 'lucide-react';
import QRCode from 'react-qr-code';

import { buildPairingUrl, companionVisualStateLabel, formatDeviceDetails, getCompanionVisualState, relayStateLabel } from '../../lib/companion';
import type { useCompanionStatus } from '../../hooks/useCompanionStatus';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

type CompanionController = ReturnType<typeof useCompanionStatus>;

interface CompanionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controller: CompanionController;
}

function StatusBadge({ visualState }: { visualState: ReturnType<typeof getCompanionVisualState> }) {
  if (visualState === 'paired') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-foreground/80">
        <span className="inline-block h-2 w-2 rounded-full bg-[hsl(var(--success))]" />
        {companionVisualStateLabel(visualState)}
      </span>
    );
  }
  if (visualState === 'reconnecting') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-foreground/80">
        <span className="inline-block h-2 w-2 rounded-full bg-[hsl(var(--warning))]" />
        {companionVisualStateLabel(visualState)}
      </span>
    );
  }
  if (visualState === 'waiting') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-foreground/80">
        <span className="inline-block h-2 w-2 rounded-full bg-[hsl(var(--warning))]" />
        {companionVisualStateLabel(visualState)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-foreground/60">
      <span className="inline-block h-2 w-2 rounded-full bg-foreground/25" />
      未开启
    </span>
  );
}

export function CompanionDialog({ open, onOpenChange, controller }: CompanionDialogProps) {
  const {
    status,
    loading,
    busy,
    error,
    refreshingDevices,
    loadStatus,
    setEnabled,
    refreshPairingCode,
    revokeDevice,
    setRelayEnabled,
  } = controller;
  const [copied, setCopied] = useState(false);

  const pairingUrl = useMemo(() => (status ? buildPairingUrl(status) : null), [status]);
  const visualState = getCompanionVisualState(status);

  const handleCopyUrl = async () => {
    if (!pairingUrl) return;
    try {
      await navigator.clipboard.writeText(pairingUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // handled by controller error elsewhere if needed
    }
  };

  const handleStop = async () => {
    await setEnabled(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <div className="border-b border-border/60 px-6 py-5">
          <DialogHeader className="space-y-2 text-left">
            <DialogTitle className="flex items-center gap-2 text-ui-heading-sm">
              <Smartphone className="h-5 w-5 text-primary" />
              移动伴侣
            </DialogTitle>
            <DialogDescription>
              用手机扫码配对，在局域网内远程查看并驱动桌面会话。
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-5 px-6 py-5">
          {error ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/25 px-4 py-3">
            <StatusBadge visualState={visualState} />
            {status?.enabled ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  void handleStop();
                }}
              >
                <Square className="mr-1.5 h-3.5 w-3.5" />
                停止
              </Button>
            ) : null}
          </div>

          {loading && !status ? (
            <div className="rounded-xl border border-dashed border-border/60 px-4 py-10 text-center text-sm text-foreground/50">
              正在加载…
            </div>
          ) : status?.enabled || busy ? (
            <>
              <div className="space-y-3">
                <div>
                  <div className="text-sm font-medium text-foreground/90">手机扫码连接</div>
                  <p className="mt-1 text-xs text-foreground/55">
                    使用手机相机或浏览器扫描二维码，配对码 5 分钟内有效。
                  </p>
                </div>

                <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                  {pairingUrl ? (
                    <div className="mx-auto rounded-xl bg-white p-4 sm:mx-0">
                      <QRCode value={pairingUrl} size={168} />
                    </div>
                  ) : (
                    <div className="flex h-50 w-50 items-center justify-center rounded-xl bg-muted/50 text-xs text-foreground/50">
                      正在获取局域网地址…
                    </div>
                  )}

                  <div className="min-w-0 flex-1 space-y-3">
                    {pairingUrl ? (
                      <div className="rounded-lg bg-muted/50 px-3 py-2 font-mono text-xs break-all text-foreground/80">
                        {pairingUrl}
                      </div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy || !pairingUrl}
                        onClick={() => {
                          void refreshPairingCode();
                        }}
                      >
                        <RefreshCw className="mr-1 h-3.5 w-3.5" />
                        刷新二维码
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!pairingUrl}
                        onClick={() => {
                          void handleCopyUrl();
                        }}
                      >
                        <Copy className="mr-1 h-3.5 w-3.5" />
                        {copied ? '已复制' : '复制链接'}
                      </Button>
                    </div>
                    <div className="text-sm text-foreground/70">
                      配对码：
                      <span className="ml-2 font-mono text-lg tracking-[0.3em] text-foreground">
                        {status?.pairingCode ?? '------'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-3 rounded-xl border border-border/60 bg-muted/20 px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-foreground/90">公网中继</div>
                    <p className="mt-1 text-xs text-foreground/55">
                      开启后桌面主动连接中继，跨网流量经端到端加密；中继无法读取明文。
                    </p>
                  </div>
                  {status?.relay.enabled ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-foreground/70">
                      <span className={`inline-block h-2 w-2 rounded-full ${
                        status.relay.connectionState === 'connected'
                          ? 'bg-[hsl(var(--success))]'
                          : status.relay.connectionState === 'error'
                            ? 'bg-destructive'
                            : 'bg-[hsl(var(--warning))]'
                      }`} />
                      {relayStateLabel(status.relay.connectionState)}
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  {status?.relay.enabled ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm('关闭中继后，新的跨网配对将不可用。已有局域网配对不受影响。')) {
                          void setRelayEnabled(false);
                        }
                      }}
                    >
                      关闭中继
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        void setRelayEnabled(true);
                      }}
                    >
                      启用中继
                    </Button>
                  )}
                </div>
                {status?.relay.enabled ? (
                  <div className="text-xs text-foreground/55">
                    中继端点：{status.relay.endpoint}
                    {status.relay.useTls ? '（TLS）' : ''}
                  </div>
                ) : null}
              </div>

              <div className="space-y-2 border-t border-border/50 pt-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium text-foreground/90">已配对设备</div>
                    <p className="mt-1 text-xs text-foreground/50">
                      已授权可连接的设备。仅关闭手机不会自动移除；手机端「断开配对」或点击右侧撤销才会移除。
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy || refreshingDevices}
                    onClick={() => {
                      void loadStatus(true);
                    }}
                  >
                    <RefreshCw className={cn('mr-1 h-3.5 w-3.5', refreshingDevices && 'animate-spin')} />
                    刷新
                  </Button>
                </div>
                {(status?.pairedDevices.length ?? 0) === 0 ? (
                  <p className="text-xs text-foreground/50">暂无已配对设备</p>
                ) : (
                  <div className="space-y-2">
                    {status?.pairedDevices.map((device) => {
                      const details = formatDeviceDetails(device);
                      return (
                        <div
                          key={device.id}
                          className="flex items-start justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="text-sm text-foreground/85">{device.name}</div>
                            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs leading-relaxed text-foreground/50">
                              <span className="font-mono break-all">ID {details.id}</span>
                              <span className="whitespace-nowrap">配对于 {details.pairedAt}</span>
                              <span className="whitespace-nowrap">
                                {details.online ? '在线' : `最近请求 ${details.lastSeen}`}
                              </span>
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="shrink-0"
                            aria-label={`撤销 ${device.name}`}
                            disabled={busy}
                            onClick={() => {
                              void revokeDevice(device.id);
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-dashed border-border/60 px-4 py-8 text-center text-sm text-foreground/55">
              移动伴侣未开启。关闭此窗口后，可再次点击左下角手机图标开启配对。
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
