/**
 * 浏览器形态的通知回退(工单 03,用户故事 20)。
 *
 * 桌面壳的系统通知归属 main 进程;浏览器/移动形态没有壳,改用 Web
 * Notification 作为**可选、非阻塞**的回退:未授权时静默跳过,绝不在加载时
 * 弹权限请求。组件只消费本模块的纯判定与发送函数,不直接碰 `Notification`。
 */

export type WebNotificationSupport = 'unsupported' | 'default' | 'granted' | 'denied';

export type NotificationChannel = 'system' | 'web' | 'none';

export interface NotificationPresentation {
  systemNotifications: boolean;
  webNotifications: boolean;
}

function notificationCtor(): typeof Notification | undefined {
  if (typeof globalThis === 'undefined') return undefined;
  return (globalThis as { Notification?: typeof Notification }).Notification;
}

export function webNotificationSupport(): WebNotificationSupport {
  const Ctor = notificationCtor();
  if (!Ctor) return 'unsupported';
  const permission = Ctor.permission;
  if (permission === 'granted' || permission === 'denied' || permission === 'default') {
    return permission;
  }
  return 'default';
}

/**
 * 通知通道选择:`system` 优先(壳内通知能力最强),其次在浏览器明确已授权时
 * 走 `web`;两者都不可用时静默丢弃,而不是渲染层自己造一个假通知。
 */
export function resolveNotificationChannel(
  presentation: NotificationPresentation,
  support: WebNotificationSupport = webNotificationSupport(),
): NotificationChannel {
  if (presentation.systemNotifications) return 'system';
  if (presentation.webNotifications && support === 'granted') return 'web';
  return 'none';
}

/** 只有用户手势触发的调用点应调用本函数(浏览器要求用户激活)。 */
export async function requestWebNotificationPermission(): Promise<WebNotificationSupport> {
  const Ctor = notificationCtor();
  if (!Ctor) return 'unsupported';
  try {
    const permission = await Ctor.requestPermission();
    return permission === 'granted' || permission === 'denied' || permission === 'default'
      ? permission
      : 'default';
  } catch {
    return 'denied';
  }
}

export interface WebNotificationInput {
  title: string;
  body: string;
  sessionId: string;
}

/**
 * 发出 Web 通知。返回 false 表示没有发出(不支持/未授权/构造失败),调用方
 * 不需要区分 —— 通知是尽力而为的旁路。
 */
export function showWebNotification(
  input: WebNotificationInput,
  options: { onClick?: (sessionId: string) => void } = {},
): boolean {
  const Ctor = notificationCtor();
  if (!Ctor || Ctor.permission !== 'granted') return false;
  try {
    const notification = new Ctor(input.title, {
      body: input.body,
      // 同一会话的通知互相顶替,避免任务反复等待输入时堆一屏。
      tag: `codemux:${input.sessionId}`,
    });
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        // 浏览器可能拒绝 focus(非用户手势),忽略。
      }
      options.onClick?.(input.sessionId);
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}
