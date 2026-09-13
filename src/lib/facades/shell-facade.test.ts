// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

// 工单 09:desktopBridge 缺失(纯 Web/preload 未注入)时,壳门面方法显式报错的最小用例。
// 报错形态固定为 rejected Promise —— 渲染层普遍写 `void facade.x().catch(降级)`,
// 同步抛出会越过 .catch 冒到 React 错误边界(工单 02 回归:设置页整块渲染错误)。
vi.mock('../desktop-bridge', () => ({
  DESKTOP_BRIDGE_UNAVAILABLE_MESSAGE: 'codemuxDesktop 桥不可用(Electron preload 未注入)',
  desktopBridge: undefined,
}));

import { shellFacade } from './shell-facade';

describe('shell facade', () => {
  it('desktopBridge 缺失时壳方法以 rejected Promise 报错,不再有 invoke 回退', async () => {
    await expect(shellFacade.openInExplorer('D:/work')).rejects.toThrow('codemuxDesktop 桥不可用');
    await expect(shellFacade.openProjectPath('D:/work', 'file_explorer')).rejects.toThrow('codemuxDesktop 桥不可用');
    await expect(shellFacade.readHomeFile('.gitconfig')).rejects.toThrow('codemuxDesktop 桥不可用');
    await expect(shellFacade.getLogFiles()).rejects.toThrow('codemuxDesktop 桥不可用');
    await expect(shellFacade.sendAgentNotification({ title: 't', body: 'b', sessionId: 's' })).rejects.toThrow('codemuxDesktop 桥不可用');
  });

  it('桥缺失时不抛同步错误,调用方的 .catch 能接到降级分支', async () => {
    // 同步调用点:effect 里常见的 `facade.x().then(...).catch(...)`。
    // 若壳门面同步抛出,这一行会直接抛出去(老问题:冒到 React 错误边界)。
    const call = () => shellFacade.getAppDataDirectory().then(() => 'unexpected').catch(() => '降级');

    await expect(call()).resolves.toBe('降级');
  });

  it('浏览器形态的外链退化为新标签页,而不是死链', () => {
    // 外链是内容而非壳独占控件:桥缺失时必须仍能打开(工单 03)。
    const open = vi.fn();
    vi.stubGlobal('open', open);
    try {
      expect(() => shellFacade.openExternal('https://example.com')).not.toThrow();
      expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('窗口控制方法(自绘标题栏)在桥缺失时同样以 rejected Promise 报错', async () => {
    await expect(shellFacade.minimizeWindow()).rejects.toThrow('codemuxDesktop 桥不可用');
    await expect(shellFacade.toggleMaximizeWindow()).rejects.toThrow('codemuxDesktop 桥不可用');
    await expect(shellFacade.closeWindow()).rejects.toThrow('codemuxDesktop 桥不可用');
    await expect(shellFacade.isWindowMaximized()).rejects.toThrow('codemuxDesktop 桥不可用');
  });
});
