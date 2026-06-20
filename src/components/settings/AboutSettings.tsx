import { useEffect, useState } from 'react';
import { ExternalLink, Github } from 'lucide-react';
import { getName, getVersion, getTauriVersion } from '@tauri-apps/api/app';

import { Button } from '../ui/button';

interface AppInfo {
  name: string;
  version: string;
  tauriVersion: string;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-foreground/60">{label}</span>
      <span className="text-sm font-medium text-foreground/90">{value}</span>
    </div>
  );
}

export function AboutSettings() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    Promise.all([getName(), getVersion(), getTauriVersion()])
      .then(([name, version, tauriVersion]) => {
        setInfo({ name, version, tauriVersion });
      })
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-foreground/90">关于</h3>
        <p className="mt-1 text-xs text-foreground/60">应用信息与系统环境。</p>
      </div>

      {/* App identity */}
      <div className="flex flex-col items-center gap-4 rounded-xl border border-border/70 bg-card p-6">
        <img src="/logo.png" alt="codeMUX" className="h-16 w-16 rounded-2xl" />
        <div className="text-center">
          <h2 className="text-lg font-semibold text-foreground/90">
            {info?.name ?? 'codeMUX'}
          </h2>
          <p className="text-sm text-foreground/60">AI 编码工具聚合平台</p>
          {info?.version && (
            <span className="mt-2 inline-block rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              v{info.version}
            </span>
          )}
        </div>
      </div>

      {/* Environment info */}
      <div className="space-y-3">
        <label className="text-sm text-foreground/74">运行环境</label>
        <div className="rounded-xl border border-border/70 bg-card px-4 divide-y divide-border/50">
          <InfoRow label="应用版本" value={info?.version ?? '-'} />
          <InfoRow label="Tauri 版本" value={info?.tauriVersion ?? '-'} />
          <InfoRow label="操作系统" value={getOSInfo()} />
          <InfoRow label="系统架构" value={getArchInfo()} />
        </div>
      </div>

      {/* Links */}
      <div className="space-y-3">
        <label className="text-sm text-foreground/74">链接</label>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => {
              import('@tauri-apps/plugin-shell').then(({ open }) => {
                open('https://github.com/vzi777/codeMUX');
              }).catch(() => {});
            }}
          >
            <Github className="h-3.5 w-3.5" />
            GitHub
            <ExternalLink className="h-3 w-3 opacity-50" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function getOSInfo(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Windows')) return 'Windows';
  if (ua.includes('Mac')) return 'macOS';
  if (ua.includes('Linux')) return 'Linux';
  return '未知';
}

function getArchInfo(): string {
  // In Tauri, navigator.platform is still available
  const p = navigator.platform ?? '';
  if (p.includes('x64') || p.includes('x86_64') || p.includes('Win64')) return 'x86_64';
  if (p.includes('arm64') || p.includes('aarch64')) return 'ARM64';
  if (p.includes('x86')) return 'x86';
  return p || '未知';
}
