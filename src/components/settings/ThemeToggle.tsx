import { useState } from 'react';
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
import { FontPicker } from './FontPicker';
import { ModeRow } from './ModeRow';
import { SettingsCard, SettingsRow, SettingsSection } from './SettingsRow';

/**
 * 外观设置页。
 *
 * 版式照抄 Codex 的「分组小标题 + 发丝描边卡片 + 左标题右控件」:一行一个设置项,
 * 行与行之间用发丝线分隔,控件一律收到右列(下拉、数值框、滑块、开关),不再用
 * 大标题 + 右侧说明 + 整块底色把每一项都撑成一个大色块。
 */

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
 * 对比度滑块 —— 照搬 Codex 的画法:轨道是一条**静态**的强调色渐变(左端「强调色
 * 35% 混表面」、32% 起纯强调色),表达「往右越浓」这条语义,不随当前值变化;当前
 * 值靠把手位置 + 右侧数字表达,不再画「已填充 / 未填充」两段。
 *
 * 把手交回原生 `::-webkit-slider-thumb`:20px 圆点、颜色取文字色(浅色下黑、深色
 * 下白),`mt-[-9px]` 就是 (2px 轨道 - 20px 把手) / 2,位置是算出来的。上一版担心
 * WebKit 居中不可靠而改成「自绘把手 + 透明 input」,代价是丢掉键盘焦点环与原生拖拽,
 * 而且没有解决真正的问题 ——
 *
 * **容器必须有确定宽度。** 设置行的控件格是 `auto` 宽,它的最大宽度反过来又由内容
 * 决定,`flex-1` 的轨道于是被解成 0 宽:整条滑块塌成一个点贴在数字左边(Codex 给这
 * 一行 `min-w-[12rem]`,我们给整行固定宽度)。
 */
function ContrastControl({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <div className="flex h-9 w-full items-center gap-2.5 sm:w-56">
      <input
        type="range"
        min={CONTRAST_MIN}
        max={CONTRAST_MAX}
        step={1}
        value={value}
        aria-label="对比度"
        onChange={(event) => onChange(Number(event.target.value))}
        style={{
          background:
            'linear-gradient(90deg, hsl(var(--primary) / 0.35) 0%, hsl(var(--primary)) 32%, hsl(var(--primary)) 100%)',
        }}
        className={cn(
          'h-0.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full',
          // 轨道:Chromium 下由 input 自身的 2px 背景充当,这里只管两条引擎的轨道高度。
          '[&::-webkit-slider-runnable-track]:h-0.5 [&::-webkit-slider-runnable-track]:rounded-full',
          '[&::-moz-range-track]:h-0.5 [&::-moz-range-track]:rounded-full',
          // 把手
          '[&::-webkit-slider-thumb]:mt-[-9px] [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5',
          '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full',
          '[&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-transparent',
          '[&::-webkit-slider-thumb]:bg-foreground [&::-webkit-slider-thumb]:shadow-elevation-subtle',
          '[&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:rounded-full',
          '[&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-transparent',
          '[&::-moz-range-thumb]:bg-foreground [&::-moz-range-thumb]:shadow-elevation-subtle',
          // 焦点环画在把手上:轨道只有 2px,套在它身上的环等于看不见。
          'focus-visible:outline-none',
          'focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-ring/60',
          'focus-visible:[&::-moz-range-thumb]:ring-2 focus-visible:[&::-moz-range-thumb]:ring-ring/60',
        )}
      />
      <output className="w-9 text-end text-sm tabular-nums text-foreground" aria-live="polite">
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
    <div className="space-y-8">
      <SettingsSection label="视觉风格">

        <SettingsCard>
          <ModeRow theme={currentTheme} onChange={setTheme} />
        </SettingsCard>

        <SettingsCard>
          <SettingsRow
            label="强调色"
            description="按钮、链接与高亮元素的颜色"
            control={
              <div className="flex items-center gap-2.5">
                <Select value={prefs.accent} onValueChange={(value) => setAccent(value as AccentKey)}>
                  <SelectTrigger aria-label="强调色" size="sm" className="w-40 justify-between">
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
            label="界面字体"
            description="仅影响界面文字，代码另用代码字体"
            control={<FontPicker value={prefs.uiFontFamily} onChange={setUiFontFamily} />}
          />

          <SettingsRow
            label="圆角风格"
            description="按钮、卡片与输入框的圆角弧度"
            control={
              <Select value={prefs.radius} onValueChange={(value) => setRadius(value as RadiusKey)}>
                <SelectTrigger aria-label="圆角风格" size="sm" className="w-40 justify-between">
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
            label="幕布宽度"
            description={
              prefs.contentWidth === 'fixed'
                ? '对话消息与发送框定宽居中'
                : '内容宽度尽量撑满中间区域'
            }
            control={
              <Select
                value={prefs.contentWidth}
                onValueChange={(value) => setContentWidth(value as ContentWidthKey)}
              >
                <SelectTrigger aria-label="幕布宽度" size="sm" className="w-40 justify-between">
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
      </SettingsSection>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger
          className={cn(
            'flex items-center gap-1 px-0.5 text-ui-compact font-medium text-foreground',
            'transition-colors duration-fast ease-motion-out hover:text-muted-foreground',
          )}
        >
          高级
          <ChevronDown
            className={cn('h-3.5 w-3.5 transition-transform duration-normal ease-motion-in-out', advancedOpen && 'rotate-180')}
          />
        </CollapsibleTrigger>

        <CollapsibleContent className="pt-2.5">
          <SettingsCard>
            <SettingsRow
              label="界面字号"
              description="界面文字的基础字号"
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
              label="代码字体大小"
              description="代码与差异视图使用的字号"
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
              label="对比度"
              description="调低更安静，调高让边界与次级文字更清楚"
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
