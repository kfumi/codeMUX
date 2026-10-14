import { type ReactNode } from 'react';
import { Check, Minus, Monitor, Moon, Plus, RotateCcw, Sun } from 'lucide-react';

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
import { FontPicker } from './FontPicker';

interface FormSectionProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

function FormSection({ label, hint, children }: FormSectionProps) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-ui-title font-medium text-foreground">{label}</h3>
        {hint && <span className="text-ui-caption text-right text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

const THEME_LABELS: Record<Theme, string> = { Light: '浅色', Dark: '深色', System: '跟随系统' };
const THEME_ICONS: Record<Theme, typeof Sun> = { Light: Sun, Dark: Moon, System: Monitor };

function ThemePreviewCard({ theme, active, onClick }: { theme: Theme; active: boolean; onClick: () => void }) {
  const Icon = THEME_ICONS[theme];
  const isLight = theme === 'Light';
  const isSystem = theme === 'System';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={THEME_LABELS[theme]}
      className={cn(
        'group relative flex flex-col gap-3 rounded-xl border p-3 text-left transition-all duration-normal',
        active
          ? 'border-primary/55 bg-primary/[0.04] ring-1 ring-primary/35'
          : 'border-transparent settings-tile settings-tile-hover',
      )}
    >
      <div className="aspect-[4/3] w-full overflow-hidden rounded-md border border-border/45 bg-background">
        {isSystem ? (
          <div className="flex h-full w-full">
            <div className="flex flex-1 flex-col bg-[hsl(220_20%_97%)]">
              <div className="flex items-center gap-1 border-b border-black/[0.06] px-2 py-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[hsl(358_70%_62%)]" />
                <span className="h-1.5 w-1.5 rounded-full bg-[hsl(38_88%_55%)]" />
                <span className="h-1.5 w-1.5 rounded-full bg-[hsl(142_55%_40%)]" />
              </div>
              <div className="flex flex-1">
                <div className="w-1/3 border-r border-black/[0.06] bg-[hsl(218_18%_93%)]" />
                <div className="flex-1 space-y-1 p-2">
                  <span className="block h-1 w-3/4 rounded-full bg-[hsl(222_18%_10%/0.5)]" />
                  <span className="block h-1 w-1/2 rounded-full bg-[hsl(222_18%_10%/0.25)]" />
                </div>
              </div>
            </div>
            <div className="flex flex-1 flex-col bg-[hsl(220_7%_8%)]">
              <div className="flex items-center gap-1 border-b border-white/[0.06] px-2 py-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[hsl(358_74%_70%)]" />
                <span className="h-1.5 w-1.5 rounded-full bg-[hsl(38_94%_58%)]" />
                <span className="h-1.5 w-1.5 rounded-full bg-[hsl(136_56%_47%)]" />
              </div>
              <div className="flex flex-1">
                <div className="w-1/3 border-r border-white/[0.06] bg-[hsl(220_7%_7%)]" />
                <div className="flex-1 space-y-1 p-2">
                  <span className="block h-1 w-3/4 rounded-full bg-[hsl(220_10%_88%/0.6)]" />
                  <span className="block h-1 w-1/2 rounded-full bg-[hsl(220_10%_88%/0.3)]" />
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className={cn('flex h-full w-full flex-col', isLight ? 'bg-[hsl(220_20%_97%)]' : 'bg-[hsl(220_7%_8%)]')}>
            <div
              className={cn(
                'flex items-center gap-1 border-b px-2 py-1.5',
                isLight ? 'border-black/[0.06]' : 'border-white/[0.06]',
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', isLight ? 'bg-[hsl(358_70%_62%)]' : 'bg-[hsl(358_74%_70%)]')} />
              <span className={cn('h-1.5 w-1.5 rounded-full', isLight ? 'bg-[hsl(38_88%_55%)]' : 'bg-[hsl(38_94%_58%)]')} />
              <span className={cn('h-1.5 w-1.5 rounded-full', isLight ? 'bg-[hsl(142_55%_40%)]' : 'bg-[hsl(136_56%_47%)]')} />
            </div>
            <div className="flex flex-1">
              <div
                className={cn(
                  'w-1/3 border-r',
                  isLight ? 'border-black/[0.06] bg-[hsl(218_18%_93%)]' : 'border-white/[0.06] bg-[hsl(220_7%_7%)]',
                )}
              />
              <div className="flex-1 space-y-1 p-2">
                <span
                  className={cn(
                    'block h-1 w-3/4 rounded-full',
                    isLight ? 'bg-[hsl(222_18%_10%/0.5)]' : 'bg-[hsl(220_10%_88%/0.6)]',
                  )}
                />
                <span
                  className={cn(
                    'block h-1 w-1/2 rounded-full',
                    isLight ? 'bg-[hsl(222_18%_10%/0.25)]' : 'bg-[hsl(220_10%_88%/0.3)]',
                  )}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className={cn('h-3.5 w-3.5', active ? 'text-primary' : 'text-muted-foreground')} />
          <span className={cn('text-ui-title font-medium', active ? 'text-foreground' : 'text-foreground')}>
            {THEME_LABELS[theme]}
          </span>
        </div>
        {active && (
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="h-2.5 w-2.5" strokeWidth={3} />
          </span>
        )}
      </div>
    </button>
  );
}

function AccentSwatch({
  accent,
  active,
  onClick,
  currentTheme,
}: {
  accent: AccentKey;
  active: boolean;
  onClick: () => void;
  currentTheme: Theme;
}) {
  const preset = ACCENTS[accent];
  // 圆点必须反映**当前主题**下真正生效的那个值（Codex 的强调色明暗同值，
// 其余预设不同）—— 固定用 light 会让深色用户看到的色板与实际不符。
const swatch = accentSwatch(accent, currentTheme === 'Dark');
return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={preset.name}
      className="group flex flex-col items-center gap-2"
    >
      <span
        className={cn(
          'relative flex h-9 w-9 items-center justify-center rounded-full transition-transform duration-normal',
          !active && 'group-hover:scale-105',
        )}
        style={{
          backgroundColor: swatch,
          boxShadow: active
            ? `0 0 0 2px hsl(var(--background)), 0 0 0 4px ${swatch}`
            : `inset 0 0 0 1px hsl(var(--foreground)/0.1)`,
        }}
      >
        {active && <Check className="h-4 w-4 text-white drop-shadow-sm" strokeWidth={3} />}
      </span>
      <span className={cn('text-ui-caption', active ? 'font-medium text-foreground' : 'text-muted-foreground')}>
        {preset.name}
      </span>
    </button>
  );
}

interface OptionCardProps {
  label: string;
  active: boolean;
  onClick: () => void;
  preview: ReactNode;
}

function OptionCard({ label, active, onClick, preview }: OptionCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border py-3 transition-all duration-normal',
        active
          ? 'border-primary/55 bg-primary/[0.05] ring-1 ring-primary/30'
          : 'border-transparent settings-tile settings-tile-hover',
      )}
    >
      {preview}
      <span className={cn('text-ui-caption', active ? 'font-medium text-foreground' : 'text-muted-foreground')}>{label}</span>
    </button>
  );
}

