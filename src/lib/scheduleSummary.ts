import type { ScheduleKind } from '../types/scheduledTask';

const WEEKDAY_SHORT = ['一', '二', '三', '四', '五', '六', '日'];

function formatTimezoneLabel(timezone: string): string {
  const trimmed = timezone.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('GMT')) return trimmed;
  const match = trimmed.match(/^([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (match) {
    const hours = Number(match[2]);
    const minutes = match[3] ? Number(match[3]) : 0;
    if (minutes === 0) {
      return `GMT${match[1]}${hours}`;
    }
    return `GMT${match[1]}${hours}:${match[3]}`;
  }
  return trimmed;
}

function formatWeekdays(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  return sorted.map((day) => WEEKDAY_SHORT[day] ?? String(day)).join('、');
}

function formatTime(scheduleTime: string): string {
  const match = scheduleTime.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return scheduleTime;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function formatMinute(scheduleTime: string): string {
  const match = scheduleTime.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return '00';
  return match[2].padStart(2, '0');
}

export function formatScheduleSummary(
  scheduleKind: ScheduleKind,
  scheduleTime: string,
  weeklyWeekdays: number[],
  monthlyDay: number,
  timezone: string,
  options?: { includeTimezone?: boolean },
): string {
  const includeTimezone = options?.includeTimezone ?? true;
  const tz = includeTimezone ? formatTimezoneLabel(timezone) : '';
  const prefix = tz ? `${tz} ` : '';

  switch (scheduleKind) {
    case 'hourly':
      return `${prefix}每小时的第 ${formatMinute(scheduleTime)} 分`;
    case 'daily':
      return `${prefix}每天 ${formatTime(scheduleTime)}`;
    case 'weekdays':
      return `${prefix}每工作日 ${formatTime(scheduleTime)}`;
    case 'weekly': {
      const days = weeklyWeekdays.length > 0 ? weeklyWeekdays : [1];
      return `${prefix}每周${formatWeekdays(days)} ${formatTime(scheduleTime)}`;
    }
    case 'monthly':
      return `${prefix}每月 ${monthlyDay} 号 ${formatTime(scheduleTime)}`;
    default:
      return prefix.trim();
  }
}

export function formatNextRunRelative(nextRunAt: string, nowMs = Date.now()): string {
  const target = Date.parse(nextRunAt);
  if (Number.isNaN(target)) return '';

  const diffMs = target - nowMs;
  if (diffMs <= 0) return '即将运行';

  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟后`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours} 小时 ${remainingMinutes} 分钟后` : `${hours} 小时后`;
  }

  const days = Math.floor(hours / 24);
  return `${days} 天后`;
}

export function formatRunCount(count: number): string {
  return `已运行 ${count} 次`;
}
