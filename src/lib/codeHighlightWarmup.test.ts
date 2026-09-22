// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 预热走的是 `@streamdown/code` 的**公开**入口 `code.highlight()`，所以这里可以整体替换掉它，
 * 用"调用次数与参数"来锁住行为——本仓库不测毫秒，只锁"做了几次、按什么顺序、传了什么"。
 * `./logger` 也替换掉：既让失败路径的断言可行（"失败不能静默"），也避免测试输出噪声。
 */
const recorder = vi.hoisted(() => ({
  calls: [] as Array<{ code: string; language: string; themes: unknown }>,
  throwingLanguages: new Set<string>(),
  /** 插件自己的主题数组：预热必须原样用它，而不是自造一份（否则缓存键对不上）。 */
  themes: ['github-light', 'github-dark'] as unknown[],
  warnings: [] as Array<{ message: string; context?: unknown }>,
}));

vi.mock('@streamdown/code', () => ({
  code: {
    getThemes: () => recorder.themes,
    highlight: (
      options: { code: string; language: string; themes: unknown },
      callback?: (result: unknown) => void,
    ) => {
      if (recorder.throwingLanguages.has(options.language)) {
        throw new Error(`warmup failed for ${options.language}`);
      }
      recorder.calls.push({
        code: options.code,
        language: options.language,
        themes: options.themes,
      });
      callback?.(null);
      return null;
    },
  },
}));

vi.mock('./logger', () => ({
  logger: {
    warn: (message: string, context?: unknown) => {
      recorder.warnings.push({ message, context });
    },
  },
}));

import {
  DEFAULT_WARM_LANGUAGES,
  primeCodeHighlighting,
  resetCodeHighlightWarmupForTests,
} from './codeHighlightWarmup';

interface FakeDeadline {
  didTimeout: boolean;
  timeRemaining: () => number;
}

/** 被替换的空闲队列：测试自己决定"什么算空闲"。 */
const idleQueue: Array<(deadline: FakeDeadline) => void> = [];
/** 下一次投递的 deadline。真实 Chromium 在超时强制投递时会传 `didTimeout: true`、预算 0。 */
let nextDeadline: FakeDeadline = { didTimeout: false, timeRemaining: () => 50 };

function installIdleStub(): void {
  Object.defineProperty(window, 'requestIdleCallback', {
    configurable: true,
    writable: true,
    value: (callback: (deadline: FakeDeadline) => void) => {
      idleQueue.push(callback);
      return idleQueue.length;
    },
  });
}

function removeIdleStub(): void {
  Reflect.deleteProperty(window, 'requestIdleCallback');
}

/** 让动态 import + promise 链跑完（预热结果是异步拿到的，同步断言会读到空）。 */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 只放行一个空闲回调，用来证明"一次空闲时段只手热一种语言"。 */
async function runOneIdleCallback(): Promise<void> {
  const callback = idleQueue.shift();
  callback?.(nextDeadline);
  await flushMicrotasks();
}

async function drainIdleQueue(): Promise<void> {
  while (idleQueue.length > 0) {
    await runOneIdleCallback();
  }
}

beforeEach(() => {
  recorder.calls.length = 0;
  recorder.throwingLanguages.clear();
  recorder.warnings.length = 0;
  idleQueue.length = 0;
  nextDeadline = { didTimeout: false, timeRemaining: () => 50 };
  resetCodeHighlightWarmupForTests();
  installIdleStub();
});

afterEach(() => {
  removeIdleStub();
  vi.useRealTimers();
});

