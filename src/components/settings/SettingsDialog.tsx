import { useState } from 'react';
import { Archive, ArrowLeft, BarChart3, Bot, FileText, GitBranch, Globe, Image, Info, Keyboard, MonitorSmartphone, Palette, Plug, Puzzle, Server, Settings, Terminal } from 'lucide-react';

import { useHostCapabilities } from '../../hooks/useHostCapabilities';
import { cn } from '../../lib/utils';
import type { HostCapabilitySet } from '../../lib/host/host-capabilities';
import { AboutSettings } from './AboutSettings';
import { AgentRuntimeSettingsPanel } from './AgentRuntimeSettings';
import { ArchivedSessionsPanel } from './ArchivedSessionsPanel';
import { BrowserControlSettings } from './BrowserControlSettings';
import { ComputerUseSettings } from './ComputerUseSettings';
import { EnvironmentSettings } from './EnvironmentSettings';
import { GeneralSettings } from './GeneralSettings';
import { GitSettings } from './GitSettings';
import { ImageRecognitionSettings } from './ImageRecognitionSettings';
import { KeyboardShortcutsSettings } from './KeyboardShortcutsSettings';
import { LogSettings } from './LogSettings';
import { McpSettingsPanel } from './McpSettings';
import { ProviderConfigPanel } from './ProviderConfig';
import { SkillsSettingsPanel } from './SkillsSettings';
import { ThemeToggle } from './ThemeToggle';
import { UsageStatistics } from './UsageStatistics';

interface SettingsViewProps {
  onBack: () => void;
}

export type SettingsTab = 'general' | 'appearance' | 'shortcuts' | 'provider' | 'image-recognition' | 'browser-control' | 'computer-use' | 'agent-runtime' | 'mcp' | 'skills' | 'git' | 'usage' | 'archive' | 'system-tools' | 'logs' | 'about';

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
  { id: 'shortcuts' as const, label: '快捷键', description: '自定义每条命令的键位，可禁用或恢复默认。', icon: Keyboard },
  { id: 'provider' as const, label: '模型配置', description: '管理模型供应商的 API Key、协议端点与模型列表；会话按智能体所需协议选用可用供应商。', icon: Plug },
  { id: 'image-recognition' as const, label: '图片识别', description: '为非 vision 会话模型配置图片解析用的 API 密钥、地址与解析模型。', icon: Image },
  { id: 'browser-control' as const, label: '浏览器控制', description: '管理内置浏览器的开关、证书校验与站点数据。', icon: Globe },
  { id: 'computer-use' as const, label: '电脑控制', description: '开关与范围、驱动管理（启动/诊断/急停/更新）、步数上限。', icon: MonitorSmartphone },
  { id: 'agent-runtime' as const, label: '智能体运行时', description: '统一管理默认智能体、会话权限、托管 SDK Runtime 和外部 CLI 诊断。', icon: Bot },
  { id: 'mcp' as const, label: 'MCP', description: '管理 MCP 服务器，为智能体扩展工具与能力。', icon: Server },
  { id: 'skills' as const, label: 'Skills', description: '查看、卸载已安装的 skills，从各智能体工具导入。', icon: Puzzle },
  { id: 'git' as const, label: 'Git', description: '自定义提交信息与拉取请求的 AI 生成指引。', icon: GitBranch },
  { id: 'usage' as const, label: '使用统计', description: '查看会话活跃度、Token 用量与模型分布。', icon: BarChart3 },
  { id: 'archive' as const, label: '已归档对话', description: '查询、取消归档、删除归档会话。', icon: Archive },
];

const secondaryTabs = [
  { id: 'system-tools' as const, label: '系统工具', description: '检查 CodeMUX 所需的 Node.js、npm 和 Git 本机环境。', icon: Terminal },
  { id: 'logs' as const, label: '日志', description: '实时查看应用运行日志（daemon.log / renderer.log），每 3 秒自动刷新。', icon: FileText },
  { id: 'about' as const, label: '关于', description: '应用信息与系统环境。', icon: Info },
];

const allTabs = [...primaryTabs, ...secondaryTabs];

/**
 * 壳独占设置页 → 所需能力(工单 02 回归)。
 *
 * 日志读的是 Electron 侧日志文件、系统工具探测的是壳进程所在机器的 PATH:
 * 浏览器/移动形态没有对应后端,导航里直接隐藏入口,而不是让用户点进去看到
 * 「桥不可用」的报错(用户故事 10:shell-only 能力隐藏而非报错)。
 */
const SHELL_ONLY_TAB_CAPABILITY: Partial<Record<SettingsTab, string>> = {
  logs: 'host.logs',
  'system-tools': 'host.env-check',
};

