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
import { SettingsCard, SettingsRow, SettingsSection } from './SettingsRow';
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
    <div className="space-y-8">
      <SettingsSection label="显示偏好">
        <SettingsCard>
          <SettingsRow
            inlineControl
            label="精简 AI 输出"
            description="每轮只保留最终总结，过程消息收起来"
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
        </SettingsCard>
      </SettingsSection>

      <SettingsSection label="对话">
        <SettingsCard>
          <SettingsRow
            label="交互行为"
            description="运行中发消息：引导它改变方向，或直接打断"
            control={
              <Select
              value={immediateRunMode}
              onValueChange={(value) => {
                void setImmediateRunMode(value as ImmediateRunMode);
              }}
            >
              <SelectTrigger aria-label="交互行为" size="sm" className="w-full shrink-0 sm:w-32">
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
        </SettingsCard>
      </SettingsSection>

      <SettingsSection label="项目打开">
        <SettingsCard>
          <SettingsRow
            label="默认文件打开目标"
            description="对话页的项目打开按钮默认用它"
            control={
              <Select
              value={defaultOpenTarget}
              onValueChange={(value) => {
                void setDefaultOpenTarget(value as OpenTarget);
              }}
            >
              <SelectTrigger aria-label="默认文件打开目标" size="sm" className="w-full shrink-0 sm:w-44">
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
        </SettingsCard>
      </SettingsSection>

      <NotificationSettingsSection />

      {/* Config file section:仅桌面壳(本机路径 + 资源管理器) */}
      {showConfigFile && (
        <SettingsSection label="配置文件">
          <SettingsCard>
            <SettingsRow
              stacked
              label="应用配置文件"
              description="包含提供商、智能体、主题等全部设置"
              control={
                <div className="flex items-center gap-2">
                  {configPath ? (
                    <code className="min-w-0 flex-1 truncate rounded-md bg-[hsl(var(--foreground)/0.05)] px-2.5 py-1 font-mono text-code text-foreground">
                      {configPath}
                    </code>
                  ) : (
                    <div className="h-7 min-w-0 flex-1 animate-pulse rounded-md bg-[hsl(var(--foreground)/0.05)]" />
                  )}
                  <Button
                    variant="secondary"
                    size="xs"
                    className="shrink-0"
                    onClick={handleCopy}
                    disabled={!configPath}
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? '已复制' : '复制路径'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="xs"
                    className="shrink-0"
                    onClick={handleOpenDir}
                    disabled={!configDir}
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    打开目录
                  </Button>
                </div>
              }
            />
          </SettingsCard>
        </SettingsSection>
      )}
    </div>
  );
}
