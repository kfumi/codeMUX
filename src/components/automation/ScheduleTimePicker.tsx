import { ChevronDown } from 'lucide-react';
import { useMemo } from 'react';

import { cn } from '../../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

export const scheduleChipClassName =
  'inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border/55 bg-[hsl(var(--surface-2))]/80 px-2.5 text-ui-body text-foreground/90 transition-colors hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40';

const HOURS = Array.from({ length: 24 }, (_, index) => index);
const MINUTES = Array.from({ length: 60 }, (_, index) => index);

const timeColumnClassName = 'h-52 w-11 overflow-y-auto py-0.5';
const timeItemClassName =
  'w-full rounded-md px-1 py-1.5 text-ui-compact text-center text-muted-foreground hover:bg-muted/60 hover:text-foreground';
const timeItemActiveClassName = 'bg-muted/70 font-medium text-foreground';

function parseTime(value: string): { hour: number; minute: number } {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { hour: 9, minute: 0 };
  return {
    hour: Math.min(23, Math.max(0, Number(match[1]))),
    minute: Math.min(59, Math.max(0, Number(match[2]))),
  };
}

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

interface ScheduleTimePickerProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function ScheduleTimePicker({ value, onChange, className }: ScheduleTimePickerProps) {
  const { hour, minute } = useMemo(() => parseTime(value), [value]);

  const setHour = (nextHour: number) => {
    onChange(formatTime(nextHour, minute));
  };

  const setMinute = (nextMinute: number) => {
    onChange(formatTime(hour, nextMinute));
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn(scheduleChipClassName, className)}>
          {formatTime(hour, minute)}
          <ChevronDown className="h-3.5 w-3.5 opacity-55" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-1.5">
        <div className="flex divide-x divide-border/45">
          <div className={timeColumnClassName}>
            {HOURS.map((entry) => (
              <button
                key={entry}
                type="button"
                className={cn(timeItemClassName, entry === hour && timeItemActiveClassName)}
                onClick={() => setHour(entry)}
              >
                {String(entry).padStart(2, '0')}
              </button>
            ))}
          </div>
          <div className={timeColumnClassName}>
            {MINUTES.map((entry) => (
              <button
                key={entry}
                type="button"
                className={cn(timeItemClassName, entry === minute && timeItemActiveClassName)}
                onClick={() => setMinute(entry)}
              >
                {String(entry).padStart(2, '0')}
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface ScheduleMinutePickerProps {
  value: string;
  onChange: (value: string) => void;
}

export function ScheduleMinutePicker({ value, onChange }: ScheduleMinutePickerProps) {
  const minute = parseTime(value).minute;

  const setMinute = (nextMinute: number) => {
    onChange(formatTime(0, nextMinute));
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={scheduleChipClassName}>
          {String(minute).padStart(2, '0')}
          <ChevronDown className="h-3.5 w-3.5 opacity-55" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-1.5">
        <div className={timeColumnClassName}>
          {MINUTES.map((entry) => (
            <button
              key={entry}
              type="button"
              className={cn(timeItemClassName, entry === minute && timeItemActiveClassName)}
              onClick={() => setMinute(entry)}
            >
              {String(entry).padStart(2, '0')}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
