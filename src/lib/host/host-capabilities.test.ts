import { describe, expect, it } from 'vitest';

import { CAPABILITY_MANIFEST } from '../facades/capability-manifest';
import { capabilitiesForHost } from './host-capabilities';
import type { HostForm } from './host-form';

describe('host-capabilities', () => {
  const desktop = capabilitiesForHost('desktop');
  const browser = capabilitiesForHost('browser');
  const mobile = capabilitiesForHost('mobile');
  const daemonIds = CAPABILITY_MANIFEST.filter((entry) => entry.owner === 'daemon').map((e) => e.id);
  const shellIds = CAPABILITY_MANIFEST.filter((entry) => entry.owner === 'shell').map((e) => e.id);

  it('keeps every protocol capability in all three host forms', () => {
    for (const form of ['desktop', 'browser', 'mobile'] as HostForm[]) {
      const set = capabilitiesForHost(form);
      for (const id of daemonIds) {
        expect(set.has(id), `${form} 缺少协议能力 ${id}`).toBe(true);
      }
    }
  });

  it('nests desktop ⊇ browser ⊇ mobile', () => {
    const desktopSet = new Set(desktop.available);
    const browserSet = new Set(browser.available);

    for (const id of browser.available) {
      expect(desktopSet.has(id), `桌面应包含浏览器能力 ${id}`).toBe(true);
    }
    for (const id of mobile.available) {
      expect(browserSet.has(id), `浏览器应包含移动能力 ${id}`).toBe(true);
    }
    expect(desktop.available.length).toBeGreaterThanOrEqual(browser.available.length);
    expect(browser.available.length).toBeGreaterThanOrEqual(mobile.available.length);
  });

  it('hides shell-only capabilities outside the desktop shell', () => {
    expect(desktop.unavailable).toHaveLength(0);
    for (const id of shellIds) {
      expect(desktop.has(id), `壳内应具备壳独占能力 ${id}`).toBe(true);
      expect(browser.has(id), `浏览器应隐藏 ${id}`).toBe(false);
      expect(mobile.has(id), `移动应隐藏 ${id}`).toBe(false);
    }
  });

  it('exposes browser host, updater and window controls only in the shell', () => {
    expect(desktop.has('browser.host')).toBe(true);
    expect(browser.has('browser.host')).toBe(false);
    expect(mobile.has('browser.host')).toBe(false);

    expect(desktop.has('updater')).toBe(true);
    expect(browser.has('updater')).toBe(false);

    expect(desktop.presentation.windowControls).toBe(true);
    expect(browser.presentation.windowControls).toBe(false);
    expect(mobile.presentation.windowControls).toBe(false);
  });

  it('encodes layout-level host differences in the presentation', () => {
    expect(desktop.presentation.navigation).toBe('sidebar');
    expect(browser.presentation.navigation).toBe('sidebar');
    expect(mobile.presentation.navigation).toBe('drawer');

    expect(desktop.presentation.systemNotifications).toBe(true);
    expect(desktop.presentation.webNotifications).toBe(false);
    expect(browser.presentation.webNotifications).toBe(true);
    expect(mobile.presentation.webNotifications).toBe(true);
  });

  it('caches one capability set per host form', () => {
    expect(capabilitiesForHost('browser')).toBe(browser);
  });
});
