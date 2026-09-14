/**
 * 宿主能力清单(工单 02)。
 *
 * 单一事实来源仍是 [`CAPABILITY_MANIFEST`](../facades/capability-manifest.ts)
 * 的 owner 分类:daemon 拥有的能力是协议能力(三形态一致,用户故事 9),
 * shell 拥有的能力是壳独占(浏览器/移动隐藏而非报错,用户故事 10/11)。
 *
 * 组件只消费本清单,不再各自探测宿主(用户故事 16)。表现层差异(导航形态、
 * 窗口控件、通知通道)同样收在这里,供响应式适配复用。
 */
import {
  CAPABILITY_MANIFEST,
  type CapabilityEntry,
} from '../facades/capability-manifest';
import type { HostForm } from './host-form';

export interface HostPresentation {
  /** sidebar = 桌面常驻侧栏;drawer = 窄屏抽屉。 */
  navigation: 'sidebar' | 'drawer';
  /** 窗口最小化/最大化/关闭是否可见(仅壳内有真实窗口)。 */
  windowControls: boolean;
  /** 是否使用自绘标题栏(浏览器由宿主提供的标签页承担)。 */
  customTitleBar: boolean;
  /** 完成一轮对话后可用系统级通知(壳)。 */
  systemNotifications: boolean;
  /** 可用 Web Notification 作为非阻塞回退(浏览器/移动)。 */
  webNotifications: boolean;
}

export interface HostCapabilitySet {
  form: HostForm;
  presentation: HostPresentation;
  /** 该形态不可用的能力(浏览器/移动 = 壳独占能力)。 */
  unavailable: readonly string[];
  /** 该形态可用的全部能力 id。 */
  available: readonly string[];
  has(id: string): boolean;
}

const DAEMON_OWNED: CapabilityEntry[] = CAPABILITY_MANIFEST.filter(
  (entry) => entry.owner === 'daemon',
);
const SHELL_OWNED: CapabilityEntry[] = CAPABILITY_MANIFEST.filter(
  (entry) => entry.owner === 'shell',
);

const SHELL_ONLY_CAPABILITIES: readonly string[] = SHELL_OWNED.map((entry) => entry.id);

const PRESENTATION: Record<HostForm, HostPresentation> = {
  desktop: {
    navigation: 'sidebar',
    windowControls: true,
    customTitleBar: true,
    systemNotifications: true,
    webNotifications: false,
  },
  browser: {
    navigation: 'sidebar',
    windowControls: false,
    customTitleBar: false,
    systemNotifications: false,
    webNotifications: true,
  },
  mobile: {
    navigation: 'drawer',
    windowControls: false,
    customTitleBar: false,
    systemNotifications: false,
    webNotifications: true,
  },
};

function buildCapabilitySet(form: HostForm): HostCapabilitySet {
  const unavailable = form === 'desktop' ? [] : SHELL_ONLY_CAPABILITIES;
  const unavailableSet = new Set(unavailable);
  const available = form === 'desktop'
    ? CAPABILITY_MANIFEST.map((entry) => entry.id)
    : DAEMON_OWNED.map((entry) => entry.id).filter((id) => !unavailableSet.has(id));

  return {
    form,
    presentation: PRESENTATION[form],
    unavailable,
    available,
    has: (id: string) => available.includes(id),
  };
}

const CACHE = new Map<HostForm, HostCapabilitySet>();

export function capabilitiesForHost(form: HostForm): HostCapabilitySet {
  const cached = CACHE.get(form);
  if (cached) return cached;
  const built = buildCapabilitySet(form);
  CACHE.set(form, built);
  return built;
}
