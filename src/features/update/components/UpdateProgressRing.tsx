import { cn } from '@/lib/utils';

/**
 * 更新下载进度环 —— 图标轨/侧栏页脚里的进度表达。
 *
 * 为什么不沿用「转圈 + 百分比文字」:图标轨格只有 40×40,文字塞不下;而侧栏
 * 页脚虽然有文字,一个纯转圈看不出「还剩多少」。环把两者合并:环本身就是进度,
 * 中心再放百分比(桌面格)/ 由旁边的行文字承担(窄屏行)。
 *
 * 总量未知(`percent === null`)时退化为不确定态:一段 25% 的弧持续旋转,
 * 不画假百分比(与关于页进度条同一口径)。
 */
export function UpdateProgressRing({
  percent,
  size = 32,
  strokeWidth = 3,
  label = false,
  className,
}: {
  /** 0–100;null = 总量未知(不确定态)。 */
  percent: number | null;
  size?: number;
  strokeWidth?: number;
  /** 是否在环心显示百分比文字(桌面图标轨格用)。 */
  label?: boolean;
  className?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const determinate = percent !== null;
  const offset = determinate ? circumference - (percent / 100) * circumference : 0;

  return (
    <span
      role="progressbar"
      aria-label="更新下载进度"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className={cn('relative inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
        className={cn('-rotate-90', !determinate && 'animate-spin')}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="hsl(var(--foreground) / 0.16)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="hsl(var(--primary))"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={determinate ? circumference : `${circumference * 0.25} ${circumference}`}
          strokeDashoffset={offset}
          className={determinate ? 'transition-[stroke-dashoffset] duration-normal ease-motion-out' : undefined}
        />
      </svg>
      {label && (
        <span className="absolute inset-0 flex items-center justify-center text-ui-micro font-medium tabular-nums text-foreground">
          {determinate ? `${percent}%` : ''}
        </span>
      )}
    </span>
  );
}
