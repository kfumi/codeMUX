import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ComputerUseSettings } from '../../types/provider';

/**
 * `PATCH /api/config` 的请求体在daemon 侧是 `PatchAppConfigRequest`
 * (`#[serde(rename_all = "camelCase")]`),外层键名一律 camelCase;
 * 但嵌进去的 `ComputerUseConfig` 没有 rename,字段保持 snake_case。
 *
 * 这两层大小写不一致,写错不会报错 —— serde 把未知字段丢掉,接口照样回 204,
 * 界面乐观显示"已保存"而 daemon 从未落盘(电脑控制开关曾因此永远不生效)。
 * 所以把线上键名钉在测试里。
 */
const patchAppConfig = vi.fn(async (_body: Record<string, unknown>) => {});
const health = vi.fn(async () => ({ ok: true }));

vi.mock('../daemon-client/client', () => ({
  createDaemonClient: () => ({ health, patchAppConfig }),
}));

vi.mock('../bootstrap', () => ({
  resolveDaemonConnectionConfig: async () => ({ baseUrl: 'http://127.0.0.1:1', token: 'test-token' }),
}));

const { daemonFacade } = await import('./daemon-facade');

const SETTINGS: ComputerUseSettings = {
  enabled: true,
  system_execution_enabled: true,
  allowlist: ['Notepad'],
  max_steps: 12,
  driver_command: 'cua-driver',
  driver_args: ['--stdio'],
  driver_update_command: null,
};

describe('daemonFacade config patch keys', () => {
  beforeEach(() => {
    patchAppConfig.mockClear();
  });

  it('patches the computer-control config under the camelCase key', async () => {
    await daemonFacade.setComputerUse(SETTINGS);

    expect(patchAppConfig).toHaveBeenCalledTimes(1);
    const body = patchAppConfig.mock.calls[0][0];
    expect(body).not.toHaveProperty('computer_use');
    expect(body.computerUse).toEqual(SETTINGS);
  });

  it('keeps the nested computer-use fields snake_case', async () => {
    await daemonFacade.setComputerUse(SETTINGS);

    const body = patchAppConfig.mock.calls[0][0] as { computerUse: Record<string, unknown> };
    expect(Object.keys(body.computerUse).sort()).toEqual([
      'allowlist',
      'driver_args',
      'driver_command',
      'driver_update_command',
      'enabled',
      'max_steps',
      'system_execution_enabled',
    ]);
  });
});