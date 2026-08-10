import anthropicSvg from '@lobehub/icons-static-svg/icons/anthropic.svg?raw';
import openAiSvg from '@lobehub/icons-static-svg/icons/openai.svg?raw';
import deepseekSvg from '@lobehub/icons-static-svg/icons/deepseek-color.svg?raw';
import openrouterSvg from '@lobehub/icons-static-svg/icons/openrouter.svg?raw';
import siliconcloudSvg from '@lobehub/icons-static-svg/icons/siliconcloud-color.svg?raw';
import zhipuSvg from '@lobehub/icons-static-svg/icons/zhipu-color.svg?raw';
import opencodeSvg from '@lobehub/icons-static-svg/icons/opencode.svg?raw';
import moonshotSvg from '@lobehub/icons-static-svg/icons/moonshot.svg?raw';
import xiaomimimoSvg from '@lobehub/icons-static-svg/icons/xiaomimimo.svg?raw';

import { cn } from '@/lib/utils';

type BrandMeta = {
  label: string;
  svg?: string;
  short?: string;
  className?: string;
};

const BRANDS: Record<string, BrandMeta> = {
  anthropic: { label: 'Anthropic', svg: anthropicSvg },
  openai: { label: 'OpenAI', svg: openAiSvg },
  deepseek: { label: '深度求索', svg: deepseekSvg },
  openrouter: { label: 'OpenRouter', svg: openrouterSvg },
  siliconflow: { label: '硅基流动', svg: siliconcloudSvg },
  zhipu: { label: '智谱', svg: zhipuSvg },
  moonshot: { label: '月之暗面', svg: moonshotSvg },
  mimo: { label: 'Xiaomi MiMo', svg: xiaomimimoSvg },
  'opencode-go': { label: 'OpenCode Go', svg: opencodeSvg },
  custom: {
    label: '自定义',
    short: '+',
    className: 'bg-slate-600 text-white',
  },
};

function cleanSvg(svg: string, size: number): string {
  return svg
    .replace(/(<svg\b[^>]*\bstyle=")[^"]*(")/, '$1display:block$2')
    .replace(/(<svg\b[^>]*) width="[^"]*"/, '$1')
    .replace(/(<svg\b[^>]*) height="[^"]*"/, '$1')
    .replace(/<svg\b/, `<svg width="${size}" height="${size}" style="display:block"`);
}

function initialFromName(name: string | undefined, fallback = '?'): string {
  const trimmed = name?.trim();
  if (!trimmed) return fallback;
  return trimmed.charAt(0).toUpperCase();
}

export function providerBrandMeta(templateId: string | null | undefined): BrandMeta {
  if (!templateId) return BRANDS.custom;
  return (
    BRANDS[templateId] ?? {
      label: templateId,
      short: templateId.slice(0, 2).toUpperCase(),
      className: 'bg-slate-600 text-white',
    }
  );
}

export function providerDisplayName(
  name: string,
  templateId: string | null | undefined,
): string {
  const brand = templateId ? BRANDS[templateId] : undefined;
  if (brand && (name === brand.label || !name.trim() || name === templateId)) {
    return brand.label;
  }
  if (
    brand
    && [
      'DeepSeek',
      'OpenAI',
      'Anthropic',
      'OpenRouter',
      'OpenCode Go',
      'Moonshot',
      'MiMo',
      'Xiaomi MiMo',
    ].includes(name)
  ) {
    return brand.label;
  }
  return name;
}

export function ProviderBrandIcon({
  templateId,
  name,
  className,
  size = 20,
}: {
  templateId?: string | null;
  name?: string;
  className?: string;
  size?: number;
}) {
  const brand = providerBrandMeta(templateId);

  if (brand.svg) {
    return (
      <span
        aria-hidden
        className={cn(
          'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/60 text-foreground',
          className,
        )}
        dangerouslySetInnerHTML={{ __html: cleanSvg(brand.svg, size) }}
      />
    );
  }

  const short = name?.trim()
    ? initialFromName(name)
    : (brand.short ?? initialFromName(brand.label));

  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold tracking-tight',
        brand.className ?? 'bg-slate-600 text-white',
        className,
      )}
    >
      {short}
    </span>
  );
}
