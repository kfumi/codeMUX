import { describe, expect, it } from 'vitest';

/**
 * Minimal model of CompanionState message queue semantics (issue 11).
 * Two daemon clients sending while a turn is active must queue, not double-start.
 */
interface QueuedMessage {
  prompt: string;
}

class CompanionQueueModel {
  private turnActive = new Set<string>();
  private queues = new Map<string, QueuedMessage[]>();

  markTurnActive(sessionId: string): void {
    this.turnActive.add(sessionId);
  }

  isTurnActive(sessionId: string): boolean {
    return this.turnActive.has(sessionId);
  }

  sendFromClient(sessionId: string, prompt: string): 'started' | 'queued' {
    if (this.isTurnActive(sessionId)) {
      const queue = this.queues.get(sessionId) ?? [];
      queue.push({ prompt });
      this.queues.set(sessionId, queue);
      return 'queued';
    }
    this.markTurnActive(sessionId);
    return 'started';
  }

  finishTurn(sessionId: string): QueuedMessage[] {
    this.turnActive.delete(sessionId);
    const queued = this.queues.get(sessionId) ?? [];
    this.queues.delete(sessionId);
    return queued;
  }
}

describe('companion concurrent client message queue', () => {
  it('queues a second client send while the turn is active', () => {
    const model = new CompanionQueueModel();
    const sessionId = 'session-1';

    expect(model.sendFromClient(sessionId, 'desktop message')).toBe('started');
    expect(model.sendFromClient(sessionId, 'cli message')).toBe('queued');
    expect(model.isTurnActive(sessionId)).toBe(true);

    const pending = model.finishTurn(sessionId);
    expect(pending).toEqual([{ prompt: 'cli message' }]);
    expect(model.isTurnActive(sessionId)).toBe(false);
  });

  it('preserves FIFO order for multiple queued sends', () => {
    const model = new CompanionQueueModel();
    const sessionId = 'session-1';

    model.sendFromClient(sessionId, 'turn-1');
    expect(model.sendFromClient(sessionId, 'queued-a')).toBe('queued');
    expect(model.sendFromClient(sessionId, 'queued-b')).toBe('queued');

    const pending = model.finishTurn(sessionId);
    expect(pending.map((entry) => entry.prompt)).toEqual(['queued-a', 'queued-b']);
  });
});
