import { useEffect, useState } from 'react';
import { Copy, FolderOpen, Check } from 'lucide-react';

import { useHostCapabilities } from '../../hooks/useHostCapabilities';
import { shellFacade } from '../../lib/facades/shell-facade';
import { getOpenTargetOption, normalizeOpenTarget, OPEN_TARGET_OPTIONS, type OpenTarget } from '../../lib/openTargets';
import { normalizeImmediateRunMode } from '../../lib/agentSteer';
import { useSettingsStore } from '../../stores/settingsStore';
import { Button } from '../ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Switch } from '../ui/switch';
import { NotificationSettingsSection } from './NotificationSettingsSection';
import { SettingsRow } from './SettingsRow';
import type { ImmediateRunMode } from '../../types/provider';

export function GeneralSettings() {
  const [configDir, setConfigDir] = useState<string>('');
  const [copied, setCopied] = useState(false);
  // 配置文件路径只有壳进程知道(应用数据目录 + 资源管理器):浏览器/移动形态
  // 整块隐藏,避免留下一个永远转圈或必然报错的区块(用户故事 10)。
  const capabilities = useHostCapabilities();
  const showConfigFile = capabilities.has('host.app-paths');
  const compactAiOutput = useSettingsStore((state) => state.config?.compact_ai_output ?? false);
  const immediateRunMode = useSettingsStore((state) => normalizeImmediateRunMode(state.config?.immediate_run_mode));
  const defaultOpenTarget = useSettingsStore((state) => normalizeOpenTarget(state.config?.default_open_target));
  const setCompactAiOutput = useSettingsStore((state) => state.setCompactAiOutput);
  const setImmediateRunMode = useSettingsStore((state) => state.setImmediateRunMode);
  const setDefaultOpenTarget = useSettingsStore((state) => state.setDefaultOpenTarget);

  useEffect(() => {
    if (!showConfigFile) return;
    shellFacade.getAppDataDirectory().then(setConfigDir).catch(() => {});
  }, [showConfigFile]);

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
    shellFacade.openInExplorer(configDir).catch(() => {});
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <label className="text-ui-compact font-medium text-muted-foreground">显示偏好</label>
        <SettingsRow
          surface
          inlineControl
          label="精简 AI 输出"
          description="开启后，每轮完成时折叠总结前的过程消息，仅保留最终总结。"
          control={
            <Switch
            aria-label="精简 AI 输出"
            checked={compactAiOutput}
            onCheckedChange={(checked) => {
              void setCompactAiOutput(checked);
            }}
            />
          }
        />
      </div>

      <div className="space-y-3">
        <label className="text-ui-compact font-medium text-muted-foreground">对话</label>
        <SettingsRow
          surface
          label="「立即」的行为"
          description="运行中点排队消息的「立即」时，优先引导进当前轮，还是中断当前轮再发送。斜杠命令和不支持引导的智能体仍会中断。"
          control={
            <Select
            value={immediateRunMode}
            onValueChange={(value) => {
              void setImmediateRunMode(value as ImmediateRunMode);
            }}
          >
            <SelectTrigger aria-label="立即的行为" className="h-9 w-full shrink-0 rounded-lg sm:w-28">
              <SelectValue>
                {immediateRunMode === 'interrupt' ? '中断' : '引导'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="steer">引导</SelectItem>
              <SelectItem value="interrupt">中断</SelectItem>
            </SelectContent>
            </Select>
          }
        />
      </div>

      <div className="space-y-3">
        <label className="text-ui-compact font-medium text-muted-foreground">项目打开</label>
        <SettingsRow
          surface
          label="默认文件打开目标"
          description="设置默认打开文件和文件夹的位置，对话页项目打开按钮会默认使用此项。"
          control={
            <Select
            value={defaultOpenTarget}
            onValueChange={(value) => {
              void setDefaultOpenTarget(value as OpenTarget);
            }}
          >
            <SelectTrigger aria-label="默认文件打开目标" className="h-9 w-full shrink-0 rounded-lg sm:w-44">
              <SelectValue>
                {(() => {
                  const option = getOpenTargetOption(defaultOpenTarget);
                  const Icon = option.Icon;
                  return (
                    <span className="flex items-center gap-2">
                      <Icon className="h-4 w-4" />
                      <span>{option.label}</span>
                    </span>
                  );
                })()}
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="end">
              {OPEN_TARGET_OPTIONS.map((option) => {
                const Icon = option.Icon;
                return (
                  <SelectItem key={option.value} value={option.value}>
                    <span className="flex items-center gap-2">
                      <Icon className="h-4 w-4" />
                      <span>{option.label}</span>
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
            </Select>
          }
        />
      </div>

      <NotificationSettingsSection />

      {/* Config file section:仅桌面壳(本机路径 + 资源管理器) */}
      {showConfigFile && (
        <div className="space-y-3">
          <label className="text-ui-compact font-medium text-muted-foreground">配置文件</label>
          <div className="rounded-xl settings-tile p-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              配置文件包含提供商、智能体、主题等所有应用设置。高级用户可直接编辑此文件。
            </p>
            {configPath ? (
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-lg bg-muted/50 px-3 py-2 text-code text-foreground font-mono">
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
      )}
    </div>
  );
}
