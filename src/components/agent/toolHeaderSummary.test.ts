import { describe, expect, it } from 'vitest';

import { getDisplayableArgs, getToolDisplayName, getToolHeaderSummary } from './toolHeaderSummary';

describe('toolHeaderSummary', () => {
  it('shows update_plan explanation as the header summary and omits it from displayable args', () => {
    const input = {
      explanation: '同步最新进度并收尾验证',
      plan: [
        { step: '补充测试', status: 'completed' },
        { step: '整理文案', status: 'completed' },
      ],
    };

    const summary = getToolHeaderSummary('update_plan', input);

    expect(summary.text).toBe('同步最新进度并收尾验证');
    expect(summary.consumedKeys).toEqual(['explanation']);
    expect(getDisplayableArgs(input, summary.consumedKeys)).toEqual({
      plan: input.plan,
    });
  });

  it('maps known agent built-in tool names to Chinese display names', () => {
    expect(getToolDisplayName('Bash')).toBe('运行命令');
    expect(getToolDisplayName('shell_command')).toBe('运行命令');
    expect(getToolDisplayName('Read')).toBe('读取文件');
    expect(getToolDisplayName('Write')).toBe('写入文件');
    expect(getToolDisplayName('Edit')).toBe('编辑文件');
    expect(getToolDisplayName('Agent')).toBe('子智能体');
    expect(getToolDisplayName('AskUserQuestion')).toBe('询问用户');
    expect(getToolDisplayName('update_plan')).toBe('更新计划');
    expect(getToolDisplayName('EnterWorktree')).toBe('进入工作树');
    expect(getToolDisplayName('ExitWorktree')).toBe('退出工作树');
  });

  it('maps Codex collaboration tools to Chinese display names', () => {
    expect(getToolDisplayName('spawn_agent')).toBe('启动子智能体');
    expect(getToolDisplayName('send_input')).toBe('发送子智能体输入');
    expect(getToolDisplayName('wait_agent')).toBe('等待子智能体');
    expect(getToolDisplayName('close_agent')).toBe('关闭子智能体');
    expect(getToolDisplayName('resume_agent')).toBe('恢复子智能体');
  });


  it('maps lowercase OpenCode tool names to the existing Chinese display names', () => {
    expect(getToolDisplayName('bash')).toBe('运行命令');
    expect(getToolDisplayName('read')).toBe('读取文件');
    expect(getToolDisplayName('write')).toBe('写入文件');
    expect(getToolDisplayName('edit')).toBe('编辑文件');
    expect(getToolDisplayName('ls')).toBe('列目录');
    expect(getToolDisplayName('grep')).toBe('搜索文本');
    expect(getToolDisplayName('glob')).toBe('匹配文件');
  });

  it('uses lowercase OpenCode aliases for header summaries', () => {
    const bashSummary = getToolHeaderSummary('bash', { command: 'pwd', cwd: 'D:/project/ai-code/codeMUX' });
    expect(bashSummary.displayName).toBe('运行命令');
    expect(bashSummary.text).toBe('pwd');
    expect(getDisplayableArgs({ command: 'pwd', cwd: 'D:/project/ai-code/codeMUX' }, bashSummary.consumedKeys)).toBeNull();

    const readInput = { file_path: 'src/components/agent/toolHeaderSummary.ts', offset: 0 };
    const readSummary = getToolHeaderSummary('read', readInput);
    expect(readSummary.displayName).toBe('读取文件');
    expect(readSummary.text).toBe('toolHeaderSummary.ts');
    expect(getDisplayableArgs(readInput, readSummary.consumedKeys)).toEqual({ offset: 0 });
  });

  it('uses the MCP server name as the display name without the mcp prefix or method name', () => {
    const summary = getToolHeaderSummary('mcp__context7__query_docs', {
      libraryId: '/reactjs/react.dev',
    });

    expect(getToolDisplayName('mcp__context7__query_docs')).toBe('context7');
    expect(summary.displayName).toBe('context7');
    expect(summary.text).toBe('/reactjs/react.dev');
    expect(summary.text).not.toContain('query_docs');
    expect(summary.text).not.toContain('mcp__');
  });
});
