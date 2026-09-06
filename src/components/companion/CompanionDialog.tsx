import { useEffect, useMemo, useState } from 'react';
import { Copy, RefreshCw, Smartphone, Square } from 'lucide-react';
import QRCode from 'react-qr-code';

import { buildPairingUrl, companionVisualStateLabel, getCompanionVisualState, relayStateLabel } from '../../lib/companion';
import { formatRelayEndpoint, isRelayEndpointValid, parseRelayEndpoint } from '../../lib/companion-relay';
import type { useCompanionStatus } from '../../hooks/useCompanionStatus';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
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

function StatusBadge({ visualState, latestDeviceName }: { visualState: ReturnType<typeof getCompanionVisualState>; latestDeviceName?: string | null }) {
  if (visualState === 'paired') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-foreground/80">
        <span className="inline-block h-2 w-2 rounded-full bg-[hsl(var(--success))]" />
        {companionVisualStateLabel(visualState)}
        {latestDeviceName ? <span className="text-xs text-foreground/55">· {latestDeviceName}</span> : null}
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
    setEnabled,
    refreshPairingCode,
    setRelayEnabled,
    setRelayConfig,
  } = controller;
  const [copied, setCopied] = useState(false);
  const [relayHost, setRelayHost] = useState('');
  const [relayPort, setRelayPort] = useState('443');
  const [relayUseTls, setRelayUseTls] = useState(true);

  const pairingUrl = useMemo(() => (status ? buildPairingUrl(status) : null), [status]);
  const visualState = getCompanionVisualState(status);
  const relayEndpointDraft = formatRelayEndpoint(relayHost, relayPort);
  const relayEndpointValid = isRelayEndpointValid(relayEndpointDraft);
  const relayConfigDirty = status
    ? relayEndpointDraft !== status.relay.endpoint || relayUseTls !== status.relay.useTls
    : relayEndpointValid;

  useEffect(() => {
    if (!status) return;
    const parsed = parseRelayEndpoint(status.relay.endpoint);
    setRelayHost(parsed.host);
    setRelayPort(parsed.port);
    setRelayUseTls(status.relay.useTls);
  }, [status?.relay.endpoint, status?.relay.useTls]);

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
            <StatusBadge visualState={visualState} latestDeviceName={status?.pairedDevices[0]?.name} />
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
                    手机扫码或打开链接后将自动连接并进入会话列表，5 分钟内有效。
                    {status?.relay.enabled ? ' 跨网链接走公网地址。' : null}
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
                  </div>
                </div>
              </div>

              <div className="space-y-3 rounded-xl border border-border/60 bg-muted/20 px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-foreground/90">公网中继</div>
                    <p className="mt-1 text-xs text-foreground/55">
                      填写公网可达的中继地址后启用。桌面主动连接中继，跨网流量经端到端加密。
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

                <div className="grid grid-cols-[1fr_96px] gap-2">
                  <Input
                    value={relayHost}
                    onChange={(event) => setRelayHost(event.target.value)}
                    placeholder="中继主机，如 relay.example.com"
                    disabled={busy || status?.relay.enabled}
                  />
                  <Input
                    value={relayPort}
                    onChange={(event) => setRelayPort(event.target.value)}
                    placeholder="端口"
                    inputMode="numeric"
                    disabled={busy || status?.relay.enabled}
                  />
                </div>
                <label className="flex items-center gap-2 text-sm text-foreground/80">
                  <input
                    type="checkbox"
                    checked={relayUseTls}
                    onChange={(event) => setRelayUseTls(event.target.checked)}
                    disabled={busy || status?.relay.enabled}
                  />
                  使用 TLS（wss）
                </label>

                <div className="flex flex-wrap gap-2">
                  {!status?.relay.enabled ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy || !relayEndpointValid || !relayConfigDirty}
                        onClick={() => {
                          void setRelayConfig(relayEndpointDraft, relayUseTls);
                        }}
                      >
                        保存端点
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy || !relayEndpointValid}
                        onClick={() => {
                          void (async () => {
                            if (relayConfigDirty) {
                              await setRelayConfig(relayEndpointDraft, relayUseTls);
                            }
                            await setRelayEnabled(true);
                          })();
                        }}
                      >
                        启用中继
                      </Button>
                    </>
                  ) : (
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
                  )}
                </div>

                {status?.relay.enabled ? (
                  <div className="text-xs text-foreground/55">
                    当前端点：{status.relay.endpoint}
                    {status.relay.useTls ? '（TLS）' : ''}
                  </div>
                ) : !relayEndpointValid && relayHost.trim() ? (
                  <div className="text-xs text-destructive">
                    请填写有效的主机与端口（1–65535）
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-dashed border-border/60 px-4 py-8 text-center text-sm text-foreground/55">
              移动伴侣未开启 — 本机 Daemon 仍在运行，桌面可正常使用；开启后可扫码配对手机。
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
