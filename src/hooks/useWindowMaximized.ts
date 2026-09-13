import { useEffect, useState } from 'react';

import { desktopBridge } from '../lib/desktop-bridge';

/**
 * 桌面壳窗口是否处于最大化(浏览器形态恒为 false)。
 *
 * 供布局层分流「只在窗口化时成立的装饰」使用——例如主内容面板左上/左下那对
 * 圆角缺口:窗口一旦最大化,面板左缘就贴着屏幕边缘,再留圆角只剩一条没来由的
 * 缺角,应当退化为直线。最大化态经壳桥 window-maximize-changed 事件(与标题栏
 * 的最大化图标同源)订阅,桥缺失时不订阅也不报错。
 */
export function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!desktopBridge) return;
    let disposed = false;

    desktopBridge.isWindowMaximized()
      .then((value) => {
        if (!disposed) setMaximized(value);
      })
      .catch(() => {
        // 壳不可用/查询失败时保持默认(非最大化),不阻塞布局。
      });

    const unsubscribe = desktopBridge.onDesktopEvent('window-maximize-changed', (payload) => {
      setMaximized(payload === true);
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  return maximized;
}
