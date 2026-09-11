import { beforeEach, describe, expect, it } from 'vitest';

import { useDaemonStatusStore } from './daemonStatusStore';

describe('daemonStatusStore', () => {
  beforeEach(() => {
    useDaemonStatusStore.getState().clearProblem();
  });

  it('starts clean without a problem', () => {
    const state = useDaemonStatusStore.getState();
    expect(state.problem).toBeNull();
    expect(state.error).toBeNull();
    expect(state.restarting).toBe(false);
  });

  it('marks and clears a daemon problem', () => {
    useDaemonStatusStore.getState().setProblem('daemon-exited');
    expect(useDaemonStatusStore.getState().problem).toBe('daemon-exited');

    useDaemonStatusStore.getState().clearProblem();
    const state = useDaemonStatusStore.getState();
    expect(state.problem).toBeNull();
    expect(state.error).toBeNull();
    expect(state.restarting).toBe(false);
  });

  it('keeps the latest problem and error summary', () => {
    useDaemonStatusStore.getState().setProblem('daemon-exited');
    useDaemonStatusStore.getState().setProblem('start-failed', 'spawn 失败');
    const state = useDaemonStatusStore.getState();
    expect(state.problem).toBe('start-failed');
    expect(state.error).toBe('spawn 失败');
  });

  it('normalizes a null error to null', () => {
    useDaemonStatusStore.getState().setProblem('start-failed', null);
    expect(useDaemonStatusStore.getState().error).toBeNull();
  });

  it('tracks restarting state for the retry button', () => {
    useDaemonStatusStore.getState().setProblem('daemon-exited');
    useDaemonStatusStore.getState().setRestarting(true);
    expect(useDaemonStatusStore.getState().restarting).toBe(true);

    useDaemonStatusStore.getState().clearProblem();
    expect(useDaemonStatusStore.getState().restarting).toBe(false);
  });
});
