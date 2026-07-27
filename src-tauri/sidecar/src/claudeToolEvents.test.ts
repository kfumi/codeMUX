import { describe, expect, it } from 'vitest';

import { projectClaudeToolEvents } from './claudeToolEvents.js';

describe('projectClaudeToolEvents', () => {
  it('projects tool uses and keeps non-tool assistant content', () => {
    const projection = projectClaudeToolEvents({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '先检查文件。' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
        ],
      },
    });

    expect(projection.toolEvents).toEqual([{
      kind: 'tool_started',
      toolUseId: 'tool-1',
      name: 'Bash',
      input: { command: 'pwd' },
    }]);
    expect(projection.remainingEvent).toEqual({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '先检查文件。' }] },
    });
  });

  it('projects tool results and preserves non-tool user content', () => {
    const projection = projectClaudeToolEvents({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: { output: 'ok' } },
          { type: 'text', text: '继续。' },
        ],
      },
    });

    expect(projection.toolEvents).toEqual([{
      kind: 'tool_finished',
      toolUseId: 'tool-1',
      content: '{"output":"ok"}',
      isError: false,
    }]);
    expect(projection.remainingEvent).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '继续。' }] },
    });
  });

  it('leaves non-tool and malformed blocks untouched', () => {
    const event = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] },
    };

    expect(projectClaudeToolEvents(event)).toEqual({ toolEvents: [], remainingEvent: event });
  });
});
