import { useId, type ReactNode } from 'react';

import type { Theme } from '../../types/provider';
import { cn } from '../../lib/utils';
import { TooltipHint } from '../ui/tooltip';
import { SettingsRow } from './SettingsRow';

/**
 * 模式行 —— 一排三张应用窗口缩略图,画法与 Codex 的 80×60 插图逐笔对齐。
 *
 * 三张卡分别是:跟随系统(左浅右深对半)、浅色、深色。系统卡不画「一扇按当前
 * 解析结果上色的窗」:Codex 是左右两半并排,一眼就能看出「跟随系统 = 两者之间」,
 * 而这正是这一行要传达的信息。
 *
 * 几何全部照抄 Codex(窗口 8..72 / 8..52、标题行 y12、正文行 y18/22/26、
 * 强调行 y32/36、输入条 y41.75..48.25、侧栏 8..20):
 * 这些数字不是审美选择,是缩到 80×60 后仍然分辨得出「这是自己应用的样子」的
 * 唯一一组,挪动任何一个都会在这么小的尺寸上糊掉。
 */

/** 缩略图配色 —— 画的是「一扇窗口的样子」,不是真实表面,所以用字面量而不是主题
 * token:一扇浅色窗口在深色主题下也必须是浅色的。强调色的部分走 `currentColor`,
 * 由外层 `text-primary` 注入,跟着用户选的强调色走。 */
const SHOT = {
  light: {
    /** 窗口外的桌面底 */
    desktop: '#F4F4F4',
    /** 窗口内的卡片 */
    window: '#FFFFFF',
    /** 发丝描边:卡框、输入条 */
    hairline: 'rgb(0 0 0 / 0.1)',
    /** 正文占位行 */
    line: 'rgb(13 13 13 / 0.1)',
    /** 侧栏 */
    sidebar: 'rgb(0 0 0 / 0.03)',
    /** 标题位的产品角标 */
    mark: 'rgb(13 13 13 / 0.15)',
    /** 整张缩略图的外框 */
    frame: 'rgb(0 0 0 / 0.1)',
  },
  dark: {
    desktop: '#262626',
    window: '#0D0D0D',
    hairline: 'rgb(255 255 255 / 0.1)',
    line: 'rgb(255 255 255 / 0.3)',
    sidebar: 'rgb(255 255 255 / 0.2)',
    mark: 'rgb(255 255 255 / 0.2)',
    frame: 'rgb(0 0 0 / 0.4)',
  },
} as const;

/**
 * 一扇窗口的示意画,画布 80×60(与 Codex 的插图同尺寸,缩略图正好 80×60px)。
 *
 * `half` 是「系统」卡用的:viewBox 收成 0 0 40 60,只露出左半边 —— Codex 也是
 * 这么做的(它那两张半幅插图内部仍是一条 80 宽的底,靠视口裁掉右半)。
 */
