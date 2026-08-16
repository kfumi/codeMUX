import { FormEvent, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import {
  addDirectConnection,
  removeConnection,
  summarizeActiveConnection,
  type CompanionConnectionProfile,
} from '@shared/lib/companion-connection';

import { invalidateReachabilityCache } from '../lib/api';
import { saveProfile } from '../lib/storage';

interface ConnectionSettingsProps {
  profile: CompanionConnectionProfile;
  onUpdated: (profile: CompanionConnectionProfile) => void;
  onClose: () => void;
}

export function ConnectionSettings({ profile, onUpdated, onClose }: ConnectionSettingsProps) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('9240');
  const [useTls, setUseTls] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState(profile.label ?? profile.desktopId);

  useEffect(() => {
    void (async () => {
      const { buildReachabilityMap } = await import('@shared/lib/companion-connection');
      const reachability = await buildReachabilityMap(profile);
      setSummary(summarizeActiveConnection(profile, reachability));
    })();
  }, [profile]);

  const handleAddDirect = async (event: FormEvent) => {
    event.preventDefault();
    const parsedPort = Number.parseInt(port, 10);
    if (!host.trim() || !Number.isFinite(parsedPort)) {
      setError('请填写有效的主机与端口');
      return;
    }
    setError(null);
    const next = addDirectConnection(profile, {
      host: host.trim(),
      port: parsedPort,
      useTls,
    });
    await saveProfile(next);
    invalidateReachabilityCache();
    onUpdated(next);
    setHost('');
  };

  const handleRemove = async (connectionId: string) => {
    const next = removeConnection(profile, connectionId);
    await saveProfile(next);
    invalidateReachabilityCache();
    onUpdated(next);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <div className="w-full max-w-lg rounded-2xl bg-background p-5 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">连接设置</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              当前优先路径：{summary}
            </p>
          </div>
          <button type="button" className="text-sm text-muted-foreground" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="space-y-2">
          {profile.connections.map((connection) => (
            <div key={connection.id} className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2 text-sm">
              <div>
                <div className="font-medium">
                  {connection.type === 'lan' && '局域网'}
                  {connection.type === 'relay' && '中继'}
                  {connection.type === 'direct' && '直连'}
                </div>
                <div className="text-xs text-muted-foreground break-all">
                  {connection.type === 'lan' && connection.baseUrl}
                  {connection.type === 'relay' && connection.endpoint}
                  {connection.type === 'direct' && `${connection.useTls ? 'https' : 'http'}://${connection.host}:${connection.port}`}
                </div>
              </div>
              {connection.type !== 'lan' ? (
                <button
                  type="button"
                  className="rounded-md p-2 text-muted-foreground hover:bg-muted"
                  aria-label="删除连接"
                  onClick={() => {
                    void handleRemove(connection.id);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <form className="mt-5 space-y-3 border-t border-border/60 pt-4" onSubmit={(event) => {
          void handleAddDirect(event);
        }}>
          <div className="text-sm font-medium">添加直连</div>
          <p className="text-xs text-muted-foreground">
            适用于 Tailscale、固定 LAN IP 或 VPN。无需重新配对。
          </p>
          <div className="grid grid-cols-[1fr_96px] gap-2">
            <input
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
              placeholder="主机，如 100.64.0.1"
              value={host}
              onChange={(event) => setHost(event.target.value)}
            />
            <input
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
              placeholder="端口"
              value={port}
              onChange={(event) => setPort(event.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={useTls}
              onChange={(event) => setUseTls(event.target.checked)}
            />
            使用 TLS
          </label>
          {error ? <div className="text-sm text-destructive">{error}</div> : null}
          <button
            type="submit"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground"
          >
            <Plus className="h-4 w-4" />
            添加直连
          </button>
        </form>
      </div>
    </div>
  );
}
