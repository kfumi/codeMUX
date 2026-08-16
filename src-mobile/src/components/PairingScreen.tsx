import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardPaste, Link2 } from 'lucide-react';

import {
  buildProfileFromPairing,
  parsePairingInput,
  type ParsedPairingInput,
} from '@shared/lib/companion-connection';

import { claimPairing, formatPairingClaimError } from '../lib/api';
import { saveProfile } from '../lib/storage';
import { cn, suggestDeviceName } from '../lib/utils';

interface PairingScreenProps {
  initialBaseUrl?: string;
  initialCode?: string;
  parsedPairing?: ParsedPairingInput | null;
  autoClaim?: boolean;
  notice?: string | null;
  onPaired: () => void;
}

export function PairingScreen({
  initialBaseUrl = '',
  initialCode = '',
  parsedPairing = null,
  autoClaim = false,
  notice = null,
  onPaired,
}: PairingScreenProps) {
  const [baseUrl, setBaseUrl] = useState(parsedPairing?.baseUrl ?? initialBaseUrl);
  const [code, setCode] = useState(parsedPairing?.pairingCode ?? initialCode);
  const defaultDeviceName = useMemo(() => suggestDeviceName(), []);
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showManualForm, setShowManualForm] = useState(!autoClaim);
  const autoClaimAttempted = useRef(false);

  const performPairing = useCallback(async (input?: ParsedPairingInput) => {
    const resolved = input ?? {
      baseUrl: baseUrl.trim().replace(/\/$/, ''),
      pairingCode: code.trim(),
      desktopId: parsedPairing?.desktopId,
      offer: parsedPairing?.offer,
    };
    if (!resolved.baseUrl || !resolved.pairingCode) {
      setError('请填写桌面地址与配对码');
      setShowManualForm(true);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await claimPairing(
        resolved.baseUrl,
        resolved.pairingCode,
        deviceName.trim() || defaultDeviceName,
      );
      const desktopId = resolved.desktopId
        ?? resolved.offer?.desktopId
        ?? `legacy:${resolved.baseUrl}`;
      await saveProfile(buildProfileFromPairing({
        desktopId,
        deviceId: result.deviceId,
        token: result.token,
        baseUrl: resolved.baseUrl,
        label: deviceName.trim() || defaultDeviceName,
      }));
      onPaired();
    } catch (err) {
      setError(formatPairingClaimError(err));
      setShowManualForm(true);
    } finally {
      setLoading(false);
    }
  }, [baseUrl, code, defaultDeviceName, deviceName, onPaired, parsedPairing]);

  useEffect(() => {
    if (!autoClaim || autoClaimAttempted.current) return;
    if (!parsedPairing?.baseUrl || !parsedPairing.pairingCode) return;
    autoClaimAttempted.current = true;
    void performPairing(parsedPairing);
  }, [autoClaim, parsedPairing, performPairing]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void performPairing();
  };

  const handlePasteLink = async () => {
    setError(null);
    try {
      const text = await navigator.clipboard.readText();
      const pageOrigin = `${window.location.protocol}//${window.location.host}`;
      const parsed = parsePairingInput(text, pageOrigin);
      setBaseUrl(parsed.baseUrl);
      setCode(parsed.pairingCode);
      setShowManualForm(true);
      await performPairing(parsed);
    } catch (err) {
      setError(String(err));
      setShowManualForm(true);
    }
  };

  const inputClassName = 'w-full rounded-xl border border-border bg-muted/40 px-4 py-3 outline-none transition-colors focus:border-primary/60 focus:bg-muted/60';

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="mobile-safe-header border-b border-border px-5">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <Link2 className="h-5 w-5 text-primary" />
          配对桌面 CodeMUX
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          在桌面端开启移动同步后扫码，或粘贴配对链接完成连接。
        </p>
      </header>

      <div className="flex flex-1 flex-col gap-4 px-5 py-6">
        {notice ? (
          <div className="rounded-xl border border-warning/20 bg-[hsl(var(--warning)/0.06)] px-4 py-3 text-sm text-muted-foreground">
            {notice}
          </div>
        ) : null}

        {loading && !showManualForm ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            正在配对…
          </div>
        ) : null}

        {showManualForm ? (
          <form className="flex flex-1 flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
            <button
              type="button"
              className="flex items-center justify-center gap-2 rounded-xl border border-border px-4 py-3 text-sm text-foreground/80"
              onClick={() => {
                void handlePasteLink();
              }}
              disabled={loading}
            >
              <ClipboardPaste className="h-4 w-4" />
              粘贴配对链接
            </button>

            <label className="space-y-2 text-sm">
              <span className="text-muted-foreground">桌面地址</span>
              <input
                className={inputClassName}
                placeholder="http://192.168.1.10:9240"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                required
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="text-muted-foreground">配对码</span>
              <input
                className={cn(inputClassName, 'tracking-[0.35em]')}
                placeholder="6 位数字"
                inputMode="numeric"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="text-muted-foreground">设备名称</span>
              <input
                className={inputClassName}
                placeholder="例如：小李的 iPhone"
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
              />
            </label>

            {error ? (
              <div className="rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={loading}
              className={cn(
                'mt-auto rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground',
                loading && 'opacity-60',
              )}
            >
              {loading ? '配对中…' : '完成配对'}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
