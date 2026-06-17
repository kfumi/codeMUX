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
          'rounded-lg border border-border/60 bg-popover p-1.5 shadow-[0_18px_44px_-26px_hsl(var(--foreground)/0.36)]',
      )}
      trigger={
        <button
          type="button"
          aria-label={current.label}
          className={cn(
            'inline-flex items-center text-sm text-foreground/84 transition-all duration-200',
            isFloating
              ? 'group relative justify-center rounded-xl border border-border/55 bg-card p-4 shadow-[0_14px_34px_-26px_hsl(var(--foreground)/0.26)] hover:border-[hsl(var(--primary)/0.22)] hover:shadow-[0_18px_42px_-28px_hsl(var(--foreground)/0.32)]'
              : 'gap-2 rounded-2xl border border-border/50 bg-muted/30 px-3 py-1.5 hover:border-border hover:bg-muted/45',
          )}
        >
          {isFloating ? (
            <>
              <span className="relative inline-flex h-16 w-16 items-center justify-center rounded-lg border border-border/45 bg-muted/38">
                <AgentBrandIcon agent={current} size="hero" />
              </span>
              <span className="absolute bottom-1 right-1 inline-flex h-5 w-5 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground shadow-sm">
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
