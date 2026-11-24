import { AlertCircle, Download, Loader2, PackageCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useHostCapabilities } from '@/hooks/useHostCapabilities';
import { useIsNarrowViewport } from '@/hooks/useIsNarrowViewport';
import { cn } from '@/lib/utils';

import { useUpdaterContext } from '../UpdaterProvider';
import { getUpdateEntryView, getUpdatePercent } from '../updateDisplay';
import { UpdateInstallGuideDialog } from './UpdateInstallGuideDialog';
import { UpdateProgressRing } from './UpdateProgressRing';

const TONE_ICON = {
  available: Download,
  // 「待安装」用「包裹已就绪」的图形,和「发现新版本(下载箭头)」区分开:
  // 下载箭头会让人以为还要再下一次。
  ready: PackageCheck,
  busy: Loader2,
  error: AlertCircle,
} as const;

/**
 * 更新入口 —— 一个**置底导航格**，不是标题栏按钮。
 *
 * 对齐 Codex：更新图标长在左侧图标轨的底部、压在设置之上（Codex 左下角就是
 * 「更新压齿轮」）。旧版把它放在标题栏左上角，与这一排窗口控件混在一起，是
 * codex 化之前的位置。
 *
 * 形态随宿主变：桌面图标轨里是 40×40 的透明热区，视觉是正中那枚**强调色实心圆**
 * （Codex 的「蓝圆 + 白箭头」）；窄屏抽屉页脚里是「图标 + 文字」的整行 —— 页脚
 * 没有 hover，文字必须露出来，也就不铺圆。两种形态的 `aria-label` 都取
 * `view.label`，测试与无障碍名不随形态漂移。
 *
 * 下载阶段两种形态都换成**进度环**：图标轨格放不下文字，环心显示百分比；窄屏行
 * 文字里本来就有百分比，环只画弧。环比「转圈 + 文字」多表达了「还剩多少」。
 *
 * 下载完成(`ready`)后入口仍可点：点开安装指引（保存内容 → 退出 → 向导安装），
 * 用户确认后应用才退出并交给 NSIS 安装向导 —— 下载不等于安装。
 */
export function UpdateEntry() {
  const updater = useUpdaterContext();
  // 工单 02:自动更新是壳独占能力,浏览器/移动形态隐藏入口而非留一个死按钮。
  const capabilities = useHostCapabilities();
  const isNarrow = useIsNarrowViewport();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [installGuideOpen, setInstallGuideOpen] = useState(false);
  const view = getUpdateEntryView(updater.stage, updater.progress, updater.error);
  const wasDownloading = useRef(false);

  // 下载刚完成(壳可能在被切走的设置页里触发)时自动弹出安装指引:用户点的是
  // 「开始下载」,下载完必须看到「下一步是什么」,而不是自己在图标轨里找变化。
  // 只在 downloading → ready 这一跳弹一次;用户关掉后不再反复弹。
  useEffect(() => {
    if (updater.stage === 'downloading') {
      wasDownloading.current = true;
      return;
    }
    if (updater.stage === 'ready' && wasDownloading.current) {
      wasDownloading.current = false;
      setInstallGuideOpen(true);
    }
  }, [updater.stage]);

  if (!view || !capabilities.has('updater')) {
    return null;
  }

  const Icon = TONE_ICON[view.tone];
  const downloading = updater.stage === 'downloading';
  const percent = getUpdatePercent(updater.progress);
  const installing = updater.stage === 'installing';

  // available → 确认后开始下载;ready → 安装指引;error → 先重新检查(拿到的
  // update handle 才能下载;失败后壳侧缓存的 handle 可能已失效),成功则回到确认框。
  const handleClick = () => {
    if (updater.stage === 'available') {
      setConfirmOpen(true);
      return;
    }
    if (updater.stage === 'ready') {
      setInstallGuideOpen(true);
      return;
    }
    if (updater.stage === 'error') {
      void updater
        .checkForUpdates({ interactive: true, announceNoUpdate: false, throwOnError: true })
        .then((update) => {
          if (update) {
            setConfirmOpen(true);
          }
        })
        .catch(() => {
          // checkForUpdates 自身已把 stage 置为 error 并带上原因。
        });
    }
  };

  // 窄屏页脚行:图标按语义着色,文字用前景色。
  const toneTextClass = cn(
    view.tone === 'available' && 'text-[hsl(var(--sidebar-accent))]',
    // 待安装是可执行动作,与「发现新版本」同一档强调色。
    view.tone === 'ready' && 'text-[hsl(var(--sidebar-accent))]',
    view.tone === 'busy' && 'text-muted-foreground',
    // 语义色直用,不叠透明度(见 AGENTS.md 文字对比两档规范)。
    view.tone === 'error' && 'text-destructive',
  );

  // 桌面形态照 Codex:强调色实心圆 + 反色图标(强调色 = 用户选的强调色种子,
  // 即 `--primary`)。失败态改走破坏色,形状不变。
  const circleClass = cn(
    'flex h-7 w-7 items-center justify-center rounded-full transition-opacity duration-fast group-hover:opacity-90',
    view.tone === 'error'
      ? 'bg-destructive text-destructive-foreground'
      : 'bg-primary text-primary-foreground',
  );

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={view.disabled}
            aria-label={view.label}
            onClick={handleClick}
            className={cn(
              isNarrow
                // 窄屏页脚行:压在侧栏面上,悬停档取侧栏那一档。
                ? cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-ui-meta transition-colors duration-fast hover:bg-[hsl(var(--sidebar-muted))]/82 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--sidebar-bg))]',
                    toneTextClass,
                  )
                // 桌面图标轨格:透明热区,视觉是里面那枚强调色圆(不铺方形悬停底)。
                : 'group relative flex h-10 w-10 shrink-0 items-center justify-center rounded-md transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--chrome-bg))]',
              'disabled:pointer-events-none disabled:opacity-60',
            )}
          >
            {downloading ? (
              isNarrow ? (
                <>
                  <UpdateProgressRing percent={percent} size={16} strokeWidth={2} />
                  <span className="flex-1 text-left">{view.label}</span>
                </>
              ) : (
                // 36px:40×40 热区里留 2px 呼吸,同时给环心的 9px 百分比留出读数空间。
                <UpdateProgressRing percent={percent} size={36} strokeWidth={3} label />
              )
            ) : isNarrow ? (
              <>
                <Icon
                  className={cn('h-4 w-4 shrink-0', view.tone === 'busy' && 'animate-spin')}
                  strokeWidth={1.75}
                />
                <span className="flex-1 text-left">{view.label}</span>
              </>
            ) : (
              <span className={circleClass}>
                <Icon
                  className={cn('h-4 w-4', view.tone === 'busy' && 'animate-spin')}
                  strokeWidth={2}
                />
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side={isNarrow ? 'top' : 'right'}>
          <p>{view.hint}</p>
        </TooltipContent>
      </Tooltip>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`下载更新 ${updater.version ?? ''}？`}
        description="将先在后台下载更新包，下载完成后会提示你退出应用并打开安装向导。"
        confirmLabel="开始下载"
        cancelLabel="稍后"
        onConfirm={() => {
          void updater.startUpdate();
        }}
      />

      <UpdateInstallGuideDialog
        open={installGuideOpen}
        onOpenChange={setInstallGuideOpen}
        version={updater.version}
        installing={installing}
        onConfirm={() => {
          void updater.installUpdate();
        }}
      />
    </>
  );
}
