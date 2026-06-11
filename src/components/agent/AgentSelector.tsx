import { ChevronDown } from 'lucide-react';

import { cn } from '../../lib/utils';
import { AGENT_REGISTRY, getAgentDefinition } from '../../types/agentRegistry';
import type { AgentKind } from '../../types/session';
import { DropdownMenu, DropdownMenuItem } from '../ui/dropdown-menu';
import { AgentBrandIcon } from './AgentBrandIcon';

const SELECTABLE_AGENTS = AGENT_REGISTRY.filter((agent) => agent.capabilities.length > 0);

interface AgentSelectorProps {
  value: AgentKind;
  onChange: (value: AgentKind) => void;
  variant?: 'inline' | 'floating';
}

export function AgentSelector({ value, onChange, variant = 'inline' }: AgentSelectorProps) {
  const current = getAgentDefinition(value) ?? SELECTABLE_AGENTS[0];

  if (!current) {
    return null;
  }

  const isFloating = variant === 'floating';

  return (
    <DropdownMenu
      panelClassName={cn(
        isFloating &&
          'rounded-[20px] border border-border/45 bg-[hsl(var(--popover))]/94 p-2 shadow-[0_24px_60px_-28px_hsl(var(--foreground)/0.42)] backdrop-blur-xl',
      )}
      trigger={
        <button
          type="button"
          aria-label={current.label}
          className={cn(
            'inline-flex items-center text-sm text-foreground/84 transition-all duration-200',
            isFloating
              ? 'group relative justify-center rounded-[32px] border border-border/35 bg-[hsl(var(--background))]/72 p-4 shadow-[0_18px_40px_-26px_hsl(var(--foreground)/0.24)] backdrop-blur-xl hover:border-[hsl(var(--primary)/0.2)] hover:shadow-[0_22px_48px_-24px_hsl(var(--foreground)/0.3)]'
              : 'gap-2 rounded-2xl border border-border/50 bg-muted/30 px-3 py-1.5 hover:border-border hover:bg-muted/45',
          )}
        >
          {isFloating ? (
            <>
              <span className="absolute inset-3 rounded-full bg-[radial-gradient(circle,hsl(var(--primary)/0.16),transparent_70%)] blur-2xl" />
              <span className="relative inline-flex h-20 w-20 items-center justify-center rounded-[28px] bg-[linear-gradient(180deg,hsl(var(--background))/0.92,hsl(var(--muted))/0.55)]">
                <AgentBrandIcon agent={current} size="hero" />
              </span>
              <span className="absolute bottom-1.5 right-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full border border-border/60 bg-background/94 text-muted-foreground shadow-[0_8px_22px_-16px_hsl(var(--foreground)/0.45)]">
                <ChevronDown className="h-3 w-3" />
              </span>
            </>
          ) : (
            <>
              <AgentBrandIcon agent={current} size="sm" />
              <span className="hidden text-sm font-medium text-foreground sm:block">
                {current.label}
              </span>
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </>
          )}
        </button>
      }
    >
      {SELECTABLE_AGENTS.map((agent) => (
        <DropdownMenuItem key={agent.kind} onClick={() => onChange(agent.kind)}>
          <div className={cn(
            'flex min-w-[180px] items-center gap-2',
            agent.kind === value && 'text-foreground'
          )}>
            <AgentBrandIcon agent={agent} size="sm" />
            <span className="font-medium text-foreground">{agent.label}</span>
            {agent.kind === value && <span className="ml-auto text-foreground/80">✓</span>}
          </div>
        </DropdownMenuItem>
      ))}
    </DropdownMenu>
  );
}
