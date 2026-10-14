import { useState, type ReactNode } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';

import {
  ACCENTS,
  type AccentKey,
  accentSwatch,
  CODE_FONT_SIZE_MAX,
  CODE_FONT_SIZE_MIN,
  CONTRAST_MAX,
  CONTRAST_MIN,
  type ContentWidthKey,
  RADIUS_PREVIEW,
  type RadiusKey,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
} from '../../lib/appearance';
import { cn } from '../../lib/utils';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { Theme } from '../../types/provider';
import { Button } from '../ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { TooltipHint } from '../ui/tooltip';
import { FontPicker } from './FontPicker';
import { SettingsCard, SettingsRow } from './SettingsRow';

/**
 * 外观设置页。
 *
 * 版式照抄 Codex 的「分组小标题 + 发丝描边卡片 + 左标题右控件」:一行一个设置项,
 * 行与行之间用发丝线分隔,控件一律收到右列(下拉、数值框、滑块、开关),不再用
 * 大标题 + 右侧说明 + 整块底色把每一项都撑成一个大色块。
 */

/** 分组小标题:Codex 用弱化的小标题分层,不是大标题。 */
function GroupLabel({ children }: { children: ReactNode }) {
  return <h3 className="px-0.5 text-ui-compact font-medium text-muted-foreground">{children}</h3>;
}

/** 卡内行的统一内边距 —— 与 `SettingsRow` 的 `surface` 单行保持一致。 */
const ROW_PADDING = 'px-4 py-3.5';

const THEME_LABELS: Record<Theme, string> = { Light: '浅色', Dark: '深色', System: '跟随系统' };

/**
 * 缩略图配色 —— 画的是「一扇应用窗口的样子」，不是真实表面，所以用字面量而不是
 * 主题 token：一扇浅色窗口在深色主题下也必须是浅色的。强调色的部分反而走
 * `bg-primary`，跟着用户选的强调色走。
 */
const SHOT = {
  light: {
    window: '#ffffff',
    fill: 'rgb(13 13 13 / 0.05)',
    line: 'rgb(13 13 13 / 0.14)',
    dot: 'rgb(13 13 13 / 0.12)',
  },
  dark: {
    window: '#191919',
    fill: 'rgb(255 255 255 / 0.07)',
    line: 'rgb(255 255 255 / 0.18)',
    dot: 'rgb(255 255 255 / 0.16)',
  },
} as const;

/**
 * 一扇应用窗口的示意画：左上角一个图标圆点、下面几行内容、底部一条输入框
 * 带着发送圆点。
 *
 * 之前画的是「浏览器窗口」—— 三个红黄绿圆点 + 左侧栏 + 右侧文字行。放到 72px
 * 宽的方块里这套语言完全不成立：圆点只剩 4px、侧栏挤成一条，缩出来是一团噪点，
 * 根本看不出这是自己的应用。对照参考图改成上面这套。
 */
function WindowShot({ variant }: { variant: 'light' | 'dark' }) {
  const c = SHOT[variant];
  return (
    <div className="relative h-full w-full overflow-hidden" style={{ backgroundColor: c.window }}>
      <span className="absolute left-1.5 top-1.5 h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c.dot }} />
      <span className="absolute left-1.5 right-1.5 top-6 flex flex-col gap-1">
        <span className="h-[3px] w-full rounded-full bg-primary" />
        <span className="h-[3px] w-3/4 rounded-full" style={{ backgroundColor: c.line }} />
        <span className="h-[3px] w-5/6 rounded-full bg-primary" />
        <span className="h-[3px] w-1/2 rounded-full" style={{ backgroundColor: c.line }} />
      </span>
      <span
        className="absolute inset-x-1.5 bottom-1.5 flex h-3 items-center justify-end rounded-md px-1"
        style={{ backgroundColor: c.fill }}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-primary" />
      </span>
    </div>
  );
}

/** 模式选择：Codex 是一排应用窗口缩略图，选中项套主色描边。 */
function ModeThumb({ theme, active, onClick }: { theme: Theme; active: boolean; onClick: () => void }) {
  return (
    <TooltipHint content={THEME_LABELS[theme]}>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        aria-label={THEME_LABELS[theme]}
        className={cn(
          'relative block h-12 w-[72px] shrink-0 overflow-hidden rounded-lg transition-shadow duration-normal',
          active ? 'ring-2 ring-primary' : 'ring-1 ring-border hover:ring-foreground/25',
        )}
      >
        {theme === 'System' ? (
          // 跟随系统 = 同一扇窗口左右两半各是一种主题。
          <div className="flex h-full w-full">
            <div className="w-1/2 overflow-hidden">
              <WindowShot variant="light" />
            </div>
            <div className="w-1/2 overflow-hidden">
              <WindowShot variant="dark" />
            </div>
          </div>
        ) : (
          <WindowShot variant={theme === 'Light' ? 'light' : 'dark'} />
        )}
      </button>
    </TooltipHint>
  );
}

