import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Smartphone } from 'lucide-react';

import {
  buildProfileFromOffer,
  buildProfileFromPairing,
  type ParsedPairingInput,
} from '@shared/lib/companion-connection';

import { claimPairingResolved, formatPairingClaimError } from '../lib/api';
import { saveProfile } from '../lib/storage';
import { suggestDeviceName } from '../lib/utils';

interface PairingScreenProps {
  parsedPairing: ParsedPairingInput | null;
  notice?: string | null;
  onPaired: () => void;
}

export function PairingScreen({ parsedPairing, notice = null, onPaired }: PairingScreenProps) {
  const deviceName = useMemo(() => suggestDeviceName(), []);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(Boolean(parsedPairing));
  const attempted = useRef(false);

  const performPairing = useCallback(async (input: ParsedPairingInput) => {
    if (!input.baseUrl || !input.pairingCode) {
      setError('配对链接无效，请让桌面刷新二维码后重试');
      setConnecting(false);
      return;
    }

    setConnecting(true);
    setError(null);
    try {
      const result = await claimPairingResolved(
        {
          baseUrl: input.baseUrl,
          pairingCode: input.pairingCode,
          offer: input.offer,
        },
        deviceName,
      );
      const desktopId = input.desktopId
        ?? input.offer?.desktopId
        ?? `legacy:${input.baseUrl}`;
      const profile = input.offer
        ? buildProfileFromOffer({
          offer: input.offer,
          baseUrl: input.baseUrl,
          deviceId: result.deviceId,
          token: result.token,
          label: deviceName,
        })
        : buildProfileFromPairing({
          desktopId,
          deviceId: result.deviceId,
          token: result.token,
          baseUrl: input.baseUrl,
          label: deviceName,
        });
      await saveProfile(profile);
      onPaired();
    } catch (err) {
      setError(formatPairingClaimError(err));
      setConnecting(false);
    }
  }, [deviceName, onPaired]);

  useEffect(() => {
    if (!parsedPairing || attempted.current) return;
    attempted.current = true;
    void performPairing(parsedPairing);
  }, [parsedPairing, performPairing]);

  if (!parsedPairing) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-8 text-center text-foreground">
        <Smartphone className="h-10 w-10 text-primary" />
        <div className="text-lg font-semibold">CodeMUX 移动伴侣</div>
        <p className="text-sm text-muted-foreground">
          请从桌面 CodeMUX 移动伴侣扫码，或打开桌面复制的配对链接。
        </p>
        {notice ? (
          <div className="rounded-xl border border-warning/20 bg-[hsl(var(--warning)/0.06)] px-4 py-3 text-sm text-muted-foreground">
            {notice}
          </div>
        ) : null}
      </div>
    );
  }

  if (connecting && !error) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-8 text-foreground">
        <div className="h-9 w-9 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <div className="text-sm text-muted-foreground">正在连接桌面…</div>
        {notice ? (
          <div className="rounded-xl border border-warning/20 bg-[hsl(var(--warning)/0.06)] px-4 py-3 text-center text-sm text-muted-foreground">
            {notice}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-8 text-center text-foreground">
      <div className="rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {error ?? '连接失败'}
      </div>
      <p className="text-sm text-muted-foreground">
        请返回桌面 CodeMUX，刷新二维码后重新扫码或打开链接。
      </p>
      {notice ? (
        <div className="rounded-xl border border-warning/20 bg-[hsl(var(--warning)/0.06)] px-4 py-3 text-sm text-muted-foreground">
          {notice}
        </div>
      ) : null}
    </div>
  );
}
