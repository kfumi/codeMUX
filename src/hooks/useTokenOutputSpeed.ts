import { useEffect, useState } from 'react';

import { TokenSpeedTracker } from '../lib/tokenSpeed';
import { useAgentStore } from '../stores/agentStore';

const SAMPLE_INTERVAL_MS = 500;

export function useTokenOutputSpeed(
  sessionId: string,
  turnStartedAt?: number,
  running = true,
): number | null {
  const [speed, setSpeed] = useState<number | null>(null);

  useEffect(() => {
    if (!running) return undefined;

    const tracker = new TokenSpeedTracker();
    let emptyAt: number | null = null;
    let observedTokens = useAgentStore.getState().streamingEstimatedOutputTokens[sessionId] ?? 0;
    let lastSampleAt = Date.now();
    // A mid-turn mount may already have a baseline accumulated by the store. It
    // is not itself a speed sample; wait until the cumulative value grows.
    let awaitingGrowth = observedTokens > 0;
    if (observedTokens > 0) tracker.update(observedTokens, lastSampleAt);
    else emptyAt = lastSampleAt;

    setSpeed(null);
    const sample = () => {
      const now = Date.now();
      const total = useAgentStore.getState().streamingEstimatedOutputTokens[sessionId] ?? 0;

      if (total <= 0) {
        tracker.reset();
        emptyAt = now;
        observedTokens = 0;
        awaitingGrowth = false;
        lastSampleAt = now;
        return;
      }

      if (awaitingGrowth) {
        if (total <= observedTokens) {
          lastSampleAt = now;
          return;
        }
        // The tokens may have arrived anywhere inside the latest sampling
        // window. Seed the previous sample's count at its timestamp, then feed
        // the new count now; silence before that window cannot dilute the rate.
        tracker.reset();
        tracker.update(observedTokens, lastSampleAt);
        observedTokens = total;
        awaitingGrowth = false;
        const next = tracker.update(total, now);
        lastSampleAt = now;
        if (next !== null) setSpeed(next);
        return;
      }

      if (emptyAt !== null) {
        tracker.update(0, emptyAt);
        emptyAt = null;
      }

      const next = tracker.update(total, now);
      observedTokens = total;
      lastSampleAt = now;
      if (next !== null) setSpeed(next);
    };

    const handle = window.setInterval(sample, SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [running, sessionId, turnStartedAt]);

  return speed;
}
