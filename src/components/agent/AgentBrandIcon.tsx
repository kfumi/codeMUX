import claudeSvg from '@lobehub/icons-static-svg/icons/claude-color.svg?raw';
import openAiSvg from '@lobehub/icons-static-svg/icons/openai.svg?raw';
import geminiSvg from '@lobehub/icons-static-svg/icons/geminicli-color.svg?raw';
import opencodeSvg from '@lobehub/icons-static-svg/icons/opencode.svg?raw';
import piSvg from '@lobehub/icons-static-svg/icons/pi.svg?raw';

import { cn } from '../../lib/utils';
import type { AgentBrandIconName } from '../../lib/agentKind';

const AGENT_ICON_COLORS: Partial<Record<AgentBrandIconName, string>> = {
  claude: 'text-foreground',
  codex: 'text-foreground',
  gemini: 'text-foreground',
  opencode: 'text-foreground',
};

const AGENT_BRAND_SVGS: Partial<Record<AgentBrandIconName, string>> = {
  claude: claudeSvg,
  codex: openAiSvg,
  gemini: geminiSvg,
  opencode: opencodeSvg,
  pi: piSvg,
};

interface AgentBrandIconProps {
  /**
   * 品牌图标标识。过去这里收整个 `AgentDefinition`，但组件只读 `icon` 与 `label`
   * 两个字段 —— 改收标识与回落文案后，调用方不必为了画一个图标构造完整规格。
   */
  brandIcon: AgentBrandIconName;
  /** 没有品牌 SVG 时的字母回落（取前两个字符）。 */
  fallbackLabel?: string;
  size?: 'sm' | 'md' | 'hero';
}

export function AgentBrandIcon({ brandIcon, fallbackLabel = '', size = 'sm' }: AgentBrandIconProps) {
  const brandSvg = AGENT_BRAND_SVGS[brandIcon];
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
        className={cn(wrapperClassName, AGENT_ICON_COLORS[brandIcon])}
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
            : 'h-4 w-4 text-ui-micro',
      )}
      aria-hidden="true"
    >
      {fallbackLabel.slice(0, 2).toUpperCase()}
    </span>
  );
}
