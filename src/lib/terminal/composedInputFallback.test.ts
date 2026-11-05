import { describe, expect, it } from 'vitest';

import {
  COMPOSED_INPUT_MATCH_WINDOW_MS,
  createComposedInputState,
  noteComposedInput,
  noteTerminalData,
  resolveComposedInput,
} from './composedInputFallback';

describe('composed input fallback', () => {
  it('does not duplicate text that xterm already sent', () => {
    const state = createComposedInputState();
    noteComposedInput(state, '你好', 1000);
    // xterm 的 onData 在提交后 20ms 到达，内容一致：判定已被消费。
    noteTerminalData(state, '你好', 1020);

    expect(resolveComposedInput(state)).toEqual({ write: null, clearTextarea: true });
  });

  it('writes the composed text when xterm dropped it', () => {
    const state = createComposedInputState();
    noteComposedInput(state, '你好', 1000);

    expect(resolveComposedInput(state)).toEqual({ write: '你好', clearTextarea: true });
  });

  it('treats late data as unrelated input', () => {
    const state = createComposedInputState();
    noteComposedInput(state, '你好', 1000);
    noteTerminalData(state, '你好', 1000 + COMPOSED_INPUT_MATCH_WINDOW_MS + 1);

    expect(resolveComposedInput(state).write).toBe('你好');
  });

  it('matches when xterm splits the commit into chunks', () => {
    const state = createComposedInputState();
    noteComposedInput(state, '你好a', 2000);
    noteTerminalData(state, '你好', 2010);

    expect(resolveComposedInput(state).write).toBeNull();
  });

  it('ignores empty composed input and resolves to nothing', () => {
    const state = createComposedInputState();
    noteComposedInput(state, '', 3000);

    expect(resolveComposedInput(state)).toEqual({ write: null, clearTextarea: false });
  });

  it('clears the pending entry after resolving so the next commit is independent', () => {
    const state = createComposedInputState();
    noteComposedInput(state, 'a', 4000);
    resolveComposedInput(state);
    noteTerminalData(state, 'b', 4010);

    expect(resolveComposedInput(state)).toEqual({ write: null, clearTextarea: false });
  });
});
