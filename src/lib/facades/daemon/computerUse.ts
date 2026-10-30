import { ensureDaemonClient } from './lifecycle';

/**
 * 电脑控制治理面(工单 06):驱动状态/诊断/启停/更新/允许范围/审计;
 * 工单 08 增加一键安装。
 */
export const computerUse = {
  respondToApproval: async (
    requestId: string,
    choice: 'once' | 'always' | 'reject',
  ) => {
    await (await ensureDaemonClient()).respondToComputerUseApproval(requestId, choice);
  },
  driverStatus: async () => (await ensureDaemonClient()).computerUseGet('/api/computer-use/driver'),
  diagnostics: async () =>
    (await ensureDaemonClient()).computerUsePost('/api/computer-use/driver/diagnose', {}),
  startDriver: async () =>
    (await ensureDaemonClient()).computerUsePost('/api/computer-use/driver/start', {}),
  estopDriver: async () =>
    (await ensureDaemonClient()).computerUsePost('/api/computer-use/driver/estop', {}),
  updateDriver: async () =>
    (await ensureDaemonClient()).computerUsePost('/api/computer-use/driver/update', { confirm: true }),
  installDriver: async () =>
    (await ensureDaemonClient()).computerUsePost('/api/computer-use/driver/install', {
      confirm: true,
    }),
  audit: async (limit = 50) =>
    (await ensureDaemonClient()).computerUseGet(`/api/computer-use/audit?limit=${limit}`),
};

export type ComputerUseDomain = typeof computerUse;
