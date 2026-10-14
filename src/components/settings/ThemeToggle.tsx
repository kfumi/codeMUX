import { useState, type ReactNode } from 'react';
import { Check, ChevronDown, RotateCcw } from 'lucide-react';

import {
  ACCENTS,
  type AccentKey,
  accentSwatch,
  CODE_FONT_SIZE_MAX,
  CODE_FONT_SIZE_MIN,
  CONTRAST_MAX,
  CONTRAST_MIN,
  type ContentWidthKey,
  type DiffColorKey,
  RADIUS_PREVIEW,
  type RadiusKey,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
} from '../../lib/appearance';
import { SEMANTIC_SEEDS } from '../../lib/colorDerivation';
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

/** 缩略图里那扇假窗口 —— 纯示意,颜色是画出来的,不是真实表面。 */
function MiniWindow({ variant }: { variant: 'light' | 'dark' }) {
  const isLight = variant === 'light';
  const chrome = isLight ? 'border-black/[0.06]' : 'border-white/[0.06]';
  const sidebar = isLight ? 'bg-[hsl(218_18%_93%)]' : 'bg-[hsl(220_7%_7%)]';
  const page = isLight ? 'bg-[hsl(220_20%_97%)]' : 'bg-[hsl(220_7%_8%)]';
  const strong = isLight ? 'bg-[hsl(222_18%_10%/0.5)]' : 'bg-[hsl(220_10%_88%/0.6)]';
  const weak = isLight ? 'bg-[hsl(222_18%_10%/0.25)]' : 'bg-[hsl(220_10%_88%/0.3)]';
  const dots = isLight
    ? ['bg-[hsl(358_70%_62%)]', 'bg-[hsl(38_88%_55%)]', 'bg-[hsl(142_55%_40%)]']
    : ['bg-[hsl(358_74%_70%)]', 'bg-[hsl(38_94%_58%)]', 'bg-[hsl(136_56%_47%)]'];

  return (
    <div className={cn('flex h-full w-full flex-col', page)}>
      <div className={cn('flex items-center gap-1 border-b px-2 py-1.5', chrome)}>
        {dots.map((dot) => (
          <span key={dot} className={cn('h-1.5 w-1.5 rounded-full', dot)} />
        ))}
      </div>
      <div className="flex flex-1">
        <div className={cn('w-1/3 border-r', chrome, sidebar)} />
        <div className="flex-1 space-y-1 p-2">
          <span className={cn('block h-1 w-3/4 rounded-full', strong)} />
          <span className={cn('block h-1 w-1/2 rounded-full', weak)} />
        </div>
      </div>
    </div>
  );
}

/** 模式选择:Codex 用一排缩略图,选中项套主色描边,缩略图本身不带文字标签。 */
function ModeThumb({ theme, active, onClick }: { theme: Theme; active: boolean; onClick: () => void }) {
  return (
    <TooltipHint content={THEME_LABELS[theme]}>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        aria-label={THEME_LABELS[theme]}
        className={cn(
          'relative block aspect-[3/2] w-16 overflow-hidden rounded-lg border transition-[box-shadow,border-color] duration-normal',
          active ? 'border-transparent ring-2 ring-primary' : 'border-border hover:border-foreground/25',
        )}
      >
        {theme === 'System' ? (
          <div className="flex h-full w-full">
            <div className="w-1/2">
              <MiniWindow variant="light" />
            </div>
            <div className="w-1/2">
              <MiniWindow variant="dark" />
            </div>
          </div>
        ) : (
          <MiniWindow variant={theme === 'Light' ? 'light' : 'dark'} />
        )}
        {active && (
          <span className="absolute right-1 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="h-2.5 w-2.5" strokeWidth={3} />
          </span>
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
      <div className="mt-2.5 flex items-center gap-2">
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

/** 对比度滑块:轨道由外面画(已填充段 + 空轨道),input 只负责把手与交互。 */
function ContrastControl({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const percent = ((value - CONTRAST_MIN) / (CONTRAST_MAX - CONTRAST_MIN)) * 100;
  return (
    <div className="flex w-full max-w-64 items-center gap-3">
      <div className="relative flex-1">
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-[hsl(var(--surface-edge))]">
          <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
        </div>
        <input
          type="range"
          min={CONTRAST_MIN}
          max={CONTRAST_MAX}
          step={1}
          value={value}
          aria-label="对比度"
          onChange={(event) => onChange(Number(event.target.value))}
          className="contrast-slider relative h-1.5 w-full cursor-pointer appearance-none rounded-full bg-transparent"
        />
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

/** 四个 diff 取色器:浅色/深色 × 新增/删除。 */
const DIFF_COLOR_FIELDS: {
  key: DiffColorKey;
  label: string;
  fallback: string;
}[] = [
  { key: 'lightAdded', label: '浅色 · 新增', fallback: SEMANTIC_SEEDS.light.diffAdded },
  { key: 'lightRemoved', label: '浅色 · 删除', fallback: SEMANTIC_SEEDS.light.diffRemoved },
  { key: 'darkAdded', label: '深色 · 新增', fallback: SEMANTIC_SEEDS.dark.diffAdded },
  { key: 'darkRemoved', label: '深色 · 删除', fallback: SEMANTIC_SEEDS.dark.diffRemoved },
];

function DiffColorField({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  value: string | undefined;
  fallback: string;
  onChange: (value: string | undefined) => void;
}) {
  const current = value ?? fallback;
  const customized = value !== undefined;
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border bg-[hsl(var(--surface-2))] px-2.5 py-2">
      <label
        className="relative h-6 w-6 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border"
        style={{ backgroundColor: current }}
      >
        <input
          type="color"
          value={current}
          aria-label={label}
          onChange={(event) => onChange(event.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
      <div className="flex min-w-0 flex-col">
        <span className="text-ui-caption text-foreground">{label}</span>
        <span className="font-mono text-code uppercase text-muted-foreground">{current}</span>
      </div>
      {customized && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`${label}恢复默认`}
          onClick={() => onChange(undefined)}
          className="ml-auto h-7 w-7 shrink-0 p-0 text-muted-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

export function ThemeToggle() {
  const config = useSettingsStore((state) => state.config);
  const setTheme = useSettingsStore((state) => state.setTheme);
  const currentTheme: Theme = config?.theme ?? 'System';
  const isDark = currentTheme === 'Dark';

  const prefs = useAppearanceStore((state) => state.prefs);
  const setAccent = useAppearanceStore((state) => state.setAccent);
  const setContrast = useAppearanceStore((state) => state.setContrast);
  const setDiffColor = useAppearanceStore((state) => state.setDiffColor);
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

          <SettingsCard>
            <div className={ROW_PADDING}>
              <div className="text-ui-body font-medium text-foreground">差异标记</div>
              <p className="mt-1 text-ui-caption leading-relaxed text-muted-foreground">
                代码增删行的颜色，与状态色分开。
              </p>
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {DIFF_COLOR_FIELDS.map((field) => (
                  <DiffColorField
                    key={field.key}
                    label={field.label}
                    value={prefs.diff[field.key]}
                    fallback={field.fallback}
                    onChange={(value) => setDiffColor(field.key, value)}
                  />
                ))}
              </div>
            </div>
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