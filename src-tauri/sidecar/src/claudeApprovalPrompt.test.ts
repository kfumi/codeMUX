import { describe, expect, it } from 'vitest';

import { getClaudeApprovalTitle } from './claudeApprovalPrompt.js';

describe('getClaudeApprovalTitle', () => {
  it('describes file edits with readable Chinese copy', () => {
    expect(getClaudeApprovalTitle('Edit', { file_path: 'src/app.ts' }, {})).toBe('允许 Claude 编辑 src/app.ts 吗？');
  });

  it('describes file writes with readable Chinese copy', () => {
    expect(getClaudeApprovalTitle('Write', { file_path: 'src/new.ts' }, {})).toBe('允许 Claude 写入 src/new.ts 吗？');
  });

  it('describes bash commands with readable Chinese copy', () => {
    expect(getClaudeApprovalTitle('Bash', { command: 'npm test' }, {})).toBe('允许 Claude 运行命令：npm test');
  });
});
