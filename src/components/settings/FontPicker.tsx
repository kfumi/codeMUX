import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';

import { formatFontFamilyForCss } from '../../lib/appearance';
import { loadSystemFonts } from '../../lib/systemFonts';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

const SYSTEM_DEFAULT_VALUE = '__system_default__';

/**
 * 内置推荐字体(对齐 PI-Desktop 的"内置"分组,均为 OFL 开源协议):
 * 字体在本机已安装时生效;未安装时由浏览器回退到系统字体栈。
 */
const BUILT_IN_FONTS = [
  { name: 'Geist', license: 'OFL' },
  { name: 'Inter', license: 'OFL' },
  { name: 'Noto Sans SC', license: 'OFL' },
  { name: 'LXGW WenKai', license: 'OFL' },
] as const;

interface FontPickerProps {
  value: string;
  onChange: (family: string) => void;
}

export function FontPicker({ value, onChange }: FontPickerProps) {
  const [open, setOpen] = useState(false);
  const [fonts, setFonts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void loadSystemFonts()
      .then((loadedFonts) => {
        if (!cancelled) setFonts(loadedFonts);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const displayLabel = value.trim() || '系统默认';
  const previewFamily = useMemo(
    () => formatFontFamilyForCss(value),
    [value],
  );
  // 系统字体列表里去掉与内置分组重复的项(大小写不敏感),避免同一字体出现两次。
  const systemFonts = useMemo(
    () =>
      fonts.filter(
        (font) => !BUILT_IN_FONTS.some((b) => b.name.toLowerCase() === font.toLowerCase()),
      ),
    [fonts],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="界面字体"
          className="h-10 w-full max-w-md justify-between border-transparent bg-muted/80 font-normal hover:bg-muted focus-visible:bg-card"
        >
          <span className="truncate" style={{ fontFamily: previewFamily }}>
            {displayLabel}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput placeholder="搜索字体..." />
          <CommandList>
            <CommandEmpty>{loading ? '正在加载系统字体…' : '未找到匹配字体'}</CommandEmpty>
            <CommandGroup heading="跟随系统">
              <CommandItem
                value={SYSTEM_DEFAULT_VALUE}
                keywords={['系统默认', 'system', 'default']}
                onSelect={() => {
                  onChange('');
                  setOpen(false);
                }}
              >
                <Check className={cn('mr-2 h-4 w-4', value.trim() ? 'opacity-0' : 'opacity-100')} />
                系统默认
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="内置">
              {BUILT_IN_FONTS.map((font) => (
                <CommandItem
                  key={font.name}
                  value={font.name}
                  keywords={['内置', 'builtin', font.license]}
                  onSelect={() => {
                    onChange(font.name);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('mr-2 h-4 w-4', value === font.name ? 'opacity-100' : 'opacity-0')} />
                  <span style={{ fontFamily: formatFontFamilyForCss(font.name) }}>{font.name}</span>
                  <span className="ml-auto text-ui-micro text-muted-foreground/70">{font.license}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading="系统">
              {systemFonts.map((font) => (
                <CommandItem
                  key={font}
                  value={font}
                  onSelect={() => {
                    onChange(font);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('mr-2 h-4 w-4', value === font ? 'opacity-100' : 'opacity-0')} />
                  <span style={{ fontFamily: formatFontFamilyForCss(font) }}>{font}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
