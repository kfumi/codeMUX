import { useEffect, useRef, useState } from 'react';

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  }

  return `${seconds}s`;
}

type RunningElapsedTimerProps = {
  label?: string;
  /** If provided, computes elapsed from this epoch ms instead of mount time. */
  startTime?: number;
};

export function RunningElapsedTimer({
  label = 'Agent 执行中',
  startTime,
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

  return <span>{label} · {formatElapsed(elapsed)}</span>;
}
