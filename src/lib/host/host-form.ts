/**
 * 宿主形态判定(工单 02)。
 *
 * 统一前端有三种宿主形态,差异只在能力取舍与布局,不在代码分叉:
 * - `desktop`:Electron 壳(preload 注入 `window.codemuxDesktop`),全量能力。
 * - `browser`:PC 浏览器(含同机 loopback 与局域网),隐藏壳独占能力。
 * - `mobile`:手机/平板浏览器,在 browser 基础上改用抽屉式导航等窄屏表现。
 *
 * 判定必须可测:对外只暴露纯函数 + 一个读环境的薄封装,壳桥缺失不是错误,
 * 而是切换到浏览器引导策略的信号。
 */
import { desktopBridge } from '../desktop-bridge';

export type HostForm = 'desktop' | 'browser' | 'mobile';

export interface HostEnvironmentInput {
  hasShellBridge: boolean;
  userAgent?: string | null;
  viewportWidth?: number | null;
  maxTouchPoints?: number | null;
  origin?: string | null;
}

/** 窄屏阈值:与响应式断点一致,触屏且窄于该宽度按移动形态处理。 */
export const MOBILE_VIEWPORT_MAX_WIDTH = 820;

const MOBILE_USER_AGENT =
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|HarmonyOS/i;

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/** loopback 来源的同机浏览器:可走简化配对。 */
export function isLoopbackOrigin(origin?: string | null): boolean {
  if (!origin) return false;
  let hostname: string;
  try {
    hostname = normalizeHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
  return hostname === '127.0.0.1'
    || hostname === 'localhost'
    || hostname === '::1'
    || hostname.endsWith('.localhost');
}

export function looksLikeMobileClient(
  input: Pick<HostEnvironmentInput, 'userAgent' | 'viewportWidth' | 'maxTouchPoints'>,
): boolean {
  if (MOBILE_USER_AGENT.test(input.userAgent ?? '')) {
    return true;
  }
  const width = input.viewportWidth ?? null;
  if (width == null || width <= 0) {
    return false;
  }
  return (input.maxTouchPoints ?? 0) > 0 && width <= MOBILE_VIEWPORT_MAX_WIDTH;
}

export function detectHostForm(input: HostEnvironmentInput): HostForm {
  if (input.hasShellBridge) {
    return 'desktop';
  }
  return looksLikeMobileClient(input) ? 'mobile' : 'browser';
}

/** 读当前运行环境(无 window 的测试环境退化为「无桥的桌面尺寸浏览器」)。 */
export function readHostEnvironment(): HostEnvironmentInput {
  if (typeof window === 'undefined') {
    return { hasShellBridge: false };
  }
  return {
    hasShellBridge: Boolean(desktopBridge),
    userAgent: window.navigator?.userAgent ?? null,
    viewportWidth: window.innerWidth,
    maxTouchPoints: window.navigator?.maxTouchPoints ?? 0,
    origin: window.location?.origin ?? null,
  };
}
