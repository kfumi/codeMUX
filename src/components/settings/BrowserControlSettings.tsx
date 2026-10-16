import { useState } from 'react';

import { useHostCapabilities } from '../../hooks/useHostCapabilities';
import { shellFacade } from '../../lib/facades/shell-facade';
import { normalizeBrowserControl } from '../../lib/browserControl';
import { useSettingsStore } from '../../stores/settingsStore';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { SettingsCard, SettingsRow, SettingsSection } from './SettingsRow';

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
      <SettingsSection label="浏览器控制">
        <SettingsCard>
          <SettingsRow
            inlineControl
            label="开启内置浏览器控制"
            description="让后续会话能操作网页；关掉后相关工具不出现在会话里"
            control={
              <Switch
              aria-label="开启内置浏览器控制"
              checked={browser.enabled}
              onCheckedChange={(checked) => update({ enabled: checked })}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection label="安全">
        <SettingsCard>
          <SettingsRow
            inlineControl
            label="忽略证书校验"
            description="内置浏览器不再校验 HTTPS 证书，重启后生效"
            control={
              <Switch
              aria-label="忽略证书校验"
              checked={browser.ignore_certificate_errors}
              onCheckedChange={(checked) => update({ ignore_certificate_errors: checked })}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      {canClearHostData && (
        <SettingsSection label="浏览器数据">
          <SettingsCard>
            <SettingsRow
              inlineControl
              label="清除内置浏览器缓存"
              description="保留 Cookie 与站点数据，只清缓存与 Service Worker"
              control={
                <Button
                type="button"
                variant="secondary"
                size="xs"
                disabled={clearing !== null}
                onClick={() => void clearData('cache')}
              >
                {clearing === 'cache' ? '清除中…' : '清除缓存'}
              </Button>
              }
            />
            <SettingsRow
              inlineControl
              label="清除全部浏览器数据"
              description="删除 Cookie、站点数据与缓存，不可撤销"
              control={
                <Button
                type="button"
                variant="destructive"
                size="xs"
                disabled={clearing !== null}
                onClick={() => void clearData('all')}
              >
                {clearing === 'all' ? '清除中…' : '清除全部'}
              </Button>
              }
            />
          </SettingsCard>
        </SettingsSection>
      )}
    </div>
  );
}
