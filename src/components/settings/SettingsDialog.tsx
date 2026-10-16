import { useMemo, useState } from 'react';
import { Archive, ArrowLeft, BarChart3, Bot, FileText, GitBranch, Globe, Image, Info, Keyboard, MonitorSmartphone, Palette, Plug, Puzzle, Search, Server, Settings, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { useHostCapabilities } from '../../hooks/useHostCapabilities';
import { cn } from '../../lib/utils';
import type { HostCapabilitySet } from '../../lib/host/host-capabilities';
import { AboutSettings } from './AboutSettings';
import { AgentRuntimeSettingsPanel } from './AgentRuntimeSettings';
import { ArchivedSessionsPanel } from './ArchivedSessionsPanel';
import { BrowserControlSettings } from './BrowserControlSettings';
import { ComputerUseSettings } from './ComputerUseSettings';
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

export type SettingsTab = 'general' | 'appearance' | 'shortcuts' | 'provider' | 'image-recognition' | 'browser-control' | 'computer-use' | 'agent-runtime' | 'mcp' | 'skills' | 'git' | 'usage' | 'archive' | 'logs' | 'about';

interface SettingsSidebarProps {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onBack: () => void;
}

interface SettingsContentProps {
  activeTab: SettingsTab;
}

interface SettingsTabDef {
  id: SettingsTab;
  label: string;
  /** 页头副标题:一句话,不写「在哪儿点」的教学句。 */
  description: string;
  icon: LucideIcon;
}

/**
 * 导航分组 —— 照 Codex 的三段式左栏:标题 → 搜索框 → 分组列表。
 *
 * Codex 用「个人 / 集成 / 编码」分组,我们按自己的信息架构分成四组:
 * 通用(应用本身) / 智能体(引擎、模型与工具) / 能力(能操作什么) / 数据与系统。
 * 分页结构本身不变,只是不再一条平铺到底。
 */
const NAV_GROUPS: { key: string; label: string; tabs: SettingsTabDef[] }[] = [
  {
    key: 'general',
    label: '通用',
    tabs: [
      { id: 'general', label: '常规', description: '应用的通用偏好', icon: Settings },
      { id: 'appearance', label: '外观', description: '主题、字体与界面尺度', icon: Palette },
      { id: 'shortcuts', label: '快捷键', description: '自定义每条命令的键位', icon: Keyboard },
    ],
  },
  {
    key: 'agents',
    label: '智能体',
    tabs: [
      { id: 'agent-runtime', label: '智能体运行时', description: '默认智能体、会话权限与运行环境', icon: Bot },
      { id: 'provider', label: '模型配置', description: '供应商的密钥、端点与模型列表', icon: Plug },
      { id: 'mcp', label: 'MCP', description: '给智能体接入 MCP 工具', icon: Server },
      { id: 'skills', label: 'Skills', description: '查看、导入与卸载 skills', icon: Puzzle },
    ],
  },
  {
    key: 'capabilities',
    label: '能力',
    tabs: [
      { id: 'image-recognition', label: '图片识别', description: '给不支持图片的模型配一个解析器', icon: Image },
      { id: 'browser-control', label: '浏览器控制', description: '内置浏览器的开关与站点数据', icon: Globe },
      { id: 'computer-use', label: '电脑控制', description: '桌面操作的范围与驱动', icon: MonitorSmartphone },
      { id: 'git', label: 'Git', description: '提交信息的生成指引', icon: GitBranch },
    ],
  },
  {
    key: 'system',
    label: '数据与系统',
    tabs: [
      { id: 'usage', label: '使用统计', description: '活跃度、Token 用量与模型分布', icon: BarChart3 },
      { id: 'archive', label: '已归档对话', description: '查询、恢复与删除会话', icon: Archive },
      { id: 'logs', label: '日志', description: '实时查看应用运行日志', icon: FileText },
      { id: 'about', label: '关于', description: '应用信息与系统环境', icon: Info },
    ],
  },
];

const allTabs: SettingsTabDef[] = NAV_GROUPS.flatMap((group) => group.tabs);

/**
 * 壳独占设置页 → 所需能力(工单 02 回归)。
 *
 * 日志读的是 Electron 侧日志文件:浏览器/移动形态没有对应后端,导航里直接
 * 隐藏入口,而不是让用户点进去看到「桥不可用」的报错(用户故事 10:
 * shell-only 能力隐藏而非报错)。
 */
const SHELL_ONLY_TAB_CAPABILITY: Partial<Record<SettingsTab, string>> = {
  logs: 'host.logs',
};

function isTabAvailable(tab: SettingsTab, capabilities: HostCapabilitySet): boolean {
  const required = SHELL_ONLY_TAB_CAPABILITY[tab];
  return required ? capabilities.has(required) : true;
}

/**
 * 左导航 —— 标题、搜索框、分组列表。
 *
 * 未选中项用**墨色**而不是次级灰:实测 Codex 的导航行文字是正文色,
 * 只有分组标题才是弱色;整列发灰是「设置页看起来浅」的最大一处。
 */
export function SettingsSidebar({ activeTab, onTabChange, onBack }: SettingsSidebarProps) {
  const capabilities = useHostCapabilities();
  const [query, setQuery] = useState('');

  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return NAV_GROUPS.map((group) => ({
      ...group,
      tabs: group.tabs
        .filter((tab) => isTabAvailable(tab.id, capabilities))
        .filter(
          (tab) =>
            !needle ||
            tab.label.toLowerCase().includes(needle) ||
            tab.description.toLowerCase().includes(needle),
        ),
    })).filter((group) => group.tabs.length > 0);
  }, [capabilities, query]);

  const firstMatch = visibleGroups[0]?.tabs[0];

  const renderNavItem = ({ id, label, icon: Icon }: SettingsTabDef) => {
    const active = activeTab === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => onTabChange(id)}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-compact transition-colors duration-fast',
          active
            ? 'bg-[hsl(var(--foreground)/0.08)] font-medium text-foreground'
            : 'text-foreground hover:bg-[hsl(var(--foreground)/0.05)]',
        )}
      >
        <Icon
          className={cn(
            'h-4 w-4 shrink-0 transition-colors',
            active ? 'text-foreground' : 'text-muted-foreground',
          )}
        />
        <span className="truncate">{label}</span>
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pb-3 pt-11">
        <button
          type="button"
          onClick={onBack}
          className="mb-5 flex items-center gap-2 rounded-md px-2 py-1.5 text-ui-compact font-medium text-foreground transition-colors hover:bg-[hsl(var(--foreground)/0.05)]"
        >
          <ArrowLeft className="h-4 w-4" />
          返回应用
        </button>
        <h1 className="px-2 text-ui-heading-sm font-semibold leading-tight text-foreground">设置</h1>
      </div>

      <div className="px-3 pb-1">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && firstMatch) {
                event.preventDefault();
                onTabChange(firstMatch.id);
              } else if (event.key === 'Escape' && query) {
                event.preventDefault();
                setQuery('');
              }
            }}
            placeholder="搜索"
            aria-label="搜索设置"
            // Codex 的搜索框:药丸形、无描边、墨色 6% 的底色。
            className="h-9 w-full rounded-full bg-[hsl(var(--foreground)/0.06)] pl-9 pr-9 text-ui-compact text-foreground outline-none transition-colors duration-fast placeholder:text-foreground-tertiary hover:bg-[hsl(var(--foreground)/0.08)] focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:appearance-none"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="清除搜索"
              className="absolute right-2.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors duration-fast hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {/* 窄屏抽屉里条目会超出视口高度,主分组必须能独立滚动。 */}
      <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
        {visibleGroups.map((group) => (
          <div key={group.key}>
            {/* 分组标题不是标题元素:它归组而非分层级,页面的大标题在右侧内容区。 */}
            <div className="px-2 pb-1 pt-3 text-ui-compact font-medium text-muted-foreground">
              {group.label}
            </div>
            <div className="space-y-0.5">{group.tabs.map(renderNavItem)}</div>
          </div>
        ))}
        {visibleGroups.length === 0 ? (
          <p className="px-2 py-3 text-ui-compact text-muted-foreground">未找到结果</p>
        ) : null}
      </nav>
    </div>
  );
}