function isTabAvailable(tab: SettingsTab, capabilities: HostCapabilitySet): boolean {
  const required = SHELL_ONLY_TAB_CAPABILITY[tab];
  return required ? capabilities.has(required) : true;
}

export function SettingsSidebar({ activeTab, onTabChange, onBack }: SettingsSidebarProps) {
  const capabilities = useHostCapabilities();
  const visiblePrimaryTabs = primaryTabs.filter((tab) => isTabAvailable(tab.id, capabilities));
  const visibleSecondaryTabs = secondaryTabs.filter((tab) => isTabAvailable(tab.id, capabilities));

  const renderNavItem = ({ id, label, icon: Icon }: (typeof allTabs)[number]) => (
    <button
      key={id}
      type="button"
      onClick={() => onTabChange(id)}
      className={cn(
        'relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-ui-compact transition-colors duration-fast',
        activeTab === id
          ? 'bg-[hsl(var(--foreground)/0.08)] font-medium text-foreground'
          : 'text-muted-foreground hover:bg-[hsl(var(--foreground)/0.05)] hover:text-foreground',
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0 transition-colors', activeTab === id ? 'text-foreground' : 'text-muted-foreground')} />
      <span className="truncate">{label}</span>
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pb-4 pt-11">
        <button
          type="button"
          onClick={onBack}
          className="mb-5 flex items-center gap-2 rounded-md px-2 py-1.5 text-ui-compact font-medium text-foreground transition-colors hover:bg-muted/62 hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          返回应用
        </button>
        <div className="px-2">
          <h1 className="text-ui-heading-md font-semibold leading-tight text-foreground">设置</h1>
        </div>
      </div>

      {/* 窄屏抽屉里条目会超出视口高度,主分组必须能独立滚动。 */}
      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain px-3">
        {visiblePrimaryTabs.map(renderNavItem)}
      </nav>

      <nav className="space-y-1 px-3 py-3">
        {visibleSecondaryTabs.map(renderNavItem)}
      </nav>
    </div>
  );
}

export function SettingsContent({ activeTab, onTabChange }: SettingsContentProps) {
  const capabilities = useHostCapabilities();
  const activeTabDef = allTabs.find((tab) => tab.id === activeTab);
  const activeLabel = activeTabDef?.label ?? '设置';
  const activeDescription = activeTabDef?.description;

  return (
    <section className="min-w-0 flex-1 overflow-auto bg-[hsl(var(--background))]">
      <header className="sticky top-0 z-10 bg-[hsl(var(--background)/0.82)] backdrop-blur-md">
        {/* 手机/窄屏:48px 的桌面内边距会把内容压到 300px 以内,逐级收敛。 */}
        <div className="mx-auto w-full max-w-5xl px-4 pb-3 pt-4 sm:px-6 sm:pb-3.5 sm:pt-5 lg:px-12 lg:pb-4 lg:pt-6">
          <h2 className="text-ui-heading-md font-semibold tracking-tight text-foreground">{activeLabel}</h2>
          {activeDescription && (
            <p className="mt-1.5 text-ui-compact leading-relaxed text-muted-foreground sm:text-ui-body">{activeDescription}</p>
          )}
        </div>
      </header>
      {/* @container:让面板按「内容区实际宽度」而不是视口宽度做自适应
          (侧边栏可拖拽改宽,视口断点会算错)。 */}
      <div className="@container mx-auto w-full max-w-5xl px-4 pb-5 pt-3 sm:px-6 sm:pb-6 sm:pt-4 lg:px-12 lg:pb-8 lg:pt-4">
        {activeTab === 'general' && <GeneralSettings />}
        {activeTab === 'appearance' && <ThemeToggle />}
        {activeTab === 'shortcuts' && <KeyboardShortcutsSettings />}
        {activeTab === 'provider' && <ProviderConfigPanel />}
        {activeTab === 'image-recognition' && <ImageRecognitionSettings />}
        {activeTab === 'browser-control' && <BrowserControlSettings />}
        {activeTab === 'computer-use' && <ComputerUseSettings />}
        {activeTab === 'agent-runtime' && (
          <AgentRuntimeSettingsPanel
            onOpenSystemTools={
              capabilities.has('host.env-check') ? () => onTabChange('system-tools') : undefined
            }
          />
        )}
        {activeTab === 'mcp' && <McpSettingsPanel />}
        {activeTab === 'skills' && <SkillsSettingsPanel />}
        {activeTab === 'git' && <GitSettings />}
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
      <aside className="flex w-[275px] shrink-0 flex-col bg-[hsl(var(--sidebar-bg))]">
        <SettingsSidebar activeTab={activeTab} onTabChange={setActiveTab} onBack={onBack} />
      </aside>
      <SettingsContent activeTab={activeTab} onTabChange={setActiveTab} />
    </div>
  );
}
