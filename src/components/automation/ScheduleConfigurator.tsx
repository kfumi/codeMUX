import { Check, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { formatScheduleSummary } from '../../lib/scheduleSummary';
import { cn } from '../../lib/utils';
import type { ScheduledTaskDraft, ScheduleKind } from '../../types/scheduledTask';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { ScheduleMinutePicker, ScheduleTimePicker, scheduleChipClassName } from './ScheduleTimePicker';

const SCHEDULE_OPTIONS: Array<{ value: ScheduleKind; label: string }> = [
  { value: 'hourly', label: '每小时' },
  { value: 'daily', label: '每天' },
  { value: 'weekdays', label: '每工作日' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
];

const WEEKDAY_OPTIONS = [
  { value: 0, label: '一', fullLabel: '周一' },
  { value: 1, label: '二', fullLabel: '周二' },
  { value: 2, label: '三', fullLabel: '周三' },
  { value: 3, label: '四', fullLabel: '周四' },
  { value: 4, label: '五', fullLabel: '周五' },
  { value: 5, label: '六', fullLabel: '周六' },
  { value: 6, label: '日', fullLabel: '周日' },
];

const MONTHLY_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);

const menuItemClassName =
  'flex w-full items-center justify-between rounded-md px-2.5 py-2 text-ui-body text-foreground/90 hover:bg-muted/65';

export interface ScheduleConfiguratorValue {
  scheduleKind: ScheduleKind;
  scheduleTime: string;
  weeklyWeekdays: number[];
  monthlyDay: number;
}

export function createDefaultScheduleValue(kind: ScheduleKind = 'weekdays'): ScheduleConfiguratorValue {
  return {
    scheduleKind: kind,
    scheduleTime: kind === 'hourly' ? '00:00' : '09:00',
    weeklyWeekdays: kind === 'weekly' ? [0] : kind === 'weekdays' ? [0, 1, 2, 3, 4] : [1],
    monthlyDay: 1,
  };
}

export function scheduleValueFromInitialDraft(
  draft: Partial<ScheduledTaskDraft> | null | undefined,
): ScheduleConfiguratorValue | null {
  if (!draft?.scheduleKind) return null;
  return scheduleValueFromTask(
    draft.scheduleKind,
    draft.scheduleTime ?? '09:00',
    draft.weeklyWeekday ?? 1,
    null,
    draft.monthlyDay ?? 1,
  );
}

interface ScheduleConfiguratorProps {
  value: ScheduleConfiguratorValue | null;
  timezone: string;
  onChange: (value: ScheduleConfiguratorValue | null) => void;
}

export function ScheduleConfigurator({ value, timezone, onChange }: ScheduleConfiguratorProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [kindOpen, setKindOpen] = useState(false);
  const [weekdayOpen, setWeekdayOpen] = useState(false);
  const [monthDayOpen, setMonthDayOpen] = useState(false);

  const addSchedule = (scheduleKind: ScheduleKind) => {
    onChange(createDefaultScheduleValue(scheduleKind));
    setAddOpen(false);
  };

  if (!value) {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-ui-body text-muted-foreground">调度</span>
        <Popover open={addOpen} onOpenChange={setAddOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex h-10 w-full items-center justify-start gap-2 rounded-md border border-dashed border-input bg-background px-3 text-ui-body text-muted-foreground transition-colors hover:border-border/75 hover:bg-muted/30 hover:text-foreground"
            >
              <Plus className="h-4 w-4" />
              添加计划
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-44 p-1.5">
            {SCHEDULE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={menuItemClassName}
                onClick={() => addSchedule(option.value)}
              >
                <span>{option.label}</span>
              </button>
            ))}
          </PopoverContent>
        </Popover>
      </div>
    );
  }

  const summary = formatScheduleSummary(
    value.scheduleKind,
    value.scheduleTime,
    value.weeklyWeekdays,
    value.monthlyDay,
    timezone,
  );

  const weekdayLabel = (() => {
    if (value.weeklyWeekdays.length === 0) return '选择日期';
    const sorted = [...value.weeklyWeekdays].sort((a, b) => a - b);
    return sorted
      .map((day) => WEEKDAY_OPTIONS.find((option) => option.value === day)?.label ?? String(day))
      .join('、');
  })();

  const setKind = (scheduleKind: ScheduleKind) => {
    onChange({ ...value, scheduleKind });
    setKindOpen(false);
  };

  const toggleWeekday = (day: number) => {
    const hasDay = value.weeklyWeekdays.includes(day);
    const next = hasDay
      ? value.weeklyWeekdays.filter((entry) => entry !== day)
      : [...value.weeklyWeekdays, day];
    onChange({
      ...value,
      weeklyWeekdays: next.length > 0 ? next.sort((a, b) => a - b) : [day],
    });
  };

  const currentKindLabel =
    SCHEDULE_OPTIONS.find((option) => option.value === value.scheduleKind)?.label
    ?? value.scheduleKind;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-ui-body text-muted-foreground">调度</span>
      <div className="flex h-10 items-center gap-2 rounded-md border border-input bg-background px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <Popover open={kindOpen} onOpenChange={setKindOpen}>
            <PopoverTrigger asChild>
              <button type="button" className={scheduleChipClassName}>
                {currentKindLabel}
                <ChevronDown className="h-3.5 w-3.5 opacity-55" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-44 p-1.5">
              {SCHEDULE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={cn(
                    menuItemClassName,
                    value.scheduleKind === option.value && 'bg-muted/55',
                  )}
                  onClick={() => setKind(option.value)}
                >
                  <span>{option.label}</span>
                  {value.scheduleKind === option.value && (
                    <Check className="h-3.5 w-3.5 text-primary" />
                  )}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {value.scheduleKind === 'hourly' && (
            <>
              <span className="shrink-0 text-ui-body text-muted-foreground">第</span>
              <ScheduleMinutePicker
                value={value.scheduleTime}
                onChange={(scheduleTime) => onChange({ ...value, scheduleTime })}
              />
              <span className="shrink-0 text-ui-body text-muted-foreground">分钟</span>
            </>
          )}

          {value.scheduleKind === 'weekly' && (
            <Popover open={weekdayOpen} onOpenChange={setWeekdayOpen}>
              <PopoverTrigger asChild>
                <button type="button" className={scheduleChipClassName}>
                  {weekdayLabel}
                  <ChevronDown className="h-3.5 w-3.5 opacity-55" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-44 p-1.5">
                {WEEKDAY_OPTIONS.map((option) => {
                  const selected = value.weeklyWeekdays.includes(option.value);
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={cn(menuItemClassName, selected && 'bg-muted/55')}
                      onClick={() => toggleWeekday(option.value)}
                    >
                      <span>{option.fullLabel}</span>
                      {selected && <Check className="h-3.5 w-3.5 text-primary" />}
                    </button>
                  );
                })}
              </PopoverContent>
            </Popover>
          )}

          {value.scheduleKind === 'monthly' && (
            <Popover open={monthDayOpen} onOpenChange={setMonthDayOpen}>
              <PopoverTrigger asChild>
                <button type="button" className={scheduleChipClassName}>
                  {value.monthlyDay} 号
                  <ChevronDown className="h-3.5 w-3.5 opacity-55" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-28 p-1.5">
                <div className="max-h-56 overflow-y-auto">
                  {MONTHLY_DAYS.map((day) => (
                    <button
                      key={day}
                      type="button"
                      className={cn(
                        menuItemClassName,
                        value.monthlyDay === day && 'bg-muted/55',
                      )}
                      onClick={() => {
                        onChange({ ...value, monthlyDay: day });
                        setMonthDayOpen(false);
                      }}
                    >
                      <span>{day} 号</span>
                      {value.monthlyDay === day && (
                        <Check className="h-3.5 w-3.5 text-primary" />
                      )}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}

          {value.scheduleKind !== 'hourly' && (
            <>
              <span className="px-0.5 text-ui-body text-muted-foreground">于</span>
              <ScheduleTimePicker
                value={value.scheduleTime}
                onChange={(scheduleTime) => onChange({ ...value, scheduleTime })}
              />
            </>
          )}

          <span className="min-w-0 truncate px-1 text-ui-body text-muted-foreground">{summary}</span>
        </div>

        <button
          type="button"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground"
          aria-label="移除计划"
          onClick={() => onChange(null)}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export function normalizeScheduleForSave(value: ScheduleConfiguratorValue | null): {
  scheduleKind: ScheduleKind;
  scheduleTime: string;
  weeklyWeekday: number | null;
  weeklyWeekdays: number[] | null;
  monthlyDay: number | null;
} {
  if (!value) {
    throw new Error('请添加调度计划');
  }

  switch (value.scheduleKind) {
    case 'hourly':
      return {
        scheduleKind: 'hourly',
        scheduleTime: value.scheduleTime,
        weeklyWeekday: null,
        weeklyWeekdays: null,
        monthlyDay: null,
      };
    case 'daily':
      return {
        scheduleKind: 'daily',
        scheduleTime: value.scheduleTime,
        weeklyWeekday: null,
        weeklyWeekdays: null,
        monthlyDay: null,
      };
    case 'weekdays':
      return {
        scheduleKind: 'weekdays',
        scheduleTime: value.scheduleTime,
        weeklyWeekday: null,
        weeklyWeekdays: null,
        monthlyDay: null,
      };
    case 'weekly': {
      const days = value.weeklyWeekdays.length > 0 ? value.weeklyWeekdays : [1];
      return {
        scheduleKind: 'weekly',
        scheduleTime: value.scheduleTime,
        weeklyWeekday: days[0],
        weeklyWeekdays: days,
        monthlyDay: null,
      };
    }
    case 'monthly':
      return {
        scheduleKind: 'monthly',
        scheduleTime: value.scheduleTime,
        weeklyWeekday: null,
        weeklyWeekdays: null,
        monthlyDay: value.monthlyDay,
      };
    default:
      return {
        scheduleKind: value.scheduleKind,
        scheduleTime: value.scheduleTime,
        weeklyWeekday: null,
        weeklyWeekdays: null,
        monthlyDay: null,
      };
  }
}

export function scheduleValueFromTask(
  scheduleKind: ScheduleKind,
  scheduleTime: string,
  weeklyWeekday: number | null,
  weeklyWeekdays: number[] | null,
  monthlyDay: number | null,
): ScheduleConfiguratorValue {
  if (scheduleKind === 'weekly') {
    const days = weeklyWeekdays && weeklyWeekdays.length > 0
      ? weeklyWeekdays
      : [weeklyWeekday ?? 1];
    return {
      scheduleKind,
      scheduleTime,
      weeklyWeekdays: days,
      monthlyDay: monthlyDay ?? 1,
    };
  }
  return {
    scheduleKind,
    scheduleTime,
    weeklyWeekdays: scheduleKind === 'weekdays' ? [0, 1, 2, 3, 4] : [weeklyWeekday ?? 1],
    monthlyDay: monthlyDay ?? 1,
  };
}
