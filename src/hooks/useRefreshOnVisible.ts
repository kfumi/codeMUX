import { useEffect, useRef } from 'react';

/**
 * 窗口重新可见 / 重新获得焦点时立刻重算一次。
 *
 * ## 为什么需要它
 *
 * `backgroundThrottling`（Electron 默认开启）会在窗口被遮挡或失焦时把渲染进程当作
 * 后台页面：`requestAnimationFrame` 被暂停，`setInterval`/`setTimeout` 先被对齐到 1s，
 * 长时间后台后进一步降频到分钟级。这是**我们想要的**——窗口没人看的时候不该继续
 * 全速合成、跑轮询和动画。
 *
 * 但它带来一个观感问题：凡是"值按绝对时间算、靠定时器驱动刷新"的计时器，**值本身
 * 一直是对的**，只有**刷新时机**被推迟。用户切回来的第一眼会看到一两秒前的旧数字，
 * 报告出来就是"计时器卡住了"。
 *
 * 曾经的做法是干脆关掉整窗节流（`backgroundThrottling: false`）。那等于为了修一个
 * 显示时机问题，把遮挡期间的全部合成、轮询与动画都恢复成全速——代价远超收益。
 * 正确做法是保留节流，只在**恢复可见的那一帧**补一次刷新。
 *
 * ## 用法
 *
 * 传入的回调应当只做"按当前时刻重算并 setState"，不要在里面做重活：
 * 它会在每次 `visibilitychange`（由隐藏转为可见）和窗口 `focus` 时被调用一次。
 */
export function useRefreshOnVisible(refresh: () => void): void {
  const refreshRef = useRef(refresh);

  useEffect(() => {
    refreshRef.current = refresh;
  });

  useEffect(() => {
    const maybeRefresh = () => {
      // `focus` 也会在窗口本来可见时触发（点一下窗口内部），
      // 那种情况下重算一次也无害，但隐藏时一律不重算。
      if (!document.hidden) {
        refreshRef.current();
      }
    };

    document.addEventListener('visibilitychange', maybeRefresh);
    window.addEventListener('focus', maybeRefresh);
    return () => {
      document.removeEventListener('visibilitychange', maybeRefresh);
      window.removeEventListener('focus', maybeRefresh);
    };
  }, []);
}
