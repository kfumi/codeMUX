import { type ReactNode } from 'react';
import { Check, Monitor, Moon, RotateCcw, Sun } from 'lucide-react';

import { ACCENTS, type AccentKey, type FontSizeKey, type RadiusKey, RADII } from '../../lib/appearance';
import { cn } from '../../lib/utils';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { Theme } from '../../types/provider';
import { Button } from '../ui/button';

interface FormSectionProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

function FormSection({ label, hint, children }: FormSectionProps) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[13px] font-medium text-foreground/70">{label}</h3>
        {hint && <span className="text-xs text-foreground/38">{hint}</span>}
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
        'group relative flex flex-col gap-3 rounded-xl border p-3 text-left transition-all duration-200',
        active
          ? 'border-primary/55 bg-primary/[0.04] ring-1 ring-primary/35'
          : 'border-border/55 bg-muted/25 hover:border-border hover:bg-muted/45',
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
          <Icon className={cn('h-3.5 w-3.5', active ? 'text-primary' : 'text-foreground/55')} />
          <span className={cn('text-[13px] font-medium', active ? 'text-foreground' : 'text-foreground/72')}>
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

function AccentSwatch({ accent, active, onClick }: { accent: AccentKey; active: boolean; onClick: () => void }) {
  const preset = ACCENTS[accent];
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
          'relative flex h-9 w-9 items-center justify-center rounded-full transition-transform duration-200',
          !active && 'group-hover:scale-105',
        )}
        style={{
          backgroundColor: preset.swatch,
          boxShadow: active
            ? `0 0 0 2px hsl(var(--background)), 0 0 0 4px ${preset.swatch}`
            : `inset 0 0 0 1px hsl(var(--foreground)/0.1)`,
        }}
      >
        {active && <Check className="h-4 w-4 text-white drop-shadow-sm" strokeWidth={3} />}
      </span>
      <span className={cn('text-[11px]', active ? 'font-medium text-foreground/82' : 'text-foreground/55')}>
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
        'flex flex-col items-center justify-center gap-2 rounded-lg border py-3 transition-all duration-200',
        active
          ? 'border-primary/55 bg-primary/[0.05] ring-1 ring-primary/30'
          : 'border-border/55 bg-muted/25 hover:border-border hover:bg-muted/45',
      )}
    >
      {preview}
      <span className={cn('text-[11px]', active ? 'font-medium text-foreground/82' : 'text-foreground/55')}>{label}</span>
    </button>
  );
}

const FONT_SIZE_OPTIONS: { value: FontSizeKey; label: string; px: string }[] = [
  { value: 'compact', label: '紧凑', px: '15px' },
  { value: 'standard', label: '标准', px: '16px' },
  { value: 'comfortable', label: '舒适', px: '18px' },
];

const RADIUS_OPTIONS: { value: RadiusKey; label: string }[] = [
  { value: 'sharp', label: '锐利' },
  { value: 'soft', label: '柔和' },
  { value: 'round', label: '圆润' },
];

const ACCENT_KEYS = Object.keys(ACCENTS) as AccentKey[];

export function ThemeToggle() {
  const config = useSettingsStore((state) => state.config);
  const setTheme = useSettingsStore((state) => state.setTheme);
  const currentTheme: Theme = config?.theme ?? 'System';

  const prefs = useAppearanceStore((state) => state.prefs);
  const setAccent = useAppearanceStore((state) => state.setAccent);
  const setFontSize = useAppearanceStore((state) => state.setFontSize);
  const setRadius = useAppearanceStore((state) => state.setRadius);
  const reset = useAppearanceStore((state) => state.reset);

  return (
    <div className="space-y-8">
      <FormSection label="主题模式" hint="选择浅色、深色，或跟随系统偏好">
        <div className="grid grid-cols-3 gap-3">
          <ThemePreviewCard theme="Light" active={currentTheme === 'Light'} onClick={() => setTheme('Light')} />
          <ThemePreviewCard theme="Dark" active={currentTheme === 'Dark'} onClick={() => setTheme('Dark')} />
          <ThemePreviewCard theme="System" active={currentTheme === 'System'} onClick={() => setTheme('System')} />
        </div>
      </FormSection>

      <FormSection label="强调色" hint="应用于按钮、链接与高亮元素">
        <div className="flex flex-wrap gap-4 rounded-xl bg-muted/30 p-4">
          {ACCENT_KEYS.map((key) => (
            <AccentSwatch
              key={key}
              accent={key}
              active={prefs.accent === key}
              onClick={() => setAccent(key)}
            />
          ))}
        </div>
      </FormSection>

      <FormSection label="字体大小" hint="影响界面整体文字密度">
        <div className="grid grid-cols-3 gap-2">
          {FONT_SIZE_OPTIONS.map((opt) => (
            <OptionCard
              key={opt.value}
              label={opt.label}
              active={prefs.fontSize === opt.value}
              onClick={() => setFontSize(opt.value)}
              preview={
                <span
                  className="font-semibold leading-none text-foreground/85"
                  style={{ fontSize: opt.px }}
                >
                  Aa
                </span>
              }
            />
          ))}
        </div>
        <p className="text-xs text-foreground/42">设置即时生效，可在编辑器与列表中查看实际效果。</p>
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
                  style={{ borderRadius: RADII[opt.value] }}
                />
              }
            />
          ))}
        </div>
      </FormSection>

      <div className="border-t border-border/40 pt-5">
        <Button variant="ghost" size="sm" onClick={reset} className="gap-1.5 text-foreground/60">
          <RotateCcw className="h-3.5 w-3.5" />
          恢复默认外观
        </Button>
      </div>
    </div>
  );
}
