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
};

export function RunningElapsedTimer({
  label = 'Agent 执行中',
}: RunningElapsedTimerProps) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsed(Date.now() - startRef.current);
    }, 200);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  return <span>{label} · {formatElapsed(elapsed)}</span>;
}
