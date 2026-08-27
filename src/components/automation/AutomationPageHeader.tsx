import type { ReactNode } from 'react';

import { ArrowLeft } from 'lucide-react';

import { cn } from '../../lib/utils';
import { Button } from '../ui/button';

export interface AutomationTab {
  id: string;
  label: string;
}

interface AutomationPageHeaderProps {
  title: string;
  description?: string;
  onBack?: () => void;
  actions?: ReactNode;
  toolbar?: ReactNode;
  tabs?: AutomationTab[];
  activeTab?: string;
  onTabChange?: (tabId: string) => void;
}

export function AutomationPageHeader({
  title,
  description,
  onBack,
  actions,
  toolbar,
  tabs,
  activeTab,
  onTabChange,
}: AutomationPageHeaderProps) {
  const showTabs = tabs && tabs.length > 0;

  return (
    <header className="shrink-0 border-b border-border/45 bg-[hsl(var(--background)/0.88)] backdrop-blur-md">
      <div className="flex items-start gap-2 px-6 pt-4">
        {onBack && (
          <Button
            variant="ghost"
            size="icon"
            className="mt-0.5 h-8 w-8 shrink-0 text-muted-foreground"
            onClick={onBack}
            aria-label="返回"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-ui-heading-sm font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {description && (
            <p className="mt-1 max-w-3xl text-ui-body leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
            {actions}
          </div>
        )}
      </div>

      {toolbar && (
        <div className="px-6 pb-3 pt-1">
          {toolbar}
        </div>
      )}

      {showTabs && (
        <div className="mt-3 px-6 pb-3">
          <div className="inline-flex rounded-lg border border-border/60 bg-muted/25 p-0.5">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onTabChange?.(tab.id)}
                  className={cn(
                    'rounded-md px-3.5 py-1.5 text-ui-body transition-colors',
                    isActive
                      ? 'bg-background font-medium text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </header>
  );
}
