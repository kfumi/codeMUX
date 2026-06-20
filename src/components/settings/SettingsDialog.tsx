import { useState } from 'react';
import { Archive, Bot, FileText, Info, Palette, Plug, Puzzle, Server, Settings } from 'lucide-react';

import { cn } from '../../lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { AboutSettings } from './AboutSettings';
import { AgentSettingsPanel } from './AgentSettings';
import { ArchivedSessionsPanel } from './ArchivedSessionsPanel';
import { GeneralSettings } from './GeneralSettings';
import { LogSettings } from './LogSettings';
import { McpSettingsPanel } from './McpSettings';
import { ProviderConfigPanel } from './ProviderConfig';
import { SkillsSettingsPanel } from './SkillsSettings';
import { ThemeToggle } from './ThemeToggle';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SettingsTab = 'general' | 'appearance' | 'provider' | 'agents' | 'mcp' | 'skills' | 'archive' | 'logs' | 'about';

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');

  const tabs = [
    { id: 'general' as const, label: '常规', icon: Settings },
    { id: 'appearance' as const, label: '外观', icon: Palette },
    { id: 'provider' as const, label: '提供商配置', icon: Plug },
    { id: 'agents' as const, label: '智能体', icon: Bot },
    { id: 'mcp' as const, label: 'MCP', icon: Server },
    { id: 'skills' as const, label: 'Skills', icon: Puzzle },
    { id: 'archive' as const, label: '已归档对话', icon: Archive },
  ];

  const bottomTabs = [
    { id: 'logs' as const, label: '日志', icon: FileText },
    { id: 'about' as const, label: '关于', icon: Info },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-155 flex-col overflow-hidden border-0 bg-card p-0 shadow-[0_26px_70px_-42px_hsl(var(--foreground)/0.55)] dark:shadow-[0_26px_70px_-42px_hsl(var(--surface-shadow-strong)/0.92)] sm:max-w-245">
        <DialogDescription className="sr-only">
          Configure providers, agents, MCP, skills, appearance, and general application preferences.
        </DialogDescription>
        <div className="flex flex-1 overflow-hidden bg-card">
          <div className="flex w-52 shrink-0 flex-col border-r border-border/65 bg-muted/38 dark:bg-muted/24">
            <DialogHeader className="px-5 pb-4 pt-4">
              <DialogTitle className="text-sm font-semibold text-foreground/90">设置</DialogTitle>
            </DialogHeader>
            <nav className="flex-1 space-y-1 px-3">
              {tabs.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className={cn(
                    'relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[13px] transition-all duration-200',
                    activeTab === id
                      ? 'border border-border/80 bg-background font-medium text-foreground shadow-[0_10px_28px_-22px_hsl(var(--foreground)/0.34)]'
                      : 'text-foreground/72 hover:bg-background/68 hover:text-foreground',
                  )}
                >
                  <Icon className={cn('h-4 w-4 transition-colors', activeTab === id ? 'text-primary' : 'text-foreground/50')} />
                  {label}
                </button>
              ))}
            </nav>
            {/* Bottom pinned tabs */}
            <nav className="space-y-1 border-t border-border/50 px-3 pt-3 pb-3">
              {bottomTabs.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className={cn(
                    'relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[13px] transition-all duration-200',
                    activeTab === id
                      ? 'border border-border/80 bg-background font-medium text-foreground shadow-[0_10px_28px_-22px_hsl(var(--foreground)/0.34)]'
                      : 'text-foreground/72 hover:bg-background/68 hover:text-foreground',
                  )}
                >
                  <Icon className={cn('h-4 w-4 transition-colors', activeTab === id ? 'text-primary' : 'text-foreground/50')} />
                  {label}
                </button>
              ))}
            </nav>
          </div>

          <div className="flex-1 overflow-auto bg-background p-6">
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
      </DialogContent>
    </Dialog>
  );
}
