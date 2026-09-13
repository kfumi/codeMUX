// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

// 工单 09:desktopBridge 缺失(纯 Web/preload 未注入)时,壳门面方法显式报错的最小用例。
vi.mock('../desktop-bridge', () => ({
  desktopBridge: undefined,
  requireDesktopBridge: () => {
    throw new Error('codemuxDesktop 桥不可用(Electron preload 未注入)');
  },
}));

import { shellFacade } from './shell-facade';

describe('shell facade', () => {
  it('desktopBridge 缺失时壳方法显式报错,不再有 invoke 回退', () => {
    expect(() => shellFacade.openInExplorer('D:/work')).toThrow('codemuxDesktop 桥不可用');
    expect(() => shellFacade.openProjectPath('D:/work', 'file_explorer')).toThrow('codemuxDesktop 桥不可用');
    expect(() => shellFacade.readHomeFile('.gitconfig')).toThrow('codemuxDesktop 桥不可用');
    expect(() => shellFacade.getLogFiles()).toThrow('codemuxDesktop 桥不可用');
    expect(() => shellFacade.sendAgentNotification({ title: 't', body: 'b', sessionId: 's' })).toThrow('codemuxDesktop 桥不可用');
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

  it('窗口控制方法(自绘标题栏)在桥缺失时同样显式报错', () => {
    expect(() => shellFacade.minimizeWindow()).toThrow('codemuxDesktop 桥不可用');
    expect(() => shellFacade.toggleMaximizeWindow()).toThrow('codemuxDesktop 桥不可用');
    expect(() => shellFacade.closeWindow()).toThrow('codemuxDesktop 桥不可用');
    expect(() => shellFacade.isWindowMaximized()).toThrow('codemuxDesktop 桥不可用');
  });
});
