import { useState } from 'react';
import { Settings, Palette, Plug, Server, Puzzle } from 'lucide-react';

import { cn } from '../../lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { McpSettingsPanel } from './McpSettings';
import { ProviderConfigPanel } from './ProviderConfig';
import { SkillsSettingsPanel } from './SkillsSettings';
import { ThemeToggle } from './ThemeToggle';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SettingsTab = 'general' | 'appearance' | 'provider' | 'mcp' | 'skills';

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('provider');

  const tabs = [
    { id: 'provider' as SettingsTab, label: '供应商配置', icon: Plug },
    { id: 'mcp' as SettingsTab, label: 'MCP', icon: Server },
    { id: 'skills' as SettingsTab, label: 'Skills', icon: Puzzle },
    { id: 'appearance' as SettingsTab, label: '外观', icon: Palette },
    { id: 'general' as SettingsTab, label: '常规', icon: Settings },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] h-[520px] p-0 flex flex-col overflow-hidden">
        <div className="flex flex-1 overflow-hidden">
          <div className="w-44 shrink-0 border-r border-border/40 bg-muted/20 p-2">
            <DialogHeader className="p-2 pb-3">
              <DialogTitle className="text-sm font-semibold">设置</DialogTitle>
            </DialogHeader>
            <nav className="space-y-0.5">
              {tabs.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className={cn(
                    'relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-all duration-200',
                    activeTab === id
                      ? 'bg-background text-foreground shadow-sm font-medium'
                      : 'text-foreground/74 hover:bg-muted/40 hover:text-foreground',
                  )}
                >
                  <Icon
                    className={cn(
                      'h-4 w-4 transition-colors',
                      activeTab === id ? 'text-[hsl(var(--primary))]' : '',
                    )}
                  />
                  {label}
                </button>
              ))}
            </nav>
          </div>

          <div className="flex-1 overflow-auto p-5">
            {activeTab === 'general' && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold">常规设置</h3>
                <p className="text-sm text-foreground/74">管理应用的基本设置。</p>
              </div>
            )}
            {activeTab === 'appearance' && <ThemeToggle />}
            {activeTab === 'provider' && <ProviderConfigPanel />}
            {activeTab === 'mcp' && <McpSettingsPanel />}
            {activeTab === 'skills' && <SkillsSettingsPanel />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
