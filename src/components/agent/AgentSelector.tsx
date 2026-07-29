import { ChevronDown } from 'lucide-react';

import { cn } from '../../lib/utils';
import { AGENT_REGISTRY, getAgentDefinition } from '../../types/agentRegistry';
import type { AgentKind } from '../../types/session';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../ui/dropdown-menu';
import { AgentBrandIcon } from './AgentBrandIcon';

const SELECTABLE_AGENTS = AGENT_REGISTRY.filter((agent) => agent.capabilities.length > 0);

interface AgentSelectorProps {
  value: AgentKind;
  onChange: (value: AgentKind) => void;
  variant?: 'inline' | 'floating' | 'hero';
}

export function AgentSelector({ value, onChange, variant = 'inline' }: AgentSelectorProps) {
  const current = getAgentDefinition(value) ?? SELECTABLE_AGENTS[0];

  if (!current) {
    return null;
  }

  const isFloating = variant === 'floating';
  const isHero = variant === 'hero';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={current.label}
          className={cn(
          'inline-flex items-center text-sm text-foreground/84 transition-all duration-200',
          isFloating
            ? 'group relative justify-center rounded-lg border border-border/60 bg-card p-4 shadow-[0_14px_34px_-26px_hsl(var(--surface-shadow-strong)/0.26)] hover:border-[hsl(var(--primary)/0.28)] hover:shadow-[0_18px_42px_-28px_hsl(var(--surface-shadow-strong)/0.32),0_0_0_3px_hsl(var(--primary)/0.06)]'
            : isHero
            ? 'group relative justify-center'
            : 'gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-1.5 hover:border-border hover:bg-muted/55',
          )}
        >
          {isFloating ? (
            <>
              <span className="relative inline-flex h-16 w-16 items-center justify-center rounded-md border border-border/55 bg-muted/42 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)]">
                <AgentBrandIcon agent={current} size="hero" />
              </span>
              <span className="absolute bottom-1 right-1 inline-flex h-5 w-5 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground shadow-sm transition-colors group-hover:text-foreground">
                <ChevronDown className="h-3 w-3" />
              </span>
            </>
          ) : isHero ? (
            <>
              <span className="relative inline-flex h-18 w-18 items-center justify-center rounded-xl">
                <AgentBrandIcon agent={current} size="hero" />
              </span>
              <span className="absolute bottom-0 right-0 inline-flex h-6 w-6 items-center justify-center rounded-full border border-border/50 bg-background text-muted-foreground shadow-sm transition-colors group-hover:text-foreground group-hover:border-foreground/20">
                <ChevronDown className="h-3.5 w-3.5" />
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
      </DropdownMenuTrigger>
      <DropdownMenuContent className={cn(
        (isFloating || isHero) &&
          'rounded-lg border border-border/60 bg-popover p-1.5 shadow-[0_18px_44px_-26px_hsl(var(--surface-shadow-strong)/0.36)]',
      )}>
        {SELECTABLE_AGENTS.map((agent) => (
          <DropdownMenuItem key={agent.kind} onClick={() => onChange(agent.kind)}>
            <div className={cn(
              'flex min-w-45 items-center gap-2',
              agent.kind === value && 'text-foreground'
            )}>
              <AgentBrandIcon agent={agent} size="sm" />
              <span className="font-medium text-foreground">{agent.label}</span>
              {agent.kind === value && <span className="ml-auto text-foreground/80">✓</span>}
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
