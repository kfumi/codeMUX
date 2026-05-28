import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { ThemeToggle } from './ThemeToggle';
import { ProviderConfig } from './ProviderConfig';
import { Settings, Palette, Plug } from 'lucide-react';
import { cn } from '../../lib/utils';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SettingsTab = 'general' | 'appearance' | 'provider';

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');

  const tabs = [
    { id: 'general' as SettingsTab, label: '常规', icon: Settings },
    { id: 'appearance' as SettingsTab, label: '外观', icon: Palette },
    { id: 'provider' as SettingsTab, label: '供应商配置', icon: Plug },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] p-0">
        <div className="flex">
          {/* Left navigation */}
          <div className="w-40 border-r p-2">
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

          {/* Right content */}
          <div className="flex-1 p-4">
            {activeTab === 'general' && (
              <div className="space-y-4">
                <h3 className="font-medium">常规设置</h3>
                <p className="text-sm text-muted-foreground">管理应用的基本设置。</p>
              </div>
            )}
            {activeTab === 'appearance' && <ThemeToggle />}
            {activeTab === 'provider' && <ProviderConfig />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
