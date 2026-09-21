import { Loader2, MonitorSmartphone, RefreshCw, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { startLoopbackPairing, submitRemotePairing } from '@/lib/bootstrap';
import { useDaemonConnectionStore } from '@/stores/daemonConnectionStore';

/**
 * 浏览器形态的登录/引导界面(工单 02,用户故事 12)。
 *
 * - 同机(loopback):一次确认配对 —— 浏览器申请,桌面壳/CLI 确认,无需手工复制令牌。
 * - 跨机:输入桌面端地址 + 配对码,或直接打开扫码链接(由引导层自动 claim)。
 * 桌面壳形态永远不会看到本界面。
 */
export function PairingScreen() {
  const status = useDaemonConnectionStore((state) => state.status);
  const error = useDaemonConnectionStore((state) => state.error);
  const pairing = useDaemonConnectionStore((state) => state.pairing);
  const [code, setCode] = useState('');
  const [address, setAddress] = useState('');
  const [link, setLink] = useState('');

  const mode = pairing?.mode ?? 'remote';
  const phase = pairing?.phase ?? 'idle';
  const busy = status === 'connecting' || phase === 'claiming';

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10 text-foreground">
      <div className="surface-panel w-full max-w-md space-y-6 rounded-xl border border-border p-6 shadow-lg">
        <div className="space-y-2 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/12">
            <MonitorSmartphone className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <h1 className="text-ui-heading-sm text-foreground">连接到 CodeMUX</h1>
          <p className="text-ui-meta text-muted-foreground">
            {mode === 'loopback'
              ? '本机浏览器需要一次确认即可使用，无需复制令牌。'
              : '输入桌面端展示的配对码，或粘贴/打开配对链接。'}
          </p>
        </div>

        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-ui-caption text-destructive">
            {error}
          </div>
        ) : null}

        {mode === 'loopback' ? (
          <LoopbackPairing
            phase={phase}
            confirmCode={pairing?.code ?? null}
            busy={busy}
            failureMessage={pairing?.message ?? null}
          />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-ui-caption text-muted-foreground" htmlFor="pairing-code">
                配对码
              </label>
              <Input
                id="pairing-code"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="6 位数字"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="font-mono text-code tracking-[0.3em]"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-ui-caption text-muted-foreground" htmlFor="pairing-address">
                桌面端地址（可选）
              </label>
              <Input
                id="pairing-address"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder="192.168.1.8:9240"
                autoComplete="off"
                className="font-mono text-code"
              />
              <p className="text-ui-micro text-muted-foreground/80">
                扫码进入时无需填写，已由配对链接携带。
              </p>
            </div>
            <details className="rounded-lg border border-border/60 bg-muted/25 px-3 py-2">
              <summary className="cursor-pointer text-ui-caption text-muted-foreground">
                或粘贴配对链接
              </summary>
              <Input
                value={link}
                onChange={(event) => setLink(event.target.value)}
                placeholder="http://192.168.1.8:9240/#offer=..."
                className="mt-2 font-mono text-code"
              />
            </details>
            <Button
              className="w-full"
              disabled={busy || (!code.trim() && !link.trim())}
              onClick={() => void submitRemotePairing({ code, baseUrl: address, link })}
            >
              {phase === 'claiming' ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  正在配对…
                </>
              ) : (
                <>
                  <ShieldCheck className="h-4 w-4" aria-hidden />
                  配对
                </>
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function LoopbackPairing({
  phase,
  confirmCode,
  busy,
  failureMessage,
}: {
  phase: 'idle' | 'waiting' | 'claiming' | 'failed';
  confirmCode: string | null;
  busy: boolean;
  failureMessage: string | null;
}) {
  if (phase === 'waiting' && confirmCode) {
    return (
      <div className="space-y-4 text-center">
        <div className="space-y-1">
          <p className="text-ui-caption text-muted-foreground">确认码</p>
          <p className="font-mono text-3xl tracking-[0.4em] text-foreground">{confirmCode}</p>
        </div>
        <p className="text-ui-meta text-muted-foreground">
          请在 CodeMUX 桌面应用中确认本次配对（同一台电脑）。
        </p>
        <p className="flex items-center justify-center gap-2 text-ui-caption text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          等待桌面端确认…
        </p>
        <Button variant="ghost" className="w-full" onClick={() => void startLoopbackPairing()}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          重新发起
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {failureMessage ? (
        <p className="text-ui-caption text-destructive">{failureMessage}</p>
      ) : null}
      <Button className="w-full" disabled={busy} onClick={() => void startLoopbackPairing()}>
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            正在发起…
          </>
        ) : (
          <>
            <ShieldCheck className="h-4 w-4" aria-hidden />
            在本机浏览器使用
          </>
        )}
      </Button>
      <p className="text-ui-micro text-muted-foreground/80">
        桌面应用会弹出一次确认，确认后本浏览器即获得独立的访问令牌。
      </p>
    </div>
  );
}
