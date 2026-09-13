import { Loader2 } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

import { bootstrapDaemonConnection } from '@/lib/bootstrap';
import { useDaemonConnectionStore } from '@/stores/daemonConnectionStore';

import { PairingScreen } from './PairingScreen';

/**
 * 宿主引导闸门(工单 02):在挂载完整界面前决定「已连接 / 连接中 / 需要配对」。
 *
 * 桌面壳形态保持既有行为(连接失败不阻塞界面,由 App 内的覆盖层提供重试);
 * 浏览器/移动形态在拿到可用连接前显示引导界面,避免一组必然失败的请求把
 * 界面渲染成空壳(用户故事 12)。
 */
export function HostBootstrapGate({ children }: { children: ReactNode }) {
  const hostForm = useDaemonConnectionStore((state) => state.hostForm);
  const status = useDaemonConnectionStore((state) => state.status);

  useEffect(() => {
    void bootstrapDaemonConnection();
  }, []);

  if (hostForm === 'desktop') {
    return <>{children}</>;
  }

  if (status === 'connected') {
    return <>{children}</>;
  }

  if (status === 'idle' || status === 'connecting') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
        <p className="text-ui-meta">正在连接 CodeMUX 后台服务…</p>
      </div>
    );
  }

  return <PairingScreen />;
}
