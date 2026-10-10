// 壳侧急停出口(工单 03)契约测试:一次 Esc 只调「停干净」端点;只有旧 daemon(端点
// 不存在,404)才退回旧路径(通知渲染层 + 杀驱动);其它失败照原样抛出。
import { describe, expect, it, vi } from 'vitest';

import {
  COMPUTER_USE_DRIVER_ESTOP_PATH,
  COMPUTER_USE_ESTOP_PATH,
  DaemonHttpError,
  createEstopEndpoint,
} from '../src/computer-use-estop';

type Post = (path: string, body: Record<string, unknown>) => Promise<void>;

function deps(overrides: { post?: Post } = {}) {
  return {
    post: vi.fn(overrides.post ?? (async () => {})),
    notifyRenderer: vi.fn(),
    log: vi.fn(),
  };
}

/** 旧的 daemon:只有 driver/estop 端点。 */
const oldDaemon: Post = async (path) => {
  if (path === COMPUTER_USE_ESTOP_PATH) {
    throw new DaemonHttpError(404);
  }
};

describe('壳侧急停出口(工单 03)', () => {
  it('一次 Esc → 只调「停干净」端点(驱动、授权、回合都由 daemon 收口)', async () => {
    const d = deps();
    await createEstopEndpoint(d).estopEverything();

    expect(d.post).toHaveBeenCalledTimes(1);
    expect(d.post).toHaveBeenCalledWith(COMPUTER_USE_ESTOP_PATH, {});
    // 新 daemon 上不再需要渲染层那一半(回合由 daemon 打断,界面从事件里知道结果)。
    expect(d.notifyRenderer).not.toHaveBeenCalled();
  });

  it('端点不存在(旧 daemon)→ 退回 driver/estop + 通知渲染层打断回合', async () => {
    const d = deps({ post: oldDaemon });
    await createEstopEndpoint(d).estopEverything();

    expect(d.post.mock.calls.map(([path]) => path)).toEqual([
      COMPUTER_USE_ESTOP_PATH,
      COMPUTER_USE_DRIVER_ESTOP_PATH,
    ]);
    expect(d.notifyRenderer).toHaveBeenCalledTimes(1);
    expect(d.log).toHaveBeenCalledWith('warn', expect.stringContaining('旧版本'));
  });

  it('通知渲染层抛错不拦住杀驱动(停机器比通知界面要紧)', async () => {
    const d = deps({ post: oldDaemon });
    d.notifyRenderer.mockImplementation(() => {
      throw new Error('渲染进程没了');
    });

    await createEstopEndpoint(d).estopEverything();

    expect(d.post).toHaveBeenCalledWith(COMPUTER_USE_DRIVER_ESTOP_PATH, {});
    expect(d.log).toHaveBeenCalledWith('error', expect.stringContaining('通知渲染层失败'));
  });

  it('其它失败原样抛出,不当作旧版本(daemon 断连 / 500 都不是「端点不存在」)', async () => {
    const serverError = deps({
      post: async () => {
        throw new DaemonHttpError(500);
      },
    });
    await expect(createEstopEndpoint(serverError).estopEverything()).rejects.toThrow('daemon 返回 500');
    expect(serverError.notifyRenderer).not.toHaveBeenCalled();

    const offline = deps({
      post: async () => {
        throw new Error('daemon 未就绪');
      },
    });
    await expect(createEstopEndpoint(offline).estopEverything()).rejects.toThrow('daemon 未就绪');
    expect(offline.post).toHaveBeenCalledTimes(1);
  });
});
