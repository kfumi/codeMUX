import type {
  ManagedRuntimeCheckResult,
  ManagedRuntimeInfo,
  ManagedRuntimeOperationResult,
} from '../../runtimeTypes';
import { ensureDaemonClient } from './lifecycle';

/** 受管运行时(CLI 安装/升级/修复)。 */
export const runtime = {
  check: async (): Promise<ManagedRuntimeCheckResult> =>
    (await ensureDaemonClient()).checkManagedRuntimes() as Promise<ManagedRuntimeCheckResult>,
  listVersions: async (provider: string): Promise<string[]> =>
    (await ensureDaemonClient()).managedRuntimeListVersions(provider) as Promise<string[]>,
  refresh: async (provider: string): Promise<ManagedRuntimeInfo> =>
    (await ensureDaemonClient()).managedRuntimeRefresh(provider) as Promise<ManagedRuntimeInfo>,
  install: async (provider: string, version?: string): Promise<ManagedRuntimeOperationResult> =>
    (await ensureDaemonClient()).managedRuntimeInstall(provider, version) as Promise<ManagedRuntimeOperationResult>,
  upgrade: async (provider: string): Promise<ManagedRuntimeOperationResult | null> =>
    (await ensureDaemonClient()).managedRuntimeUpgrade(provider) as Promise<ManagedRuntimeOperationResult | null>,
  repair: async (provider: string): Promise<ManagedRuntimeOperationResult | null> =>
    (await ensureDaemonClient()).managedRuntimeRepair(provider) as Promise<ManagedRuntimeOperationResult | null>,
  remove: async (provider: string) => {
    await (await ensureDaemonClient()).managedRuntimeRemove(provider);
  },
};

export type RuntimeDomain = typeof runtime;
