import { FormEvent, useState } from 'react';
import { Link2 } from 'lucide-react';

import { claimPairing } from '../lib/api';
import { saveConnection } from '../lib/storage';
import { cn } from '../lib/utils';

interface PairingScreenProps {
  initialBaseUrl?: string;
  initialCode?: string;
  onPaired: () => void;
}

export function PairingScreen({ initialBaseUrl = '', initialCode = '', onPaired }: PairingScreenProps) {
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [code, setCode] = useState(initialCode);
  const [deviceName, setDeviceName] = useState('我的手机');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const normalizedBaseUrl = baseUrl.trim().replace(/\/$/, '');
      const result = await claimPairing(normalizedBaseUrl, code.trim(), deviceName.trim());
      await saveConnection({
        baseUrl: normalizedBaseUrl,
        token: result.token,
        deviceId: result.deviceId,
      });
      onPaired();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-slate-950 text-slate-100">
      <header className="border-b border-white/10 px-5 pb-5 pt-10">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <Link2 className="h-5 w-5 text-sky-400" />
          配对桌面 CodeMUX
        </div>
        <p className="mt-2 text-sm text-slate-400">
          在桌面端设置中开启移动同步，然后输入局域网地址与配对码。
        </p>
      </header>

      <form className="flex flex-1 flex-col gap-4 px-5 py-6" onSubmit={(event) => void handleSubmit(event)}>
        <label className="space-y-2 text-sm">
          <span className="text-slate-300">桌面地址</span>
          <input
            className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 outline-none focus:border-sky-400"
            placeholder="http://192.168.1.10:9240"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            required
          />
        </label>

        <label className="space-y-2 text-sm">
          <span className="text-slate-300">配对码</span>
          <input
            className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 tracking-[0.35em] outline-none focus:border-sky-400"
            placeholder="6 位数字"
            inputMode="numeric"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
        </label>

        <label className="space-y-2 text-sm">
          <span className="text-slate-300">设备名称</span>
          <input
            className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 outline-none focus:border-sky-400"
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
          />
        </label>

        {error ? <div className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div> : null}

        <button
          type="submit"
          disabled={loading}
          className={cn(
            'mt-auto rounded-xl bg-sky-500 px-4 py-3 text-sm font-medium text-slate-950',
            loading && 'opacity-60',
          )}
        >
          {loading ? '配对中…' : '完成配对'}
        </button>
      </form>
    </div>
  );
}
