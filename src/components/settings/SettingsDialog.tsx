import { useState } from 'react';
import { Archive, ArrowLeft, Bot, FileText, Info, Palette, Plug, Puzzle, Server, Settings } from 'lucide-react';

import { cn } from '../../lib/utils';
import { AboutSettings } from './AboutSettings';
import { AgentSettingsPanel } from './AgentSettings';
import { ArchivedSessionsPanel } from './ArchivedSessionsPanel';
import { GeneralSettings } from './GeneralSettings';
import { LogSettings } from './LogSettings';
import { McpSettingsPanel } from './McpSettings';
import { ProviderConfigPanel } from './ProviderConfig';
import { SkillsSettingsPanel } from './SkillsSettings';
import { ThemeToggle } from './ThemeToggle';

interface SettingsViewProps {
  onBack: () => void;
}

type SettingsTab = 'general' | 'appearance' | 'provider' | 'agents' | 'mcp' | 'skills' | 'archive' | 'logs' | 'about';

const primaryTabs = [
  { id: 'general' as const, label: '常规', icon: Settings },
  { id: 'appearance' as const, label: '外观', icon: Palette },
  { id: 'provider' as const, label: '供应商配置', icon: Plug },
  { id: 'agents' as const, label: '智能体', icon: Bot },
  { id: 'mcp' as const, label: 'MCP', icon: Server },
  { id: 'skills' as const, label: 'Skills', icon: Puzzle },
  { id: 'archive' as const, label: '已归档对话', icon: Archive },
];

const secondaryTabs = [
  { id: 'logs' as const, label: '日志', icon: FileText },
  { id: 'about' as const, label: '关于', icon: Info },
];

const allTabs = [...primaryTabs, ...secondaryTabs];

export function SettingsView({ onBack }: SettingsViewProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const activeLabel = allTabs.find((tab) => tab.id === activeTab)?.label ?? '设置';

  const renderNavItem = ({ id, label, icon: Icon }: (typeof allTabs)[number]) => (
    <button
      key={id}
      type="button"
      onClick={() => setActiveTab(id)}
      className={cn(
        'relative flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-[13px] transition-colors duration-150',
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
    <div role="main" aria-label="设置" className="flex min-h-0 flex-1 overflow-hidden bg-background">
      <aside className="flex w-62 shrink-0 flex-col border-r border-border/55 bg-[hsl(var(--settings-sidebar-bg))]">
        <div className="px-3 pb-4 pt-4">
          <button
            type="button"
            onClick={onBack}
            className="mb-5 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium text-foreground/70 transition-colors hover:bg-muted/62 hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            返回应用
          </button>
          <div className="px-2">
            <h1 className="text-[26px] font-semibold leading-tight text-foreground">设置</h1>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3">
          {primaryTabs.map(renderNavItem)}
        </nav>

        <nav className="space-y-1 border-t border-border/50 px-3 py-3">
          {secondaryTabs.map(renderNavItem)}
        </nav>
      </aside>

      <section className="min-w-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-6xl px-10 py-8">
          <div className="rounded-lg border border-border/64 bg-card shadow-[0_18px_42px_-38px_hsl(var(--foreground)/0.35)]">
            <div className="border-b border-border/55 px-6 py-4">
              <h2 className="text-[15px] font-semibold text-foreground/90">{activeLabel}</h2>
            </div>
            <div className="p-6">
              {activeTab === 'general' && <GeneralSettings />}
              {activeTab === 'appearance' && <ThemeToggle />}
              {activeTab === 'provider' && <ProviderConfigPanel />}
              {activeTab === 'agents' && <AgentSettingsPanel />}
              {activeTab === 'mcp' && <McpSettingsPanel />}
              {activeTab === 'skills' && <SkillsSettingsPanel />}
              {activeTab === 'archive' && <ArchivedSessionsPanel />}
              {activeTab === 'logs' && <LogSettings />}
              {activeTab === 'about' && <AboutSettings />}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
