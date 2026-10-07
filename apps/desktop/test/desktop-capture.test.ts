// 桌面只读观测(工单 04)main 侧契约测试:捕获依赖以替身注入,
// 覆盖窗口清单、缺省截主屏、指定来源、来源不存在、空图、活动窗口降级。
import { describe, expect, it, vi } from 'vitest';

import {
  activeDesktopWindow,
  captureDesktop,
  listDesktopSources,
  type DesktopCaptureDeps,
} from '../src/desktop-capture';

interface FakeSource {
  id: string;
  name: string;
  displayId?: string;
  thumbnail: {
    toPNG(): Uint8Array;
    getSize(): { width: number; height: number };
  };
}

function source(id: string, name: string, displayId?: string, size = { width: 1280, height: 720 }): FakeSource {
  return {
    id,
    name,
    displayId,
    thumbnail: {
      toPNG: () => new Uint8Array([1, 2, 3]),
      getSize: () => size,
    },
  };
}

function deps(overrides: Partial<DesktopCaptureDeps> = {}): DesktopCaptureDeps {
  const screens = [source('screen:0:0', '整个屏幕', '7', { width: 2560, height: 1440 })];
  const windows = [source('window:100:0', '记事本', undefined, { width: 0, height: 0 })];
  return {
    getSources: vi.fn(async ({ types }) => (types.includes('screen') ? screens : windows)),
    primaryDisplay: () => ({ id: 7, size: { width: 2560, height: 1440 } }),
    ...overrides,
  };
}

describe('listDesktopSources', () => {
  it('lists screens and windows without requesting thumbnails', async () => {
    const captureDeps = deps();
    const result = await listDesktopSources(captureDeps);

    expect(result).toEqual([
      { id: 'screen:0:0', name: '整个屏幕', kind: 'screen', displayId: '7' },
      { id: 'window:100:0', name: '记事本', kind: 'window' },
    ]);
    for (const call of vi.mocked(captureDeps.getSources).mock.calls) {
      expect(call[0].thumbnailSize).toEqual({ width: 0, height: 0 });
    }
  });
});

describe('captureDesktop', () => {
  it('defaults to the primary screen and downsizes 4K sources', async () => {
    const captureDeps = deps();
    const outcome = await captureDesktop(captureDeps, {});

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const payload = outcome.payload as { image: string; name: string; sourceId: string; width: number; kind: string };
      expect(payload.name).toBe('整个屏幕');
      expect(payload.sourceId).toBe('screen:0:0');
      expect(payload.kind).toBe('screen');
      expect(payload.image).toBe(Buffer.from([1, 2, 3]).toString('base64'));
      expect(payload.width).toBe(2560);
    }
    const screenCall = vi
      .mocked(captureDeps.getSources)
      .mock.calls.find((call) => call[0].types.includes('screen'));
    // 长边收敛到 1920,等比缩放。
    expect(screenCall?.[0].thumbnailSize).toEqual({ width: 1920, height: 1080 });
  });

  it('captures a named window source when asked', async () => {
    const captureDeps = deps();
    const outcome = await captureDesktop(captureDeps, { sourceId: 'window:100:0' });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect((outcome.payload as { name: string; kind: string }).name).toBe('记事本');
      expect((outcome.payload as { kind: string }).kind).toBe('window');
    }
  });

  it('reports an unknown source instead of guessing', async () => {
    const outcome = await captureDesktop(deps(), { sourceId: 'window:999:0' });
    expect(outcome).toEqual({
      ok: false,
      error: '找不到来源 window:999:0(先用 computer_windows 取最新清单)',
    });
  });

  it('reports an empty capture (minimized or closed window)', async () => {
    const captureDeps = deps({
      getSources: vi.fn(async ({ types }) =>
        types.includes('screen')
          ? [source('screen:0:0', '整个屏幕', '7')]
          : [
              {
                id: 'window:100:0',
                name: '已最小化',
                thumbnail: { toPNG: () => new Uint8Array(), getSize: () => ({ width: 0, height: 0 }) },
              },
            ],
      ),
    });

    const outcome = await captureDesktop(captureDeps, { sourceId: 'window:100:0' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('截图为空');
    }
  });

  it('reports a missing screen source when the host has no capture permission', async () => {
    const captureDeps = deps({ getSources: vi.fn(async () => []) });
    const outcome = await captureDesktop(captureDeps, {});
    expect(outcome.ok).toBe(false);
  });
});

describe('activeDesktopWindow', () => {
  it('matches the foreground window title to a capturable source', async () => {
    const captureDeps = deps({
      readForegroundWindow: async () => ({
        title: '记事本',
        processId: 4242,
        bounds: { x: 10, y: 20, width: 800, height: 600 },
      }),
    });

    const outcome = await activeDesktopWindow(captureDeps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.payload).toEqual({
        title: '记事本',
        processId: 4242,
        bounds: { x: 10, y: 20, width: 800, height: 600 },
        sourceId: 'window:100:0',
      });
    }
  });

  it('degrades with an explicit error when the platform cannot read the foreground window', async () => {
    const outcome = await activeDesktopWindow(deps());
    expect(outcome).toEqual({ ok: false, error: '活动窗口读取需要 Windows 桌面环境' });
  });

  it('does not pretend when there is no foreground title', async () => {
    const captureDeps = deps({ readForegroundWindow: async () => null });
    const outcome = await activeDesktopWindow(captureDeps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('没有可读的前台窗口');
    }
  });

  it('surfaces reader failures as errors', async () => {
    const captureDeps = deps({
      readForegroundWindow: async () => {
        throw new Error('powershell 不可用');
      },
    });
    const outcome = await activeDesktopWindow(captureDeps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('powershell 不可用');
    }
  });
});
