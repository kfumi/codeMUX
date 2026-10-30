import { ensureDaemonClient } from './lifecycle';

/** 会话时间线的读取与订阅:水位线/补拉由 daemon-session-bridge 持有。 */
export const timeline = {
  get: async (
    sessionId: string,
    query?: { direction?: 'tail' | 'after' | 'before'; cursor?: number; limit?: number },
  ) => (await ensureDaemonClient()).getTimeline(sessionId, query),
  subscribe: async (
    sessionId: string,
    handlers: {
      onEvent: (event: unknown) => void;
      onState?: (running: boolean) => void;
      onReconnect?: () => void;
      getInitialSequence?: () => number;
    },
  ) => (await ensureDaemonClient()).subscribeSession(sessionId, handlers),
};

export type TimelineDomain = typeof timeline;
