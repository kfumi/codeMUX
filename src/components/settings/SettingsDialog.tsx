import { useState } from 'react';
import { Bot, Palette, Plug, Puzzle, Server, Settings } from 'lucide-react';

import { cn } from '../../lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { AgentSettingsPanel } from './AgentSettings';
import { McpSettingsPanel } from './McpSettings';
import { ProviderConfigPanel } from './ProviderConfig';
import { SkillsSettingsPanel } from './SkillsSettings';
import { ThemeToggle } from './ThemeToggle';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SettingsTab = 'general' | 'appearance' | 'provider' | 'agents' | 'mcp' | 'skills';

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('provider');

  const tabs = [
    { id: 'provider' as const, label: '提供商配置', icon: Plug },
    { id: 'agents' as const, label: '智能体', icon: Bot },
    { id: 'mcp' as const, label: 'MCP', icon: Server },
    { id: 'skills' as const, label: 'Skills', icon: Puzzle },
    { id: 'appearance' as const, label: '外观', icon: Palette },
    { id: 'general' as const, label: '常规', icon: Settings },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-155 flex-col overflow-hidden border-border/80 bg-card p-0 sm:max-w-245">
        <DialogDescription className="sr-only">
          Configure providers, agents, MCP, skills, appearance, and general application preferences.
        </DialogDescription>
        <div className="flex flex-1 overflow-hidden bg-card">
          <div className="w-52 shrink-0 border-r border-border/65 bg-muted/38 p-3 dark:bg-muted/24">
            <DialogHeader className="px-2 pb-4 pt-1">
              <DialogTitle className="text-sm font-semibold text-foreground/90">设置</DialogTitle>
            </DialogHeader>
            <nav className="space-y-1">
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
          </div>

          <div className="flex-1 overflow-auto bg-background p-6">
            {activeTab === 'general' && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-foreground/90">常规设置</h3>
                <p className="text-sm leading-relaxed text-foreground/68">这里会放应用级的通用偏好设置。</p>
              </div>
            )}
            {activeTab === 'appearance' && <ThemeToggle />}
            {activeTab === 'provider' && <ProviderConfigPanel />}
            {activeTab === 'agents' && <AgentSettingsPanel />}
            {activeTab === 'mcp' && <McpSettingsPanel />}
            {activeTab === 'skills' && <SkillsSettingsPanel />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
