import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import QRCode from 'react-qr-code';

import { companionApi } from '../../lib/tauri';
import type { CompanionStatus } from '../../types/companion';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';

function buildPairingUrl(status: CompanionStatus): string | null {
  if (!status.lanIp || !status.pairingCode) return null;
  const url = new URL(`http://${status.lanIp}:${status.port}/`);
  url.searchParams.set('code', status.pairingCode);
  return url.toString();
}

export function MobileCompanionSettings() {
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await companionApi.getStatus();
      setStatus(next);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const pairingUrl = useMemo(() => (status ? buildPairingUrl(status) : null), [status]);

  const handleToggle = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = await companionApi.setEnabled(enabled);
      setStatus(next);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRefreshCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await companionApi.refreshPairingCode();
      setStatus(next);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (deviceId: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await companionApi.revokeDevice(deviceId);
      setStatus(next);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCopyUrl = async () => {
    if (!pairingUrl) return;
    try {
      await navigator.clipboard.writeText(pairingUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('复制失败，请手动复制地址');
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <label className="text-sm text-foreground/74">移动伴侣</label>
        <div className="flex items-center justify-between gap-4 rounded-xl bg-muted/40 p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground/90">
              <Smartphone className="h-4 w-4" />
              启用局域网移动同步
            </div>
            <p className="mt-1 text-xs leading-relaxed text-foreground/60">
              开启后，手机浏览器可通过扫码配对查看并驱动桌面会话。关闭将断开所有已配对设备。
            </p>
          </div>
          <Switch
            aria-label="启用移动伴侣"
            checked={status?.enabled ?? false}
            disabled={loading || busy}
            onCheckedChange={(checked) => {
              void handleToggle(checked);
            }}
          />
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {status?.enabled ? (
        <div className="space-y-4 rounded-xl border border-border/60 bg-background/60 p-4">
          <div className="space-y-3">
            <div className="text-sm font-medium text-foreground/90">配对信息</div>
            <p className="text-xs text-foreground/60">
              用手机扫描下方二维码，或在浏览器打开配对地址。配对码 5 分钟内有效。
            </p>

            <div className="flex flex-col gap-4 md:flex-row md:items-start">
              {pairingUrl ? (
                <div className="rounded-xl bg-white p-4">
                  <QRCode value={pairingUrl} size={168} />
                </div>
              ) : (
                <div className="flex h-[200px] w-[200px] items-center justify-center rounded-xl bg-muted/50 text-xs text-foreground/50">
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
                    disabled={!pairingUrl}
                    onClick={() => {
                      void handleCopyUrl();
                    }}
                  >
                    <Copy className="mr-1 h-3.5 w-3.5" />
                    {copied ? '已复制' : '复制地址'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      void handleRefreshCode();
                    }}
                  >
                    <RefreshCw className="mr-1 h-3.5 w-3.5" />
                    刷新配对码
                  </Button>
                </div>
                <div className="text-sm text-foreground/70">
                  配对码：
                  <span className="ml-2 font-mono text-lg tracking-[0.3em] text-foreground">
                    {status.pairingCode ?? '------'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium text-foreground/90">已配对设备</div>
            {status.pairedDevices.length === 0 ? (
              <p className="text-xs text-foreground/50">暂无已配对设备</p>
            ) : (
              <div className="space-y-2">
                {status.pairedDevices.map((device) => (
                  <div
                    key={device.id}
                    className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm text-foreground/85">{device.name}</div>
                      <div className="text-xs text-foreground/50">
                        配对于 {new Date(device.paired_at).toLocaleString()}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`撤销 ${device.name}`}
                      disabled={busy}
                      onClick={() => {
                        void handleRevoke(device.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
