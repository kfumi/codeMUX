import { useEffect, useRef, useState } from 'react';

export function formatElapsed(ms: number, options?: { maxParts?: number }): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);

  const parts: Array<{ value: number; suffix: string }> = [];
  if (days > 0) parts.push({ value: days, suffix: 'd' });
  if (hours > 0) parts.push({ value: hours, suffix: 'h' });
  if (minutes > 0) parts.push({ value: minutes, suffix: 'm' });
  if (seconds > 0) parts.push({ value: seconds, suffix: 's' });

  if (parts.length === 0) return '0s';
  // 默认只取最大的两档（`2h 32m`、`1d 10h`）：行内计时器与页脚只需要量级。要看得见秒的
  // 地方（整轮「已处理」标题）传 `maxParts: 3`，拿到 `2h 32m 14s`。
  return parts
    .slice(0, Math.max(1, options?.maxParts ?? 2))
    .map((part) => `${part.value}${part.suffix}`)
    .join(' ');
}

type RunningElapsedTimerProps = {
  label?: string;
  /** If provided, computes elapsed from this epoch ms instead of mount time. */
  startTime?: number;
  /** Show left-to-right shimmer overlay on the text. Defaults to true. */
  active?: boolean;
};

export function RunningElapsedTimer({
  label = '正在执行',
  startTime,
  active = true,
}: RunningElapsedTimerProps) {
  const mountTime = useRef(Date.now());
  const base = startTime ?? mountTime.current;
  const [elapsed, setElapsed] = useState(Date.now() - base);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsed(Date.now() - base);
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [base]);

  // 空 label：只要时长（状态由旁边的状态胶囊表达），别留下「 · 」这种孤立分隔符。
  const text = label ? `${label} · ${formatElapsed(elapsed)}` : formatElapsed(elapsed);

  return (
    <span className="relative inline-block leading-none">
      <span>{text}</span>
      {active ? (
        <span
          aria-hidden
          className="shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
        >
          {text}
        </span>
      ) : null}
    </span>
  );
}
