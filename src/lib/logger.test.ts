// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger, initLogging, setMinLogLevel } from './logger';

describe('logger console 输出', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setMinLogLevel('debug');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('context 内联进单个消息参数(对象参数在 Electron console-message 落盘会丢)', () => {
    const log = createLogger('agentStore');
    log.debug('Tool use block started', { sessionId: 's-1', toolName: 'Bash' });

    expect(debugSpy).toHaveBeenCalledTimes(1);
    const [message, ...rest] = debugSpy.mock.calls[0];
    expect(message).toBe('[agentStore] Tool use block started {"sessionId":"s-1","toolName":"Bash"}');
    expect(rest).toEqual([]);
  });

  it('无 context 时只输出 [scope] 消息本身', () => {
    const log = createLogger('app');
    log.debug('plain message');

    expect(debugSpy).toHaveBeenCalledWith('[app] plain message');
  });

  it('err 折叠进 context 一起内联', () => {
    const log = createLogger('app');
    log.error('boom', { sessionId: 's-2' }, new Error('E-1'));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = errorSpy.mock.calls[0][0] as string;
    expect(message.startsWith('[app] boom {"sessionId":"s-2","error":')).toBe(true);
    expect(message).toContain('E-1');
  });

  it('低于最低级别的日志不输出', () => {
    setMinLogLevel('error');
    const log = createLogger('app');
    log.debug('suppressed');

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('initLogging 只初始化一次', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    initLogging();
    initLogging();

    const initialized = infoSpy.mock.calls.filter(([message]) => String(message).startsWith('[app] Logging initialized'));
    expect(initialized).toHaveLength(1);
  });
});
