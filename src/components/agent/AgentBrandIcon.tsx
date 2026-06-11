import claudeSvg from '@lobehub/icons-static-svg/icons/claude-color.svg?raw';
import openAiSvg from '@lobehub/icons-static-svg/icons/openai.svg?raw';

import { cn } from '../../lib/utils';
import type { AgentDefinition } from '../../types/agentRegistry';

const AGENT_ICON_COLORS: Partial<Record<AgentDefinition['icon'], string>> = {
  claude: 'text-foreground',
  codex: 'text-foreground',
};

const AGENT_BRAND_SVGS: Partial<Record<AgentDefinition['icon'], string>> = {
  claude: claudeSvg,
  codex: openAiSvg,
};

interface AgentBrandIconProps {
  agent: AgentDefinition;
  size?: 'sm' | 'md' | 'hero';
}

export function AgentBrandIcon({ agent, size = 'sm' }: AgentBrandIconProps) {
  const brandSvg = AGENT_BRAND_SVGS[agent.icon];
  const iconClassName =
    size === 'hero'
      ? 'inline-flex h-10 w-10 leading-none [&>svg]:h-10 [&>svg]:w-10'
      : size === 'md'
        ? 'inline-flex h-5 w-5 leading-none [&>svg]:h-5 [&>svg]:w-5'
        : 'inline-flex h-4 w-4 leading-none [&>svg]:h-4 [&>svg]:w-4';
  const wrapperClassName =
    size === 'hero'
      ? 'inline-flex h-10 w-10 shrink-0 items-center justify-center text-foreground'
      : size === 'md'
        ? 'inline-flex h-5 w-5 shrink-0 items-center justify-center text-foreground'
        : 'inline-flex h-4 w-4 shrink-0 items-center justify-center text-foreground';

  if (brandSvg) {
    return (
      <span
        className={cn(wrapperClassName, AGENT_ICON_COLORS[agent.icon])}
        aria-hidden="true"
      >
        <span
          className={iconClassName}
          dangerouslySetInnerHTML={{ __html: brandSvg }}
        />
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-semibold tracking-[0.12em] text-foreground',
        size === 'hero'
          ? 'h-8 w-8 text-sm'
          : size === 'md'
            ? 'h-5 w-5 text-xs'
            : 'h-4 w-4 text-[10px]',
      )}
      aria-hidden="true"
    >
      {agent.label.slice(0, 2).toUpperCase()}
    </span>
  );
}
