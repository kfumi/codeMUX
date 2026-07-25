import { useEffect, useRef, useState } from 'react';

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join('');
}

type RunningElapsedTimerProps = {
  label?: string;
  /** If provided, computes elapsed from this epoch ms instead of mount time. */
  startTime?: number;
  /** Show left-to-right shimmer overlay on the text. Defaults to true. */
  active?: boolean;
};

export function RunningElapsedTimer({
  label = '思考中',
  startTime,
  active = true,
}: RunningElapsedTimerProps) {
  const mountTime = useRef(Date.now());
  const base = startTime ?? mountTime.current;
  const [elapsed, setElapsed] = useState(Date.now() - base);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsed(Date.now() - base);
    }, 200);

    return () => {
      window.clearInterval(timer);
    };
  }, [base]);

  const text = `${label} · ${formatElapsed(elapsed)}`;

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
