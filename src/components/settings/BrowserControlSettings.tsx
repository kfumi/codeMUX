import { useState } from 'react';

import { useHostCapabilities } from '../../hooks/useHostCapabilities';
import { shellFacade } from '../../lib/facades/shell-facade';
import { normalizeBrowserControl } from '../../lib/browserControl';
import { useSettingsStore } from '../../stores/settingsStore';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';

export function BrowserControlSettings() {
  const config = useSettingsStore((state) => state.config);
  const setBrowserControl = useSettingsStore((state) => state.setBrowserControl);
  const [clearing, setClearing] = useState<'cache' | 'all' | null>(null);
  // 站点数据属于壳内 WebView(浏览器宿主),浏览器/移动形态没有可清理的目标,
  // 隐藏该区块;开关本身写的是 daemon 配置,三形态一致可见。
  const capabilities = useHostCapabilities();
  const canClearHostData = capabilities.has('browser.host');

  if (!config) return null;

  const browser = normalizeBrowserControl(config.browser);

  const update = (patch: Partial<typeof browser>) => {
    void setBrowserControl({ ...browser, ...patch });
  };

  const clearData = async (scope: 'cache' | 'all') => {
    if (scope === 'all') {
      const confirmed = window.confirm('将删除内置浏览器中的 Cookie、站点数据和缓存。此操作不可撤销。');
      if (!confirmed) return;
    }
    setClearing(scope);
    try {
      await shellFacade.browser.clearData(scope);
    } finally {
      setClearing(null);
    }
  };

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-4 rounded-xl bg-muted/40 p-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground/90">开启内置浏览器控制</div>
            <p className="mt-1 text-xs leading-relaxed text-foreground/60">
              允许后续会话通过内置浏览器操作网页。此开关不影响侧边栏打开浏览器。
            </p>
          </div>
          <Switch
            aria-label="开启内置浏览器控制"
            checked={browser.enabled}
            onCheckedChange={(checked) => update({ enabled: checked })}
          />
        </div>
      </section>

      <section className="space-y-3">
        <label className="text-sm text-foreground/74">安全</label>
        <div className="flex items-center justify-between gap-4 rounded-xl bg-muted/40 p-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground/90">忽略证书校验</div>
            <p className="mt-1 text-xs leading-relaxed text-foreground/60">
              开启后内置浏览器不再校验 HTTPS 证书，仅影响内置浏览器。修改后需重启生效。
            </p>
          </div>
          <Switch
            aria-label="忽略证书校验"
            checked={browser.ignore_certificate_errors}
            onCheckedChange={(checked) => update({ ignore_certificate_errors: checked })}
          />
        </div>
      </section>

      {canClearHostData && (
        <section className="space-y-3">
          <label className="text-sm text-foreground/74">浏览器数据</label>
          <div className="space-y-3 rounded-xl bg-muted/40 p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground/90">清除内置浏览器缓存</div>
                <p className="mt-1 text-xs leading-relaxed text-foreground/60">
                  清除 HTTP 缓存、Cache Storage 和 Service Worker，保留 Cookie 和本地站点数据。
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={clearing !== null}
                onClick={() => void clearData('cache')}
              >
                {clearing === 'cache' ? '清除中…' : '清除缓存'}
              </Button>
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground/90">清除全部浏览器数据</div>
                <p className="mt-1 text-xs leading-relaxed text-foreground/60">
                  删除内置浏览器中的 Cookie、站点数据和缓存。此操作不可撤销。
                </p>
              </div>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={clearing !== null}
                onClick={() => void clearData('all')}
              >
                {clearing === 'all' ? '清除中…' : '清除全部'}
              </Button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
