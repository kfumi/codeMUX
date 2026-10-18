import { Radio } from 'lucide-react';

import { useSettingsStore } from '../../stores/settingsStore';
import { cn } from '../../lib/utils';
import { TooltipHint } from '../ui/tooltip';

/**
 * 图标轨上的 Proxy 状态灯。
 *
 * 原先它长在侧栏页脚：一颗圆点 + 「Proxy :4312」文字。搬到 56px 宽的图标轨后放不下文字，
 * 于是把状态交给**图标颜色**——运行中是成功色（与正下方的移动伴侣同一套语言：绿 = 通着），
 * 未运行是次级文字色；端口与来源留在 tooltip 里，信息一点没丢。
 *
 * 试过「中性图标 + 右上角一颗状态灯」，在 40×40 的格子里那颗灯离图标太远，看着像浮在
 * 按钮角上的一粒灰；压到图标肩上又会撞上 Radio 那两道弧。这个尺寸下颜色就是最干净的表达。
 *
 * 它是**只读状态**，不是按钮：点它没有任何去处，做成按钮只会骗一次点击。为了让键盘用户
 * 也能读到 tooltip，它仍然可聚焦（`tabIndex` + `role="status"`），焦点环与图标轨其余按钮同一套。
 */
export function ProxyRailStatus() {
  const proxyRunning = useSettingsStore((state) => state.proxyRunning);
  const proxyUrl = useSettingsStore((state) => state.proxyUrl);
  const port = proxyUrl?.match(/:(\d+)$/)?.[1];
  const label = proxyRunning ? `Proxy 运行中${port ? ` · :${port}` : ''}` : 'Proxy 未运行';

  return (
    <TooltipHint
      side="right"
      content={
        <>
          <p className="font-medium">{label}</p>
          <p>
            {proxyRunning
              ? `由当前 Codex 会话自动运行${proxyUrl ? `（${proxyUrl}）` : ''}`
              : '由 Codex 档案在会话启动时按需运行'}
          </p>
        </>
      }
    >
      <span
        role="status"
        tabIndex={0}
        aria-label={label}
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-md outline-none',
          proxyRunning ? 'text-[hsl(var(--success-vivid))]' : 'text-muted-foreground',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--chrome-bg))]',
        )}
      >
        <Radio className="h-[18px] w-[18px]" strokeWidth={1.75} />
      </span>
    </TooltipHint>
  );
}
