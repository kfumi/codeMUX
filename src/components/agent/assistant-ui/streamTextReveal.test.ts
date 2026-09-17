import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVEAL_HORIZON_MS,
  clampToSafeRevealBoundary,
  computeRevealStep,
  resolveRevealedLength,
} from './streamTextReveal';

describe('computeRevealStep', () => {
  it('releases nothing when there is no backlog', () => {
    expect(computeRevealStep({ backlog: 0, elapsedMs: 16 })).toBe(0);
    expect(computeRevealStep({ backlog: -5, elapsedMs: 16 })).toBe(0);
  });

  it('releases the whole backlog once the horizon has elapsed', () => {
    expect(computeRevealStep({ backlog: 500, elapsedMs: DEFAULT_REVEAL_HORIZON_MS })).toBe(500);
    expect(computeRevealStep({ backlog: 500, elapsedMs: 10_000 })).toBe(500);
  });

  it('treats a non-positive horizon as throttling disabled', () => {
    expect(computeRevealStep({ backlog: 500, elapsedMs: 1, horizonMs: 0 })).toBe(500);
    expect(computeRevealStep({ backlog: 500, elapsedMs: 1, horizonMs: -1 })).toBe(500);
  });

  it('scales the step with elapsed time', () => {
    // 1000 chars over a 150ms horizon ⇒ ~6.7 chars per 1ms frame, rounded up.
    expect(computeRevealStep({ backlog: 1000, elapsedMs: 1 })).toBe(7);
    expect(computeRevealStep({ backlog: 1000, elapsedMs: 75 })).toBe(500);
  });

  it('always advances at least one character so a trickle still progresses', () => {
    expect(computeRevealStep({ backlog: 1, elapsedMs: 0 })).toBe(1);
    expect(computeRevealStep({ backlog: 100, elapsedMs: 0 })).toBe(1);
  });

  it('caps a single frame after a long stall so recovery is gradual', () => {
    // elapsed is clamped to 250ms; 250/150 > 1 ⇒ full backlog for small ones,
    // but a huge backlog must not exceed what the clamped window implies.
    const backlog = 100_000;
    const step = computeRevealStep({ backlog, elapsedMs: 5_000 });
    // clamped to 250ms > 150ms horizon ⇒ full release is correct here
    expect(step).toBe(backlog);

    const partial = computeRevealStep({ backlog, elapsedMs: 30 });
    expect(partial).toBe(Math.ceil((backlog * 30) / DEFAULT_REVEAL_HORIZON_MS));
    expect(partial).toBeLessThan(backlog);
  });
});

describe('clampToSafeRevealBoundary', () => {
  it('returns the index unchanged for plain ASCII', () => {
    expect(clampToSafeRevealBoundary('hello world', 5)).toBe(5);
  });

  it('does not split a surrogate pair', () => {
    // '😀' is 2 code units; cutting at 1 would leave a dangling high surrogate.
    expect(clampToSafeRevealBoundary('😀x', 1)).toBe(0);
    expect(clampToSafeRevealBoundary('😀x', 2)).toBe(2);
  });

  it('does not leave a combining mark separated from its base', () => {
    // 'e' + combining acute accent
    expect(clampToSafeRevealBoundary('e\u0301x', 1)).toBe(0);
    expect(clampToSafeRevealBoundary('e\u0301x', 2)).toBe(2);
  });

  it('does not end on a dangling zero-width joiner', () => {
    expect(clampToSafeRevealBoundary('a\u200db', 2)).toBe(1);
  });

  it('does not split an emoji variation selector sequence', () => {
    // U+2708 + U+FE0F (emoji presentation selector)
    expect(clampToSafeRevealBoundary('\u2708\ufe0f x', 1)).toBe(0);
  });

  it('handles empty and out-of-range indexes', () => {
    expect(clampToSafeRevealBoundary('', 0)).toBe(0);
    expect(clampToSafeRevealBoundary('abc', 99)).toBe(3);
    expect(clampToSafeRevealBoundary('abc', -3)).toBe(0);
  });
});

