import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { ThemeToggle } from './ThemeToggle';
import { ProviderConfigPanel } from './ProviderConfig';
import { McpSettingsPanel } from './McpSettings';
import { Settings, Palette, Plug, Server } from 'lucide-react';
import { cn } from '../../lib/utils';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SettingsTab = 'general' | 'appearance' | 'provider' | 'mcp';

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('provider');

  const tabs = [
    { id: 'provider' as SettingsTab, label: '供应商配置', icon: Plug },
    { id: 'mcp' as SettingsTab, label: 'MCP', icon: Server },
    { id: 'appearance' as SettingsTab, label: '外观', icon: Palette },
    { id: 'general' as SettingsTab, label: '常规', icon: Settings },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] h-[520px] p-0 flex flex-col">
        <div className="flex flex-1 overflow-hidden">
          <div className="w-40 border-r p-2 shrink-0">
            <DialogHeader className="p-2">
              <DialogTitle className="text-sm">设置</DialogTitle>
            </DialogHeader>
            <nav className="space-y-1 mt-2">
              {tabs.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className={cn(
                    'w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left',
                    activeTab === id ? 'bg-accent text-accent-foreground' : 'hover:bg-accent'
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </nav>
          </div>

          <div className="flex-1 p-4 overflow-auto">
            {activeTab === 'general' && (
              <div className="space-y-4">
                <h3 className="font-medium">常规设置</h3>
                <p className="text-sm text-muted-foreground">管理应用的基本设置。</p>
              </div>
            )}
            {activeTab === 'appearance' && <ThemeToggle />}
            {activeTab === 'provider' && <ProviderConfigPanel />}
            {activeTab === 'mcp' && <McpSettingsPanel />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
