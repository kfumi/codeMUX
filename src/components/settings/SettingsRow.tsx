import type { ReactNode } from 'react';

import { cn } from '../../lib/utils';

interface SettingsRowProps {
  /** 行标题:开关/选择器对应的设置项名称。 */
  label: ReactNode;
  /** 补充说明:窄屏下另起一行占满宽度。 */
  description?: ReactNode;
  /** 右侧控件:开关、下拉、按钮等。 */
  control: ReactNode;
  /**
   * 紧凑控件(开关、小按钮)在窄屏放到标题右侧,只把说明挤到下一行;
   * 默认(false)适合下拉这类需要整行宽度的控件。
   */
  inlineControl?: boolean;
  /** 是否自带卡片底色(独立成块的行用;同一张卡片内的多行用 `divided`)。 */
  surface?: boolean;
  /** 同一张卡片内的多行之间画分隔线。 */
  divided?: boolean;
  className?: string;
}

/**
 * 设置项行:左标题 + 右控件。
 *
 * 窄屏(手机/竖屏平板)下左右分栏会把说明文字压成竖排窄条,所以这里默认在
 * 640px 以下改为上下堆叠;宽屏(≥640px)恢复原来的左右布局。
 *
 * 用 grid 而不是两套 DOM:`inlineControl` 时开关留在标题右侧,说明换行到第二
 * 行;否则控件整行铺开。宽屏用 `sm:` 把控件放回右列并跨两行,和改动前的
 * 桌面布局一致。
 */
export function SettingsRow({
  label,
  description,
  control,
  inlineControl = false,
  surface = false,
  divided = false,
  className,
}: SettingsRowProps) {
  return (
    <div
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 sm:gap-x-4 sm:gap-y-1',
        surface && 'rounded-xl settings-tile px-4 py-3.5',
        divided && 'border-t border-border/55 pt-3',
        className,
      )}
    >
      <div className="col-start-1 row-start-1 min-w-0 text-sm font-medium text-foreground/90">
        {label}
      </div>
      <div
        className={cn(
          'min-w-0 self-center sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:row-span-2 sm:w-auto sm:max-w-60 sm:justify-self-end',
          inlineControl
            ? 'col-start-2 row-start-1 justify-self-end'
            // 没有说明文字时不要多占一行,否则会白流出一条 0 高度的行间隙。
            : cn('col-span-2 w-full', description ? 'row-start-3' : 'row-start-2'),
        )}
      >
        {control}
      </div>
      {description ? (
        <p
          className={cn(
            'col-span-2 col-start-1 row-start-2 max-w-[62ch] text-xs leading-relaxed text-muted-foreground',
            'sm:col-span-1',
          )}
        >
          {description}
        </p>
      ) : null}
    </div>
  );
}