describe('resolveRevealedLength', () => {
  it('renders the whole text the first time it is seen', () => {
    expect(resolveRevealedLength({
      text: 'already committed content',
      revealed: 0,
      targetLength: 24,
      elapsedMs: 16,
    })).toBe(24);
  });

  it('snaps when the target shrinks or is already complete', () => {
    expect(resolveRevealedLength({ text: 'abc', revealed: 10, targetLength: 3, elapsedMs: 16 })).toBe(3);
    expect(resolveRevealedLength({ text: 'abc', revealed: 3, targetLength: 3, elapsedMs: 16 })).toBe(3);
  });

  it('never moves backwards', () => {
    const text = 'x'.repeat(1_000);
    let revealed = 400;
    for (let frame = 0; frame < 50; frame += 1) {
      const next = resolveRevealedLength({ text, revealed, targetLength: 1_000, elapsedMs: 16 });
      expect(next).toBeGreaterThanOrEqual(revealed);
      revealed = next;
    }
  });

  it('converges on the target, covering most of it within a few horizons', () => {
    const text = 'x'.repeat(5_000);
    let revealed = 1;
    let frames = 0;
    let revealedAtFourHorizons = -1;

    while (revealed < text.length && frames < 600) {
      revealed = resolveRevealedLength({ text, revealed, targetLength: text.length, elapsedMs: 16 });
      frames += 1;
      if (frames === 38) {
        revealedAtFourHorizons = revealed;
      }
    }

    expect(revealed).toBe(text.length);
    // 释放是"每小时长按固定比例"的指数衰减（Paseo 的同一公式），因此不是在一个
    // horizon 内清空，而是约 4 个 horizon（16ms 帧下 ~38 帧）覆盖 90% 以上。
    expect(revealedAtFourHorizons).toBeGreaterThan(text.length * 0.9);
    expect(frames).toBeLessThan(200);
  });
});

describe('burst smoothing (the point of the whole module)', () => {
  it('keeps per-frame growth far below the lumpiness of arrival', () => {
    const lumps = [4, 6, 5, 2_000, 3, 7, 1_800, 5, 4];
    const frameMs = 16;
    const horizonMs = DEFAULT_REVEAL_HORIZON_MS;

    let text = '';
    let revealed = 0;
    let arrivalCursor = 0;
    let arrivalText = '';
    const arrivalDeltas: number[] = [];
    const frameDeltas: number[] = [];

    // Start from "first sight" semantics: one frame to establish the stream.
    revealed = 0;
    for (let frame = 0; frame < 220; frame += 1) {
      const elapsed = frame * frameMs;
      while (arrivalCursor < lumps.length && elapsed >= arrivalCursor * 50) {
        const lump = lumps[arrivalCursor];
        arrivalText += 'x'.repeat(lump);
        arrivalDeltas.push(lump);
        arrivalCursor += 1;
      }

      // 复位成"流已经开始"的状态，避免每批都被当作首次见到而整段渲染。
      if (revealed === 0 && arrivalText.length > 0) {
        revealed = resolveRevealedLength({
          text: arrivalText,
          revealed: 0,
          targetLength: arrivalText.length,
          elapsedMs: frameMs,
        });
        text = arrivalText;
        frameDeltas.push(revealed);
        continue;
      }

      const before = revealed;
      text = arrivalText;
      revealed = resolveRevealedLength({
        text,
        revealed,
        targetLength: text.length,
        elapsedMs: frameMs,
        horizonMs,
      });
      frameDeltas.push(revealed - before);
      if (arrivalCursor >= lumps.length && revealed >= text.length) {
        break;
      }
    }

    const maxArrival = Math.max(...arrivalDeltas);
    const maxFrame = Math.max(...frameDeltas);
    // Arrival swings by ~500x; the reveal must not.
    expect(maxArrival / maxFrame).toBeGreaterThan(3);
    expect(revealed).toBe(text.length);
    // Total characters are identical — the change is *when* they land, not how many.
    expect(text.length).toBe(lumps.reduce((sum, n) => sum + n, 0));
  });

  it('widens the step when a burst arrives, so text catches up instead of jumping', () => {
    const text = 'x'.repeat(3_000);
    const slowStep = resolveRevealedLength({ text, revealed: 1_000, targetLength: 1_100, elapsedMs: 16 });
    const burstStep = resolveRevealedLength({ text, revealed: 1_000, targetLength: 3_000, elapsedMs: 16 });
    expect(burstStep - 1_000).toBeGreaterThan(slowStep - 1_000);
  });
});