describe('codeHighlightWarmup', () => {
  it('不在启动路径上同步预热，只排一次空闲回调', () => {
    primeCodeHighlighting(['typescript']);

    expect(recorder.calls).toHaveLength(0);
    expect(idleQueue).toHaveLength(1);
  });

  it('逐个空闲回调预热：一次一种，最终每种语言恰好一次', async () => {
    primeCodeHighlighting(['typescript', 'bash', 'json']);

    await runOneIdleCallback();
    expect(recorder.calls.map((call) => call.language)).toEqual(['typescript']);
    // 关键：下一种语言是**排进空闲队列**的，而不是在同一次回调里接着做。
    expect(idleQueue).toHaveLength(1);

    await drainIdleQueue();
    expect(recorder.calls.map((call) => call.language)).toEqual(['typescript', 'bash', 'json']);
  });

  it('把插件自己的双主题原样交给 highlight', async () => {
    primeCodeHighlighting(['typescript']);
    await drainIdleQueue();

    expect(recorder.calls).toHaveLength(1);
    // 身份相等而不是内容相等：`Streamdown` 用的是 `plugins.code.getThemes()`，
    // 自造一份主题数组会让 highlighter 缓存键对不上、预热变成空转。
    expect(recorder.calls[0].themes).toBe(recorder.themes);
  });

  it('每一种默认语言的语料都不是单行（正则规则按输入惰性编译，单行等于白热）', async () => {
    primeCodeHighlighting();
    await drainIdleQueue();

    expect(recorder.calls.map((call) => call.language)).toEqual([...DEFAULT_WARM_LANGUAGES]);
    for (const call of recorder.calls) {
      expect(call.code.split('\n').length).toBeGreaterThanOrEqual(3);
    }
  });

  it('幂等：重复调用不会重复预热', async () => {
    primeCodeHighlighting(['typescript', 'bash']);
    await drainIdleQueue();
    const firstRound = recorder.calls.length;
    expect(firstRound).toBe(2);

    primeCodeHighlighting(['typescript', 'bash']);
    await drainIdleQueue();

    expect(recorder.calls).toHaveLength(firstRound);
    expect(idleQueue).toHaveLength(0);
  });

  it('真空闲时预热', async () => {
    nextDeadline = { didTimeout: false, timeRemaining: () => 50 };

    primeCodeHighlighting(['typescript']);
    await drainIdleQueue();

    expect(recorder.calls.map((call) => call.language)).toEqual(['typescript']);
  });

  it('被 timeout 强制投递且没有剩余预算时一律退让，退让有限次后放弃（不在忙碌时插阻塞）', async () => {
    nextDeadline = { didTimeout: true, timeRemaining: () => 0 };

    primeCodeHighlighting(['typescript']);
    let rounds = 0;
    while (idleQueue.length > 0 && rounds < 50) {
      await runOneIdleCallback();
      rounds += 1;
    }

    expect(recorder.calls).toHaveLength(0);
    // 有界：会放弃，而不是把自己无限排回队列。
    expect(rounds).toBeLessThan(20);
    expect(idleQueue).toHaveLength(0);
  });

  it('被强制投递但仍有剩余预算时照常预热', async () => {
    nextDeadline = { didTimeout: true, timeRemaining: () => 5 };

    primeCodeHighlighting(['typescript']);
    await drainIdleQueue();

    expect(recorder.calls.map((call) => call.language)).toEqual(['typescript']);
  });

  it('没有 requestIdleCallback 时退化为 setTimeout', async () => {
    removeIdleStub();
    vi.useFakeTimers();

    primeCodeHighlighting(['typescript']);
    expect(recorder.calls).toHaveLength(0);

    await vi.runAllTimersAsync();
    expect(recorder.calls.map((call) => call.language)).toEqual(['typescript']);
  });

  it('某种语言预热抛错时不冒泡、不打断后面的语言、留下 warn 日志，且不再重试', async () => {
    recorder.throwingLanguages.add('bash');

    expect(() => primeCodeHighlighting(['typescript', 'bash', 'json'])).not.toThrow();
    await drainIdleQueue();

    expect(recorder.calls.map((call) => call.language)).toEqual(['typescript', 'json']);
    // 失败不能静默：日志是用例锁住的行为，不是实现细节。
    expect(recorder.warnings).toHaveLength(1);
    expect(recorder.warnings[0].message).toContain('warmup failed');
    expect(recorder.warnings[0].context).toEqual({ language: 'bash' });

    // 账本语义：上游会永久缓存失败的 highlighter promise，所以重试是无效工作——
    // 这条断言把"不重试"固定下来，避免以后被无声翻转。
    primeCodeHighlighting(['typescript', 'bash', 'json']);
    await drainIdleQueue();
    expect(recorder.calls).toHaveLength(2);
    expect(idleQueue).toHaveLength(0);
  });

  it('默认预热集合非空且不含重复项', () => {
    expect(DEFAULT_WARM_LANGUAGES.length).toBeGreaterThan(0);
    expect(new Set(DEFAULT_WARM_LANGUAGES).size).toBe(DEFAULT_WARM_LANGUAGES.length);
  });

  it('启动序列确实调用了预热（源码契约，防止接线被静默摘掉）', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main.tsx'), 'utf8');

    expect(source).toMatch(
      /import\s*\{[^}]*primeCodeHighlighting[^}]*\}\s*from\s*['"][^'"]*codeHighlightWarmup['"]/,
    );
    // 只认"行首就是调用"的行：注释掉或塞进 `if (false)` 都不算。
    expect(source).toMatch(/^\s*primeCodeHighlighting\(\);$/m);
  });
});
