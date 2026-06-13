import claudeSvg from '@lobehub/icons-static-svg/icons/claude-color.svg?raw';
import openAiSvg from '@lobehub/icons-static-svg/icons/openai.svg?raw';
import geminiSvg from '@lobehub/icons-static-svg/icons/geminicli-color.svg?raw';
import opencodeSvg from '@lobehub/icons-static-svg/icons/opencode.svg?raw';

import { cn } from '../../lib/utils';
import type { AgentDefinition } from '../../types/agentRegistry';

const AGENT_ICON_COLORS: Partial<Record<AgentDefinition['icon'], string>> = {
  claude: 'text-foreground',
  codex: 'text-foreground',
  gemini: 'text-foreground',
  opencode: 'text-foreground',
};

const AGENT_BRAND_SVGS: Partial<Record<AgentDefinition['icon'], string>> = {
  claude: claudeSvg,
  codex: openAiSvg,
  gemini: geminiSvg,
  opencode: opencodeSvg,
};

interface AgentBrandIconProps {
  agent: AgentDefinition;
  size?: 'sm' | 'md' | 'hero';
}

export function AgentBrandIcon({ agent, size = 'sm' }: AgentBrandIconProps) {
  const brandSvg = AGENT_BRAND_SVGS[agent.icon];
  // iconClassName no longer needed — SVG dimensions are set inline
  const wrapperClassName =
    size === 'hero'
      ? 'inline-flex h-10 w-10 shrink-0 items-center justify-center text-foreground'
      : size === 'md'
        ? 'inline-flex h-5 w-5 shrink-0 items-center justify-center text-foreground'
        : 'inline-flex h-4 w-4 shrink-0 items-center justify-center text-foreground';

  if (brandSvg) {
    // Strip inline styles/size, inject display:block + explicit px dimensions
    const svgSize = size === 'hero' ? 40 : size === 'md' ? 20 : 16;
    const cleanedSvg = brandSvg
      .replace(/(<svg\b[^>]*\bstyle=")[^"]*(")/, '$1display:block$2')
      .replace(/(<svg\b[^>]*) width="[^"]*"/, '$1')
      .replace(/(<svg\b[^>]*) height="[^"]*"/, '$1')
      .replace(/<svg\b/, `<svg width="${svgSize}" height="${svgSize}"`);

    return (
      <span
        className={cn(wrapperClassName, AGENT_ICON_COLORS[agent.icon])}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: cleanedSvg }}
      />
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
