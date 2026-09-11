import { AlertTriangle, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { daemonFacade } from '@/lib/facades/daemon-facade';
import { serializeError } from '@/lib/logger';
import { useDaemonStatusStore } from '@/stores/daemonStatusStore';
import { useSessionStore } from '@/stores/sessionStore';

/**
 * daemon 生命周期 overlay:supervisor 报告托管 daemon 意外退出或启动失败时,
 * 覆盖根视图并给出「重试」入口(经壳命令 daemon_restart 重启 daemon)。
 * 重试成功后清标记、重建 daemon client 并刷新会话列表。
 */
export function DaemonStatusOverlay() {
  const problem = useDaemonStatusStore((state) => state.problem);
  const error = useDaemonStatusStore((state) => state.error);
  const restarting = useDaemonStatusStore((state) => state.restarting);

  if (!problem) return null;

  const handleRetry = async () => {
    const status = useDaemonStatusStore.getState();
    status.setRestarting(true);
    try {
      // 惰性加载壳 facade:overlay 常驻 App 根,避免为断连场景提前拉起壳依赖。
      const { shellFacade } = await import('@/lib/facades/shell-facade');
      await shellFacade.daemonRestart();
      // daemon 可能换了端口:丢弃缓存的 client,下次调用重新解析。
      daemonFacade.resetClient();
      status.clearProblem();
      await useSessionStore.getState().fetchSessions();
    } catch (retryError) {
      useDaemonStatusStore.getState().setProblem('start-failed', serializeError(retryError));
      useDaemonStatusStore.getState().setRestarting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 backdrop-blur-sm">
      <div className="surface-panel w-full max-w-sm space-y-4 rounded-xl border border-border p-6 text-center shadow-lg">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-warning/15">
          <AlertTriangle className="h-6 w-6 text-warning" aria-hidden />
        </div>
        <div className="space-y-1.5">
          <p className="text-ui-title text-foreground">后台服务已断开</p>
          <p className="text-ui-meta text-muted-foreground">
            {problem === 'start-failed'
              ? '后台服务启动失败,会话数据暂不可用。'
              : '与后台服务的连接已中断,会话数据暂不可用。'}
          </p>
          {error ? (
            <p className="mx-auto max-w-xs break-all font-mono text-code text-muted-foreground">
              {error}
            </p>
          ) : null}
        </div>
        <Button onClick={() => void handleRetry()} disabled={restarting} className="w-full">
          <RefreshCw className={restarting ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden />
          {restarting ? '正在重启…' : '重试'}
        </Button>
      </div>
    </div>
  );
}