function ModeRow({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  const order: Theme[] = ['Light', 'System', 'Dark'];
  return (
    <div className={ROW_PADDING}>
      <div className="text-ui-body font-medium text-foreground">模式</div>
      <div className="mt-3 flex items-center gap-2.5">
        {order.map((option) => (
          <ModeThumb key={option} theme={option} active={theme === option} onClick={() => onChange(option)} />
        ))}
      </div>
    </div>
  );
}

/** 紧凑数值框:Codex 的字号是「小方框 + 右侧 px 后缀」,不是加减号步进器。 */
function NumberField({
  label,
  value,
  min,
  max,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  // 编辑过程中允许中间态(清空、只填了个 1),失焦时回到受控值。
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        inputMode="numeric"
        aria-label={label}
        min={min}
        max={max}
        value={draft ?? String(value)}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const parsed = Number(next);
          if (next !== '' && Number.isFinite(parsed)) {
            onChange(Math.min(max, Math.max(min, Math.round(parsed))));
          }
        }}
        onBlur={() => setDraft(null)}
        className={cn(
          'h-8 w-16 rounded-md border border-border bg-[hsl(var(--surface-2))] px-2 text-right',
          'text-ui-body tabular-nums text-foreground transition-colors duration-fast ease-motion-out',
          'hover:bg-[hsl(var(--surface-3))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
          '[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
        )}
        style={{ MozAppearance: 'textfield' }}
      />
      <span className="text-ui-caption text-muted-foreground">{unit}</span>
    </div>
  );
}

/**
 * 对比度滑块。
 *
 * 轨道和把手全部自己画，`<input type="range">` 只作为透明的一层盖在上面负责
 * 拖拽、键盘与无障碍。之前让 input 自己画轨道、`appearance: none` 之后再用
 * `::-webkit-slider-thumb` + `margin-top` 去把把手拉回正中 —— WebKit 对这个
 * 组合的居中并不保证，结果就是把手浮在轨道下面半截，看着没跟线对齐。
 * 现在两条都用 `top-1/2 -translate-y-1/2`，位置是算出来的而不是调出来的。
 *
 * 配色照参考图：已填充段与把手都是 ink，未填充段是控件底色，把手带一圈表面色
 * 的环 —— 所以在深色下环是深色的，浅色下是白圈。
 */