const RADIUS_OPTIONS: { value: RadiusKey; label: string }[] = [
  { value: 'sharp', label: '锐利' },
  { value: 'soft', label: '柔和' },
  { value: 'round', label: '圆润' },
];

/** 四组 diff 取色器：新增/删除 × 浅色/深色。 */
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
    <div className="flex items-center gap-3">
      <label
        className="relative h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border"
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
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-ui-caption text-foreground">{label}</span>
        <span className="font-mono text-code text-muted-foreground uppercase">{current}</span>
      </div>
      {customized && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`${label}恢复默认`}
          onClick={() => onChange(undefined)}
          className="text-muted-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

const CONTENT_WIDTH_OPTIONS: { value: ContentWidthKey; label: string }[] = [
  { value: 'fixed', label: '定宽' },
  { value: 'stream', label: '流式' },
];

const ACCENT_KEYS = Object.keys(ACCENTS) as AccentKey[];

export function ThemeToggle() {
  const config = useSettingsStore((state) => state.config);
  const setTheme = useSettingsStore((state) => state.setTheme);
  const currentTheme: Theme = config?.theme ?? 'System';

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

  return (
    <div className="space-y-7">
      <FormSection label="主题模式" hint="选择浅色、深色，或跟随系统偏好">
        <div className="grid grid-cols-3 gap-2">
          <ThemePreviewCard theme="Light" active={currentTheme === 'Light'} onClick={() => setTheme('Light')} />
          <ThemePreviewCard theme="Dark" active={currentTheme === 'Dark'} onClick={() => setTheme('Dark')} />
          <ThemePreviewCard theme="System" active={currentTheme === 'System'} onClick={() => setTheme('System')} />
        </div>
      </FormSection>

      <FormSection label="强调色" hint="应用于按钮、链接与高亮元素">
        <div className="flex flex-wrap gap-x-5 gap-y-3 rounded-xl settings-tile p-3">
          {ACCENT_KEYS.map((key) => (
            <AccentSwatch
              key={key}
              accent={key}
              active={prefs.accent === key}
              currentTheme={currentTheme}
              onClick={() => setAccent(key)}
            />
          ))}
        </div>
      </FormSection>

      <FormSection label="对比度" hint="0–100，整体加重或减轻边界与次级文字">
        <div className="flex items-center gap-3 rounded-xl settings-tile px-3 py-2.5">
          <input
            type="range"
            min={CONTRAST_MIN}
            max={CONTRAST_MAX}
            step={1}
            value={prefs.contrast}
            aria-label="对比度"
            onChange={(event) => setContrast(Number(event.target.value))}
            className="contrast-slider h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full"
          />
          <output className="w-10 text-ui-body tabular-nums text-foreground" aria-live="polite">
            {prefs.contrast}
          </output>
        </div>
        <p className="text-ui-caption text-muted-foreground">
          调低让界面更安静，调高让边界与次级文字更清楚 —— 不用换主题就能调到舒服的程度。
        </p>
      </FormSection>

      <FormSection label="diff 配色" hint="代码增删行的颜色，与状态色分开">
        <div className="grid grid-cols-2 gap-x-5 gap-y-3 rounded-xl settings-tile p-3">
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
      </FormSection>

      <FormSection label="界面字体" hint="从本机已安装字体中选择，仅影响界面文字">
        <FontPicker value={prefs.uiFontFamily} onChange={setUiFontFamily} />
      </FormSection>

      <FormSection label="界面字号" hint="12–18px，按 1px 调整">
        <div className="flex w-fit items-center rounded-lg settings-tile">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="减小界面字号"
            disabled={prefs.uiFontSize <= UI_FONT_SIZE_MIN}
            onClick={() => setUiFontSize(prefs.uiFontSize - 1)}
            className="h-9 w-9 rounded-none rounded-l-md"
          >
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <output className="w-16 text-center text-ui-body tabular-nums" aria-live="polite">
            {prefs.uiFontSize}px
          </output>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="增大界面字号"
            disabled={prefs.uiFontSize >= UI_FONT_SIZE_MAX}
            onClick={() => setUiFontSize(prefs.uiFontSize + 1)}
            className="h-9 w-9 rounded-none rounded-r-md"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </FormSection>

      <FormSection label="代码字体大小" hint="10–20px，按 1px 调整">
        <div className="flex w-fit items-center rounded-lg settings-tile">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="减小代码字体大小"
            disabled={prefs.codeFontSize <= CODE_FONT_SIZE_MIN}
            onClick={() => setCodeFontSize(prefs.codeFontSize - 1)}
            className="h-9 w-9 rounded-none rounded-l-md"
          >
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <output className="w-16 text-center text-ui-body tabular-nums" aria-live="polite">
            {prefs.codeFontSize}px
          </output>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="增大代码字体大小"
            disabled={prefs.codeFontSize >= CODE_FONT_SIZE_MAX}
            onClick={() => setCodeFontSize(prefs.codeFontSize + 1)}
            className="h-9 w-9 rounded-none rounded-r-md"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </FormSection>

      <FormSection label="圆角风格" hint="控制按钮、卡片与输入框的边角弧度">
        <div className="grid grid-cols-3 gap-2">
          {RADIUS_OPTIONS.map((opt) => (
            <OptionCard
              key={opt.value}
              label={opt.label}
              active={prefs.radius === opt.value}
              onClick={() => setRadius(opt.value)}
              preview={
                <span
                  className="h-6 w-6 border-2 border-foreground/55"
                  style={{ borderRadius: RADIUS_PREVIEW[opt.value] }}
                />
              }
            />
          ))}
        </div>
      </FormSection>

      <FormSection label="幕布宽度" hint="控制消息幕布与输入区的内容宽度">
        <div className="grid grid-cols-2 gap-2">
          {CONTENT_WIDTH_OPTIONS.map((opt) => (
            <OptionCard
              key={opt.value}
              label={opt.label}
              active={prefs.contentWidth === opt.value}
              onClick={() => setContentWidth(opt.value)}
              preview={
                <div className="flex h-6 w-10 items-center">
                  {opt.value === 'fixed' ? (
                    <div className="mx-auto h-3 w-5 rounded-sm border border-foreground/45" />
                  ) : (
                    <div className="h-3 w-full rounded-sm border border-foreground/45" />
                  )}
                </div>
              }
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {prefs.contentWidth === 'fixed'
            ? '定宽模式下，对话消息与发送框宽度固定居中。'
            : '流式模式下，内容宽度尽量居中撑满中间区域。'}
        </p>
      </FormSection>

      <div className="pt-2">
        <Button variant="ghost" size="sm" onClick={reset} className="gap-1.5 text-muted-foreground">
          <RotateCcw className="h-3.5 w-3.5" />
          恢复默认外观
        </Button>
      </div>
    </div>
  );
}
