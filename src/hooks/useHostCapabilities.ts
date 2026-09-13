import { capabilitiesForHost, type HostCapabilitySet } from '../lib/host/host-capabilities';
import { useDaemonConnectionStore } from '../stores/daemonConnectionStore';

/**
 * 宿主能力清单(工单 02):组件据此分流,不再各自探测 Electron 桥。
 * 形态在页面生命周期内不变(壳桥存在与否;宽窄差异由 viewport 断点处理)。
 */
export function useHostCapabilities(): HostCapabilitySet {
  const hostForm = useDaemonConnectionStore((state) => state.hostForm);
  return capabilitiesForHost(hostForm);
}
