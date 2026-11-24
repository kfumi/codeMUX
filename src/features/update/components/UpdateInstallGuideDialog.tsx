import { ArrowRight, CheckCircle2, MonitorDown, Power } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * 安装指引 —— 更新包下载完成后的「下一步」。
 *
 * 为什么要有这一步:下载完成不等于可以装。应用要退出、安装向导要接管,用户
 * 必须知道「现在会发生什么」并明确同意。之前下载完就直接静默替换 + 自动重启,
 * 用户既没有确认机会,也看不到安装过程,出问题时完全不知道发生了什么。
 *
 * 步骤口径与 NSIS 安装向导一致(应用退出 → 向导安装 → 完成),所以用户点完
 * 「退出并安装」后看到的界面和手动装新版一模一样。
 */
export interface UpdateInstallGuideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version?: string;
  /** 用户确认后:退出应用并把已下载的包交给安装向导。 */
  onConfirm: () => void;
  /** 指引打开期间(已确认、等待退出)的加载态。 */
  installing?: boolean;
}

const STEPS = [
  {
    Icon: CheckCircle2,
    title: '保存正在编辑的内容',
    description: '应用会立即退出，未保存的输入不会保留。',
  },
  {
    Icon: Power,
    title: '应用退出并打开安装向导',
    description: '后台的本地服务会随应用一起停止，重新打开后自动恢复。',
  },
  {
    Icon: MonitorDown,
    title: '按向导完成安装',
    description: '点「下一步」走完向导即可；结束页保持勾选「运行 CodeMUX」就回到新版本。',
  },
] as const;

export function UpdateInstallGuideDialog({
  open,
  onOpenChange,
  version,
  onConfirm,
  installing = false,
}: UpdateInstallGuideDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => {
      // 已确认安装(应用正在退出)时不允许再关掉对话框,避免状态看起来「取消」了。
      if (!installing) {
        onOpenChange(next);
      }
    }}>
      <DialogContent
        overlayClassName="z-[240]"
        className="z-[240] gap-0 p-0 sm:max-w-105"
      >
        <DialogHeader className="px-6 pb-4 pt-6">
          <DialogTitle className="text-base leading-tight">
            安装更新{version ? ` ${version}` : ''}
          </DialogTitle>
          <DialogDescription className="text-ui-compact leading-relaxed text-muted-foreground">
            更新包已下载完成。安装需要退出应用并走一遍安装向导。
          </DialogDescription>
        </DialogHeader>

        <ol className="space-y-3 px-6 pb-5">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex items-start gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--foreground)/0.06)] text-ui-micro font-medium tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              <div className="min-w-0 space-y-0.5">
                <p className="flex items-center gap-1.5 text-ui-compact font-medium text-foreground">
                  <step.Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  {step.title}
                </p>
                <p className="text-ui-meta leading-snug text-muted-foreground">{step.description}</p>
              </div>
            </li>
          ))}
        </ol>

        <DialogFooter className="gap-2 border-t border-border/40 bg-muted/30 px-6 py-4">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-3.5 text-ui-compact"
            disabled={installing}
            onClick={() => onOpenChange(false)}
          >
            稍后
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1.5 px-3.5 text-ui-compact"
            disabled={installing}
            onClick={onConfirm}
          >
            {installing ? '正在退出…' : '退出并安装'}
            {!installing && <ArrowRight className="h-3.5 w-3.5" />}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
