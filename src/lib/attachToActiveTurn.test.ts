import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '../stores/agentStore';
import { shouldAttachLiveTurn, shouldFollowBackgroundStream, shouldKeepLiveEventsOnHistoryLoad, shouldPreferLocalEventsOnHistoryLoad } from './attachToActiveTurn';

const user = (content: string): AgentMessage => ({
  kind: 'user',
  data: { content },
});

const done = (): AgentMessage => ({
  kind: 'done',
});

describe('shouldAttachLiveTurn', () => {
  it('does not attach when companion says the turn is idle', () => {
    expect(shouldAttachLiveTurn([user('hi')], false)).toBe(false);
  });

  it('does not attach when the last turn already has a terminal event', () => {
    expect(shouldAttachLiveTurn([user('hi'), done()], true)).toBe(false);
  });

  it('attaches when companion is active and the last turn has no terminal event', () => {
    expect(shouldAttachLiveTurn([user('hi')], true)).toBe(true);
  });
});

describe('background stream follow', () => {
  it('still reloads history while a scheduled turn is marked running', () => {
    expect(shouldFollowBackgroundStream(true, true)).toBe(true);
    expect(shouldFollowBackgroundStream(true, false)).toBe(false);
    expect(shouldFollowBackgroundStream(false, false)).toBe(true);
  });

  it('does not keep stale in-memory events for scheduled live turns', () => {
    expect(shouldKeepLiveEventsOnHistoryLoad(true, true)).toBe(false);
    expect(shouldKeepLiveEventsOnHistoryLoad(true, false)).toBe(true);
  });

  it('prefers richer local history over a partial DB snapshot after rewind', () => {
    const local = [user('first'), user('second'), user('third')];
    const loaded = [user('third')];
    expect(shouldPreferLocalEventsOnHistoryLoad(local, loaded, false, false)).toBe(true);
    expect(shouldPreferLocalEventsOnHistoryLoad(local, loaded, true, false)).toBe(false);
    expect(shouldPreferLocalEventsOnHistoryLoad(local, loaded, false, true)).toBe(false);
    expect(shouldPreferLocalEventsOnHistoryLoad(local, local, false, false)).toBe(false);
  });
});
