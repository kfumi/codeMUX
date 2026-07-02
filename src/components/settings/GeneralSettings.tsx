import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Copy, FolderOpen, Check } from 'lucide-react';

import { appApi } from '../../lib/tauri';
import { useSettingsStore } from '../../stores/settingsStore';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { NotificationSettingsSection } from './NotificationSettingsSection';

export function GeneralSettings() {
  const [configDir, setConfigDir] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const compactAiOutput = useSettingsStore((state) => state.config?.compact_ai_output ?? false);
  const setCompactAiOutput = useSettingsStore((state) => state.setCompactAiOutput);

  useEffect(() => {
    appApi.getAppDataDirectory().then(setConfigDir).catch(() => {});
  }, []);

  const sep = configDir.includes('\\') ? '\\' : '/';
  const configPath = configDir ? `${configDir}${sep}config.json` : '';

  const handleCopy = async () => {
    if (!configPath) return;
    try {
      await navigator.clipboard.writeText(configPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API may fail in some environments
    }
  };

  const handleOpenDir = () => {
    if (!configDir) return;
    invoke('open_in_explorer', { path: configDir }).catch(() => {});
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-foreground/90">常规设置</h3>
        <p className="mt-1 text-xs text-foreground/60">应用级的通用信息与偏好设置。</p>
      </div>

      <div className="space-y-3">
        <label className="text-sm text-foreground/74">显示偏好</label>
        <div className="flex items-center justify-between gap-4 rounded-xl border border-border/70 bg-card p-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground/90">精简 AI 输出</div>
            <p className="mt-1 text-xs leading-relaxed text-foreground/60">
              开启后，每轮完成时折叠总结前的过程消息，仅保留最终总结。
            </p>
          </div>
          <Switch
            aria-label="精简 AI 输出"
            checked={compactAiOutput}
            onCheckedChange={(checked) => {
              void setCompactAiOutput(checked);
            }}
          />
        </div>
      </div>

      <NotificationSettingsSection />

      {/* Config file section */}
      <div className="space-y-3">
        <label className="text-sm text-foreground/74">配置文件</label>
        <div className="rounded-xl border border-border/70 bg-card p-4 space-y-3">
          <p className="text-xs text-foreground/60">
            配置文件包含提供商、智能体、主题等所有应用设置。高级用户可直接编辑此文件。
          </p>
          {configPath ? (
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg bg-muted/50 px-3 py-2 text-xs text-foreground/80 font-mono">
                {configPath}
              </code>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5"
                onClick={handleCopy}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? '已复制' : '复制路径'}
              </Button>
            </div>
          ) : (
            <div className="h-8 animate-pulse rounded-lg bg-muted/40" />
          )}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={handleOpenDir}
            disabled={!configDir}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            打开配置目录
          </Button>
        </div>
      </div>
    </div>
  );
}
