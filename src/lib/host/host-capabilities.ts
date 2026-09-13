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
  /** 协议能力:三形态完整。 */
  protocolCapabilities: readonly string[];
  /** 壳独占能力清单(声明用)。 */
  shellOnlyCapabilities: readonly string[];
  /** 该形态不可用的能力(浏览器/移动 = 壳独占能力)。 */
  unavailable: readonly string[];
  /** 该形态可用的全部能力 id。 */
  available: readonly string[];
  has(id: string): boolean;
}

/**
 * 移动形态额外的能力收敛。协议能力必须保持完整(用户故事 9:终端、git、
 * workspace 文件在手机浏览器上同样可用),因此这里不放协议能力:移动与
 * 浏览器目前的差别是表现层(导航折叠、触控尺寸),而非能力面。
 */
export const MOBILE_ADDITIONAL_HIDDEN: readonly string[] = [];

const DAEMON_OWNED: CapabilityEntry[] = CAPABILITY_MANIFEST.filter(
  (entry) => entry.owner === 'daemon',
);
const SHELL_OWNED: CapabilityEntry[] = CAPABILITY_MANIFEST.filter(
  (entry) => entry.owner === 'shell',
);

const PROTOCOL_CAPABILITIES: readonly string[] = DAEMON_OWNED.map((entry) => entry.id);
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
  const unavailable = form === 'desktop'
    ? []
    : [...SHELL_ONLY_CAPABILITIES, ...(form === 'mobile' ? MOBILE_ADDITIONAL_HIDDEN : [])];
  const unavailableSet = new Set(unavailable);
  const available = form === 'desktop'
    ? CAPABILITY_MANIFEST.map((entry) => entry.id)
    : PROTOCOL_CAPABILITIES.filter((id) => !unavailableSet.has(id));

  return {
    form,
    presentation: PRESENTATION[form],
    protocolCapabilities: PROTOCOL_CAPABILITIES,
    shellOnlyCapabilities: SHELL_ONLY_CAPABILITIES,
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

/** 当前宿主的壳独占能力是否可用(组件分流入口)。 */
export function hostSupportsCapability(form: HostForm, id: string): boolean {
  return capabilitiesForHost(form).has(id);
}
