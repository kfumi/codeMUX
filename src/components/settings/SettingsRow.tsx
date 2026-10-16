import type { ReactNode } from 'react';

import { cn } from '../../lib/utils';

/**
 * Codex 式设置卡的表面:平面 + 发丝描边。
 *
 * 实测本机 Codex 的设置卡片是**白底 + 1px `#ececec` 描边**(卡片与页面同色),
 * 分层不靠「深一点的底色」,只靠一圈发丝描边把它框出来。`surface-1` 是派生体系里
 * 的「抬高一层」表面,浅色下比页面略白、深色下比页面略亮,正好承担这个角色。
 */
export const SETTINGS_CARD_CLASS =
  'rounded-xl border border-border bg-[hsl(var(--surface-1))]';

/** 卡内行的统一内边距 —— `surface` 单行与卡内多行共用同一档。 */
const ROW_PADDING = 'px-4 py-3';

/**
 * 把若干 `SettingsRow` 装进一张 Codex 式设置卡。
 *
 * 行与行之间的发丝分隔线由**卡片**统一画:两侧各内缩 16px(实测 Codex 的卡片
 * 左右边框在 x=555/1282,分隔线只从 572 画到 1265),行自己不带边框 ——
 * 也就不会出现「新加一行忘了画分隔线」的漏线,也不会叠成双线。
 */
export function SettingsCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        // overflow-hidden 让首尾行与分隔线跟着圆角裁切,否则分隔线会顶到圆角外面。
        'flex flex-col overflow-hidden',
        // 伪元素挂在直接子元素上,所以子元素必须是定位上下文。
        '[&>*:not(:last-child)]:relative',
        '[&>*:not(:last-child)]:after:pointer-events-none [&>*:not(:last-child)]:after:absolute',
        '[&>*:not(:last-child)]:after:inset-x-4 [&>*:not(:last-child)]:after:bottom-0',
        "[&>*:not(:last-child)]:after:h-px [&>*:not(:last-child)]:after:bg-border [&>*:not(:last-child)]:after:content-['']",
        SETTINGS_CARD_CLASS,
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * 设置页的一个分组:小标题 + 一张卡(或若干行)。
 *
 * 标题用**墨色**。Codex 的分区标题(`权限`/`常规`)实测是 `#0d0d0d` 的正文色,
 * 只有字号(13px)和字重(medium)把它与行标题区分开;用次级灰会让整页发浅。
 * 语义上用 `h3` 而不是 `label` —— 它不是控件的标签,是分区标题。
 */
export function SettingsSection({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-2.5', className)}>
      <h3 className="px-0.5 text-ui-compact font-medium text-foreground">{label}</h3>
      {children}
    </section>
  );
}

interface SettingsRowProps {
  /** 行标题:开关/选择器对应的设置项名称。 */
  label: ReactNode;
  /**
   * 行标题关联的控件 id —— 传了就渲染成 `<label>`,点标题能聚焦控件,
   * 读屏也能念出「标题 + 控件」的组合。开关这类用 `aria-label` 自带名字的
   * 控件不需要它。
   */
  htmlFor?: string;
  /** 补充说明:窄屏下另起一行占满宽度。 */
  description?: ReactNode;
  /** 右侧控件:开关、下拉、按钮等。 */
  control: ReactNode;
  /**
   * 紧凑控件(开关、小按钮)在窄屏放到标题右侧,只把说明挤到下一行;
   * 默认(false)适合下拉这类需要整行宽度的控件。
   */
  inlineControl?: boolean;
  /**
   * 控件在**宽屏也**留在文字下方并铺满整行(Codex 的 `variant="stacked"`):
   * 路径、多行输入框这类控件塞进 240px 的右列会被截断。
   */
  stacked?: boolean;
  /** 是否自带卡片(独立成块的单行用;同一张卡片内的多行用 `SettingsCard`)。 */
  surface?: boolean;
  /** 追加到控件格上的类:宽控件(如模式缩略图一排 272px)用它放宽 `sm:max-w-60`。 */
  controlClassName?: string;
  className?: string;
}

/**
 * 设置项行:左标题 + 右控件。
 *
 * 窄屏(手机/竖屏平板)下左右分栏会把说明文字压成竖排窄条,所以这里默认在
 * 640px 以下改为上下堆叠;宽屏(≥640px)恢复原来的左右布局。
 *
 * 用 grid 而不是两套 DOM:`inlineControl` 时开关留在标题右侧,说明换行到第二
 * 行;否则控件整行铺开。宽屏用 `sm:` 把控件放回右列,和改动前的桌面布局一致。
 *
 * 控件只在**有说明**时才跨两行(`sm:row-span-2`),让右侧控件相对「标题 + 说明」
 * 这个文字块居中。没有说明的行绝不能跨行:跨行后控件比文字高出来的那部分会被
 * 平均分给两条轨道,标题因此被顶到行的上四分之一 —— 模式行(60px 缩略图 + 一行
 * 标题)的「模式」两字就是这么做出来的。
 */
export function SettingsRow({
  label,
  htmlFor,
  description,
  control,
  inlineControl = false,
  stacked = false,
  surface = false,
  controlClassName,
  className,
}: SettingsRowProps) {
  return (
    <div
      className={cn(
        // 标题↔说明 2px(Codex 的 `gap-0.5`),窄屏堆叠时留 8px 免得控件贴住说明。
        'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 sm:gap-x-6 sm:gap-y-0.5',
        ROW_PADDING,
        surface && SETTINGS_CARD_CLASS,
        className,
      )}
    >
      {htmlFor ? (
        <label
          htmlFor={htmlFor}
          className="col-start-1 row-start-1 min-w-0 text-sm font-medium text-foreground"
        >
          {label}
        </label>
      ) : (
        <div className="col-start-1 row-start-1 min-w-0 text-sm font-medium text-foreground">
          {label}
        </div>
      )}
      <div
        className={cn(
          stacked
            ? cn(
                'col-span-2 w-full justify-self-stretch',
                description ? 'row-start-3' : 'row-start-2',
              )
            : cn(
                'min-w-0 self-center sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:w-auto sm:max-w-60 sm:justify-self-end',
                description && 'sm:row-span-2',
                inlineControl
                  ? 'col-start-2 row-start-1 justify-self-end'
                  // 没有说明文字时不要多占一行,否则会白流出一条 0 高度的行间隙。
                  : cn('col-span-2 w-full', description ? 'row-start-3' : 'row-start-2'),
              ),
          controlClassName,
        )}
      >
        {control}
      </div>
      {description ? (
        <p
          className={cn(
            // 行高等比收紧到 Codex 的 16px(描述都是短句,relaxed 会显得松散)。
            'col-span-2 col-start-1 row-start-2 max-w-[62ch] text-xs leading-snug text-muted-foreground',
            'sm:col-span-1',
          )}
        >
          {description}
        </p>
      ) : null}
    </div>
  );
}