function AppWindowShot({ variant, half = false }: { variant: 'light' | 'dark'; half?: boolean }) {
  const c = SHOT[variant];
  // 同页会同时挂好几张插图,滤镜 id 必须逐实例唯一(useId 的冒号在 url(#…)
  // 里不保险,去掉)。
  const uid = useId().replace(/:/g, '');
  const windowShadow = `shot-window-${uid}`;

  return (
    <svg
      viewBox={`0 0 ${half ? 40 : 80} 60`}
      className="block h-full w-full text-primary"
      fill="none"
      aria-hidden
    >
      <rect width={80} height={60} rx={half ? 0 : 8} fill={c.desktop} />

      {/* 窗口内的卡片:一层双层投影把它从桌面上托起来 */}
      <filter
        id={windowShadow}
        filterUnits="userSpaceOnUse"
        x={-4}
        y={0}
        width={88}
        height={70}
      >
        <feDropShadow dx={0} dy={4} stdDeviation={2.5} floodColor="#000000" floodOpacity={0.1} />
        <feDropShadow dx={0} dy={10} stdDeviation={6.5} floodColor="#000000" floodOpacity={0.1} />
      </filter>
      <g filter={`url(#${windowShadow})`}>
        <rect x={8} y={8} width={64} height={44} rx={4} fill={c.window} />
        <rect
          x={7.75}
          y={7.75}
          width={64.5}
          height={44.5}
          rx={4.25}
          stroke={c.hairline}
          strokeWidth={0.5}
        />
      </g>

      {/* 标题行 + 正文占位行 */}
      <rect x={38} y={12} width={30} height={2} rx={1} fill="currentColor" />
      <rect x={24} y={18} width={30} height={2} rx={1} fill={c.line} />
      <rect x={24} y={22} width={18} height={2} rx={1} fill={c.line} />
      <rect x={24} y={26} width={36} height={2} rx={1} fill={c.line} />

      {/* 回答段落的两行与输入条、发送点 */}
      <rect x={29} y={32} width={39} height={2} rx={1} fill="currentColor" />
      <rect x={45} y={36} width={23} height={2} rx={1} fill="currentColor" />
      <rect
        x={23.75}
        y={41.75}
        width={44.5}
        height={6.5}
        rx={3.25}
        stroke={c.hairline}
        strokeWidth={0.5}
      />
      <circle cx={65} cy={45} r={2} fill="currentColor" />

      {/* 侧栏 —— Codex 的原图会把侧栏右缘再压一道 0.5px 投影,这个尺寸下看不出。 */}
      <path
        d="M8 12C8 9.79086 9.79086 8 12 8H20V52H12C9.79086 52 8 50.2091 8 48V12Z"
        fill={c.sidebar}
      />

      {/* 标题位原本是 Codex 自己的产品角标,我们不画别家的商标,换成一枚中性的
          圆点占住同一个位置(14,14 / r3)。 */}
      <circle cx={14} cy={14} r={3} fill={c.mark} />

      {half ? null : (
        <rect
          x={0.25}
          y={0.25}
          width={79.5}
          height={59.5}
          rx={7.75}
          stroke={c.frame}
          strokeWidth={0.5}
        />
      )}
    </svg>
  );
}

/** 系统卡:浅色半扇 + 深色半扇并排,合成一整张 80×60。 */
function SplitShot() {
  return (
    <span className="grid h-full w-full grid-cols-2">
      <AppWindowShot variant="light" half />
      <AppWindowShot variant="dark" half />
    </span>
  );
}

/** 模式选择:一排应用窗口缩略图,选中项套主色描边。 */
function ModeThumb({
  label,
  selected,
  onSelect,
  children,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <TooltipHint content={label}>
      <label className="group block min-w-0 cursor-pointer">
        <input
          type="radio"
          name="appearance-mode"
          aria-label={label}
          checked={selected}
          onChange={onSelect}
          className="peer sr-only"
        />
        <span className="relative isolate block aspect-4/3 w-full overflow-hidden rounded-md peer-focus-visible:ring-2 peer-focus-visible:ring-ring/60">
          {children}
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-0 rounded-md border-2 transition-colors duration-fast ease-motion-out',
              selected ? 'border-primary' : 'border-border group-hover:border-foreground/25',
            )}
          />
        </span>
      </label>
    </TooltipHint>
  );
}

/** 顺序照 Codex:跟随系统、浅色、深色。 */
const MODE_OPTIONS: { theme: Theme; label: string }[] = [
  { theme: 'System', label: '跟随系统' },
  { theme: 'Light', label: '浅色' },
  { theme: 'Dark', label: '深色' },
];

export function ModeRow({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  return (
    <SettingsRow
      label="模式"
      // 一排缩略图 3×80 + 2×16 = 272px,比设置行默认的 240px 上限宽。
      controlClassName="sm:max-w-none"
      control={
        <div role="radiogroup" aria-label="模式" className="grid w-68 max-w-full grid-cols-3 gap-4">
          {MODE_OPTIONS.map(({ theme: option, label }) => (
            <ModeThumb
              key={option}
              label={label}
              selected={theme === option}
              onSelect={() => onChange(option)}
            >
              {option === 'System' ? (
                <SplitShot />
              ) : (
                <AppWindowShot variant={option === 'Dark' ? 'dark' : 'light'} />
              )}
            </ModeThumb>
          ))}
        </div>
      }
    />
  );
}