function ContrastControl({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const percent = ((value - CONTRAST_MIN) / (CONTRAST_MAX - CONTRAST_MIN)) * 100;
  return (
    <div className="flex w-full max-w-64 items-center gap-3">
      <div className="relative h-4 flex-1">
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-foreground" style={{ width: `${percent}%` }} />
        </div>
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[hsl(var(--background))] bg-foreground shadow-elevation-subtle"
          style={{ left: `${percent}%` }}
        />
        <input
          type="range"
          min={CONTRAST_MIN}
          max={CONTRAST_MAX}
          step={1}
          value={value}
          aria-label="对比度"
          onChange={(event) => onChange(Number(event.target.value))}
          className="contrast-slider peer absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-full opacity-0"
        />
        <span className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2" />
      </div>
      <output className="w-8 text-ui-body tabular-nums text-foreground" aria-live="polite">
        {value}
      </output>
    </div>
  );
}

const RADIUS_OPTIONS: { value: RadiusKey; label: string }[] = [
  { value: 'sharp', label: '锐利' },
  { value: 'soft', label: '柔和' },
  { value: 'round', label: '圆润' },
];

const CONTENT_WIDTH_OPTIONS: { value: ContentWidthKey; label: string }[] = [
  { value: 'fixed', label: '定宽' },
  { value: 'stream', label: '流式' },
];

const ACCENT_KEYS = Object.keys(ACCENTS) as AccentKey[];

export function ThemeToggle() {
  const config = useSettingsStore((state) => state.config);
  const setTheme = useSettingsStore((state) => state.setTheme);
  const currentTheme: Theme = config?.theme ?? 'System';
  const isDark = currentTheme === 'Dark';

  const prefs = useAppearanceStore((state) => state.prefs);
  const setAccent = useAppearanceStore((state) => state.setAccent);
  const setContrast = useAppearanceStore((state) => state.setContrast);
  const setUiFontFamily = useAppearanceStore((state) => state.setUiFontFamily);
  const setUiFontSize = useAppearanceStore((state) => state.setUiFontSize);
  const setCodeFontSize = useAppearanceStore((state) => state.setCodeFontSize);
  const setRadius = useAppearanceStore((state) => state.setRadius);
  const setContentWidth = useAppearanceStore((state) => state.setContentWidth);
  const reset = useAppearanceStore((state) => state.reset);

  // Codex 默认就把「高级」摊开:这一页的设置量不大,藏起来只会让人多点一次。
  const [advancedOpen, setAdvancedOpen] = useState(true);
  const accentHex = accentSwatch(prefs.accent, isDark).toUpperCase();

  return (
    <div className="space-y-6">
      <section className="space-y-2.5">
        <GroupLabel>视觉风格</GroupLabel>

        <SettingsCard>
          <ModeRow theme={currentTheme} onChange={setTheme} />
        </SettingsCard>

        <SettingsCard>
          <SettingsRow
            className={ROW_PADDING}
            label="强调色"
            description="按钮、链接与高亮元素使用的颜色。"
            control={
              <div className="flex items-center gap-2.5">
                <Select value={prefs.accent} onValueChange={(value) => setAccent(value as AccentKey)}>
                  <SelectTrigger
                    aria-label="强调色"
                    className="h-8 w-40 justify-between gap-2 rounded-md border-border bg-[hsl(var(--surface-2))] px-2.5 text-ui-body hover:bg-[hsl(var(--surface-3))]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCENT_KEYS.map((key) => (
                      <SelectItem key={key} value={key}>
                        <span className="flex items-center gap-2">
                          <span
                            className="h-3.5 w-3.5 shrink-0 rounded-full"
                            style={{ backgroundColor: accentSwatch(key, isDark) }}
                          />
                          {ACCENTS[key].name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="font-mono text-code uppercase text-muted-foreground">{accentHex}</span>
              </div>
            }
          />

          <SettingsRow
            divided
            className={ROW_PADDING}
            label="界面字体"
            description="仅影响界面文字，代码与差异视图另用代码字体。"
            control={<FontPicker value={prefs.uiFontFamily} onChange={setUiFontFamily} />}
          />

          <SettingsRow
            divided
            className={ROW_PADDING}
            label="圆角风格"
            description="控制按钮、卡片与输入框的边角弧度。"
            control={
              <Select value={prefs.radius} onValueChange={(value) => setRadius(value as RadiusKey)}>
                <SelectTrigger
                  aria-label="圆角风格"
                  className="h-8 w-40 justify-between rounded-md border-border bg-[hsl(var(--surface-2))] px-2.5 text-ui-body hover:bg-[hsl(var(--surface-3))]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RADIUS_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      <span className="flex items-center gap-2">
                        <span
                          className="h-3.5 w-3.5 shrink-0 border-2 border-foreground/55"
                          style={{ borderRadius: RADIUS_PREVIEW[opt.value] }}
                        />
                        {opt.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />

          <SettingsRow
            divided
            className={ROW_PADDING}
            label="幕布宽度"
            description={
              prefs.contentWidth === 'fixed'
                ? '定宽：对话消息与发送框宽度固定居中。'
                : '流式：内容宽度尽量居中撑满中间区域。'
            }
            control={
              <Select
                value={prefs.contentWidth}
                onValueChange={(value) => setContentWidth(value as ContentWidthKey)}
              >
                <SelectTrigger
                  aria-label="幕布宽度"
                  className="h-8 w-40 justify-between rounded-md border-border bg-[hsl(var(--surface-2))] px-2.5 text-ui-body hover:bg-[hsl(var(--surface-3))]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONTENT_WIDTH_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </SettingsCard>
      </section>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger
          className={cn(
            'flex items-center gap-1 px-0.5 text-ui-compact font-medium text-muted-foreground',
            'transition-colors duration-fast ease-motion-out hover:text-foreground',
          )}
        >
          高级
          <ChevronDown
            className={cn('h-3.5 w-3.5 transition-transform duration-normal ease-motion-in-out', advancedOpen && 'rotate-180')}
          />
        </CollapsibleTrigger>

        <CollapsibleContent className="space-y-2.5 pt-2.5">
          <SettingsCard>
            <SettingsRow
              className={ROW_PADDING}
              label="界面字号"
              description="调整界面文字的基础字号。"
              control={
                <NumberField
                  label="界面字号"
                  value={prefs.uiFontSize}
                  min={UI_FONT_SIZE_MIN}
                  max={UI_FONT_SIZE_MAX}
                  unit="px"
                  onChange={setUiFontSize}
                />
              }
            />

            <SettingsRow
              divided
              className={ROW_PADDING}
              label="代码字体大小"
              description="调整代码与差异视图中代码使用的基础字号。"
              control={
                <NumberField
                  label="代码字体大小"
                  value={prefs.codeFontSize}
                  min={CODE_FONT_SIZE_MIN}
                  max={CODE_FONT_SIZE_MAX}
                  unit="px"
                  onChange={setCodeFontSize}
                />
              }
            />

            <SettingsRow
              divided
              className={ROW_PADDING}
              label="对比度"
              description="调低更安静，调高让边界与次级文字更清楚。"
              control={<ContrastControl value={prefs.contrast} onChange={setContrast} />}
            />
          </SettingsCard>
        </CollapsibleContent>
      </Collapsible>

      <div>
        <Button variant="ghost" size="sm" onClick={reset} className="gap-1.5 text-muted-foreground">
          <RotateCcw className="h-3.5 w-3.5" />
          恢复默认外观
        </Button>
      </div>
    </div>
  );
}
