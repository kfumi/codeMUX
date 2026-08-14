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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="界面字体"
          className="h-10 w-full max-w-md justify-between bg-background font-normal"
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
            <CommandGroup>
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
              {fonts.map((font) => (
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
