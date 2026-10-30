import type { DaemonClient, DaemonConnectionConfig } from '../../daemon-client/client';
import { createDaemonClient } from '../../daemon-client/client';
import { resolveDaemonConnectionConfig } from '../../bootstrap';

let activeClient: DaemonClient | null = null;
let clientInitPromise: Promise<DaemonClient> | null = null;

export async function ensureDaemonClient(): Promise<DaemonClient> {
  if (activeClient) return activeClient;
  if (!clientInitPromise) {
    clientInitPromise = (async () => {
      // 工单 02:连接来源由宿主引导单入口决定(壳桥注入 / 浏览器配对档案)。
      const config: DaemonConnectionConfig = await resolveDaemonConnectionConfig();
      const client = createDaemonClient(config);
      await client.health().catch(() => {
        throw new Error('无法连接到 CodeMUX 后台服务，请稍后重试。');
      });
      activeClient = client;
      return activeClient;
    })().catch((error) => {
      clientInitPromise = null;
      throw error;
    });
  }
  return clientInitPromise;
}

export function resetDaemonClient(): void {
  activeClient = null;
  clientInitPromise = null;
}
