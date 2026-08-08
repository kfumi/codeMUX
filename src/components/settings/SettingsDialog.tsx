import { useState } from 'react';
import { Archive, ArrowLeft, BarChart3, Bot, FileText, Info, Palette, Plug, Puzzle, Server, Settings, Terminal } from 'lucide-react';

import { cn } from '../../lib/utils';
import { LAYOUT_DIVIDER_CLASS } from '../../lib/layoutTokens';
import { AboutSettings } from './AboutSettings';
import { AgentRuntimeSettingsPanel } from './AgentRuntimeSettings';
import { ArchivedSessionsPanel } from './ArchivedSessionsPanel';
import { EnvironmentSettings } from './EnvironmentSettings';
import { GeneralSettings } from './GeneralSettings';
import { LogSettings } from './LogSettings';
import { McpSettingsPanel } from './McpSettings';
import { ProviderConfigPanel } from './ProviderConfig';
import { SkillsSettingsPanel } from './SkillsSettings';
import { ThemeToggle } from './ThemeToggle';
import { UsageStatistics } from './UsageStatistics';

interface SettingsViewProps {
  onBack: () => void;
}

export type SettingsTab = 'general' | 'appearance' | 'provider' | 'agent-runtime' | 'mcp' | 'skills' | 'usage' | 'archive' | 'system-tools' | 'logs' | 'about';

interface SettingsSidebarProps {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onBack: () => void;
}

interface SettingsContentProps {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
}

const primaryTabs = [
  { id: 'general' as const, label: '常规', description: '应用级的通用信息与偏好设置。', icon: Settings },
  { id: 'appearance' as const, label: '外观', description: '自定义应用主题与视觉风格。', icon: Palette },
  { id: 'provider' as const, label: '模型配置', description: '管理模型供应商的 API Key、协议端点与模型列表；会话按智能体所需协议选用可用供应商。', icon: Plug },
  { id: 'agent-runtime' as const, label: '智能体运行时', description: '统一管理默认智能体、会话权限、托管 SDK Runtime 和外部 CLI 诊断。', icon: Bot },
  { id: 'mcp' as const, label: 'MCP', description: '管理 MCP 服务器，为智能体扩展工具与能力。', icon: Server },
  { id: 'skills' as const, label: 'Skills', description: '查看、卸载已安装的 skills，从各智能体工具导入。', icon: Puzzle },
  { id: 'usage' as const, label: '使用统计', description: '查看会话活跃度、Token 用量与模型分布。', icon: BarChart3 },
  { id: 'archive' as const, label: '已归档对话', description: '查询、取消归档、删除归档会话。', icon: Archive },
];

const secondaryTabs = [
  { id: 'system-tools' as const, label: '系统工具', description: '检查 CodeMUX 所需的 Node.js、npm 和 Git 本机环境。', icon: Terminal },
  { id: 'logs' as const, label: '日志', description: '实时查看应用运行日志（codemux.log），每 3 秒自动刷新。', icon: FileText },
  { id: 'about' as const, label: '关于', description: '应用信息与系统环境。', icon: Info },
];

const allTabs = [...primaryTabs, ...secondaryTabs];

export function SettingsSidebar({ activeTab, onTabChange, onBack }: SettingsSidebarProps) {
  const renderNavItem = ({ id, label, icon: Icon }: (typeof allTabs)[number]) => (
    <button
      key={id}
      type="button"
      onClick={() => onTabChange(id)}
      className={cn(
        'relative flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-ui-compact transition-colors duration-150',
        activeTab === id
          ? 'bg-[hsl(var(--sidebar-muted))] font-medium text-foreground dark:bg-[hsl(var(--foreground)/0.11)]'
          : 'text-foreground/66 hover:bg-[hsl(var(--sidebar-muted))]/50 hover:text-foreground dark:hover:bg-[hsl(var(--foreground)/0.06)]',
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0 transition-colors', activeTab === id ? 'text-foreground/82' : 'text-foreground/45')} />
      <span className="truncate">{label}</span>
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pb-4 pt-11">
        <button
          type="button"
          onClick={onBack}
          className="mb-5 flex items-center gap-2 rounded-md px-2 py-1.5 text-ui-compact font-medium text-foreground/70 transition-colors hover:bg-muted/62 hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          返回应用
        </button>
        <div className="px-2">
          <h1 className="text-ui-heading-md font-semibold leading-tight text-foreground">设置</h1>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3">
        {primaryTabs.map(renderNavItem)}
      </nav>

      <nav className="space-y-1 border-t border-border/50 px-3 py-3">
        {secondaryTabs.map(renderNavItem)}
      </nav>
    </div>
  );
}

export function SettingsContent({ activeTab, onTabChange }: SettingsContentProps) {
  const activeTabDef = allTabs.find((tab) => tab.id === activeTab);
  const activeLabel = activeTabDef?.label ?? '设置';
  const activeDescription = activeTabDef?.description;

  return (
    <section className="min-w-0 flex-1 overflow-auto bg-[hsl(var(--background))]">
      <header className="sticky top-0 z-10 border-b border-border/45 bg-[hsl(var(--background)/0.82)] backdrop-blur-md">
        <div className="mx-auto w-full max-w-5xl px-12 py-6">
          <h2 className="text-ui-heading-sm font-semibold tracking-tight text-foreground">{activeLabel}</h2>
          {activeDescription && (
            <p className="mt-1.5 text-ui-body leading-relaxed text-foreground/55">{activeDescription}</p>
          )}
        </div>
      </header>
      <div className="mx-auto w-full max-w-5xl px-12 py-8">
        {activeTab === 'general' && <GeneralSettings />}
        {activeTab === 'appearance' && <ThemeToggle />}
        {activeTab === 'provider' && <ProviderConfigPanel />}
        {activeTab === 'agent-runtime' && (
          <AgentRuntimeSettingsPanel onOpenSystemTools={() => onTabChange('system-tools')} />
        )}
        {activeTab === 'mcp' && <McpSettingsPanel />}
        {activeTab === 'skills' && <SkillsSettingsPanel />}
        {activeTab === 'usage' && <UsageStatistics />}
        {activeTab === 'archive' && <ArchivedSessionsPanel />}
        {activeTab === 'system-tools' && <EnvironmentSettings />}
        {activeTab === 'logs' && <LogSettings />}
        {activeTab === 'about' && <AboutSettings />}
      </div>
    </section>
  );
}

export function SettingsView({ onBack }: SettingsViewProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');

  return (
    <div role="main" aria-label="设置" className="flex min-h-0 flex-1 overflow-hidden bg-[hsl(var(--background))]">
      <aside className={`flex w-[300px] shrink-0 flex-col border-r ${LAYOUT_DIVIDER_CLASS} bg-[hsl(var(--surface-2)/0.88)] shadow-[inset_-1px_0_0_hsl(var(--foreground)/0.04)] backdrop-blur-xl`}>
        <SettingsSidebar activeTab={activeTab} onTabChange={setActiveTab} onBack={onBack} />
      </aside>
      <SettingsContent activeTab={activeTab} onTabChange={setActiveTab} />
    </div>
  );
}
