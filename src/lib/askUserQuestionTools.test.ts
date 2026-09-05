import { describe, expect, it } from 'vitest';

import {
  ASK_USER_QUESTION_TOOL_NAMES,
  isAskUserQuestionToolName,
  normalizeAskUserQuestionToolName,
} from './askUserQuestionTools';

describe('askUserQuestionTools', () => {
  it('recognizes pi and codex ask-user tool names', () => {
    for (const toolName of ASK_USER_QUESTION_TOOL_NAMES) {
      expect(isAskUserQuestionToolName(toolName)).toBe(true);
      expect(normalizeAskUserQuestionToolName(toolName)).toBe('AskUserQuestion');
    }
  });

  it('rejects unrelated tool names', () => {
    expect(isAskUserQuestionToolName('bash')).toBe(false);
    expect(normalizeAskUserQuestionToolName('Read')).toBeNull();
  });
});
