import { describe, expect, it } from 'vitest';

import { buildExitPlanModeQuestion, getClaudeApprovalTitle } from './claudeApprovalPrompt.js';

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

  it('builds the dedicated ExitPlanMode approval question', () => {
    expect(buildExitPlanModeQuestion()).toEqual({
      presentation: 'plan-approval',
      header: '需要权限',
      question: '实施计划',
      options: [{ label: '批准', description: '退出计划模式并开始实施。' }],
      allowOther: true,
      inputPlaceholder: '输入你的回答...',
    });
  });
});