/**
 * 设置内容区 —— 页头 + 分页正文。
 *
 * 标题用大档(Codex 的设置页标题是 32px 的 heading-xl,我们取刻度里最接近的一档),
 * 并且**不吸顶**:Codex 的标题随内容滚走,滚动位置由内容本身表达。
 */
export function SettingsContent({ activeTab }: SettingsContentProps) {
  const activeTabDef = allTabs.find((tab) => tab.id === activeTab);
  const activeLabel = activeTabDef?.label ?? '设置';
  const activeDescription = activeTabDef?.description;

  return (
    <section className="min-w-0 flex-1 overflow-auto bg-[hsl(var(--background))]">
      {/* 手机/窄屏:48px 的桌面内边距会把内容压到 300px 以内,逐级收敛。 */}
      <header className="mx-auto w-full max-w-5xl px-4 pt-6 sm:px-6 sm:pt-8 lg:px-12 lg:pt-10">
        <h2 className="text-ui-heading-lg font-semibold tracking-tight text-foreground">{activeLabel}</h2>
        {activeDescription && (
          <p className="mt-1.5 text-ui-compact text-muted-foreground">{activeDescription}</p>
        )}
      </header>
      {/* @container:让面板按「内容区实际宽度」而不是视口宽度做自适应
          (侧边栏可拖拽改宽,视口断点会算错)。 */}
      <div className="@container mx-auto w-full max-w-5xl px-4 pb-6 pt-6 sm:px-6 sm:pb-8 sm:pt-8 lg:px-12 lg:pb-10 lg:pt-8">
        {activeTab === 'general' && <GeneralSettings />}
        {activeTab === 'appearance' && <ThemeToggle />}
        {activeTab === 'shortcuts' && <KeyboardShortcutsSettings />}
        {activeTab === 'provider' && <ProviderConfigPanel />}
        {activeTab === 'image-recognition' && <ImageRecognitionSettings />}
        {activeTab === 'browser-control' && <BrowserControlSettings />}
        {activeTab === 'computer-use' && <ComputerUseSettings />}
        {activeTab === 'agent-runtime' && <AgentRuntimeSettingsPanel />}
        {activeTab === 'mcp' && <McpSettingsPanel />}
        {activeTab === 'skills' && <SkillsSettingsPanel />}
        {activeTab === 'git' && <GitSettings />}
        {activeTab === 'usage' && <UsageStatistics />}
        {activeTab === 'archive' && <ArchivedSessionsPanel />}
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
      <SettingsContent activeTab={activeTab} />
    </div>
  );
}
