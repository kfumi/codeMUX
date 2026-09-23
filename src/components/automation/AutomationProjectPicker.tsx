import { Check, ChevronDown, Folder } from 'lucide-react';
import { useMemo, useState } from 'react';

import { cn } from '../../lib/utils';
import type { Project } from '../../types/project';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

interface AutomationProjectPickerProps {
  projects: Project[];
  value: string | null;
  onChange: (projectId: string | null) => void;
  className?: string;
  /** 表单字段用法：占满整行、描边样式，与 Input 等高（默认是工具栏紧凑幽灵按钮）。 */
  fullWidth?: boolean;
}

export function AutomationProjectPicker({
  projects,
  value,
  onChange,
  className,
  fullWidth = false,
}: AutomationProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selected = useMemo(
    () => projects.find((project) => project.id === value) ?? null,
    [projects, value],
  );

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return projects;
    return projects.filter((project) =>
      project.name.toLowerCase().includes(normalized)
      || project.path.toLowerCase().includes(normalized),
    );
  }, [projects, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={fullWidth ? 'outline' : 'ghost'}
          size={fullWidth ? 'default' : 'sm'}
          className={cn(
            fullWidth
              ? 'h-10 w-full justify-between gap-2 px-3 text-ui-body font-normal'
              : 'h-8 max-w-[200px] gap-1.5 px-2 text-ui-body font-normal hover:bg-muted/60',
            !selected && 'text-muted-foreground',
            className,
          )}
        >
          <Folder className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate text-left">{selected?.name ?? '选择项目'}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索项目"
          className="mb-2 h-8 text-ui-body"
        />
        <div className="max-h-56 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-ui-body text-muted-foreground">没有匹配的项目</p>
          ) : (
            filtered.map((project) => {
              const isSelected = project.id === value;
              return (
                <button
                  key={project.id}
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-ui-body hover:bg-muted/70',
                    isSelected && 'bg-muted/50',
                  )}
                  onClick={() => {
                    onChange(project.id);
                    setOpen(false);
                    setQuery('');
                  }}
                >
                  <Folder className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
