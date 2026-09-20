import { describe, expect, it } from 'vitest';

import { ClaudePromptStream } from './claudePromptStream.js';

describe('ClaudePromptStream', () => {
  it('attaches priority next on steered follow-up prompts', async () => {
    const stream = new ClaudePromptStream(false);
    stream.pushInitial('first');
    expect(stream.push('focus on tests', undefined, { priority: 'next' })).toBe(true);

    const iterator = stream.stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    const second = await iterator.next();
    stream.close();

    expect(first.value).toMatchObject({
      type: 'user',
      message: { role: 'user' },
    });
    expect(second.value).toMatchObject({
      type: 'user',
      priority: 'next',
    });
  });
});
