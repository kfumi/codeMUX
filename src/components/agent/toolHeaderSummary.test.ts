import { describe, expect, it } from 'vitest';

import { getDisplayableArgs, getShellCommand, getToolAction, getToolActionLabel, getToolDisplayName, getToolGroupPhrase, getToolHeaderSummary, isFileMutationTool, isShellCommandTool } from './toolHeaderSummary';

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
    expect(getToolDisplayName('Bash')).toBe('终端');
    expect(getToolDisplayName('shell_command')).toBe('终端');
    expect(getToolDisplayName('Read')).toBe('读取');
    expect(getToolDisplayName('Write')).toBe('写入');
    expect(getToolDisplayName('Edit')).toBe('编辑');
    expect(getToolDisplayName('Agent')).toBe('子智能体');
    expect(getToolDisplayName('AskUserQuestion')).toBe('询问用户');
    expect(getToolDisplayName('ask_user_question')).toBe('询问用户');
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

  it('maps Codex multi_agent-prefixed tool names to the Chinese display names', () => {
    expect(getToolDisplayName('multi_agent_v1__spawn_agent')).toBe('启动子智能体');
    expect(getToolDisplayName('multi_agent_v1_spawn_agent')).toBe('启动子智能体');
    expect(getToolDisplayName('multi_agent_v1__send_input')).toBe('发送子智能体输入');
    expect(getToolDisplayName('multi_agent_v2__spawn_agent')).toBe('启动子智能体');
    expect(getToolDisplayName('multi_agent_v1__wait_agent')).toBe('等待子智能体');
    expect(getToolDisplayName('multi_agent_v1__close_agent')).toBe('关闭子智能体');
    expect(getToolDisplayName('multi_agent_v1__resume_agent')).toBe('恢复子智能体');

    const summary = getToolHeaderSummary('multi_agent_v1__spawn_agent', {
      fork_context: true,
      items: [{ type: 'text', text: 'Find all files related to message regenerating' }],
    });
    expect(summary.displayName).toBe('启动子智能体');
    expect(getDisplayableArgs({ fork_context: true, items: [] }, summary.consumedKeys)).toEqual({ items: [] });
  });

  it('maps Codex image and js_repl tools to Chinese display names', () => {
    expect(getToolDisplayName('view_image')).toBe('查看图片');
    expect(getToolDisplayName('js')).toBe('运行 JS');
    expect(getToolDisplayName('js_repl')).toBe('运行 JS');
    expect(getToolDisplayName('js_repl_reset')).toBe('重置 JS');

    const imageSummary = getToolHeaderSummary('view_image', {
      path: 'C:\\Users\\kuangdi\\AppData\\Local\\Temp\\codemux-images-Y7hiHB\\demo.png',
    });
    expect(imageSummary.displayName).toBe('查看图片');
    expect(imageSummary.text).toBe('demo.png');

    const jsSummary = getToolHeaderSummary('js', {
      title: 'Inspect reference image',
      code: 'await nodeRepl.emitImage({ bytes, mimeType: "image/png" })',
    });
    expect(jsSummary.displayName).toBe('运行 JS');
    expect(jsSummary.text).toBe('Inspect reference image');
  });


  it('maps lowercase OpenCode tool names to the existing Chinese display names', () => {
    expect(getToolDisplayName('bash')).toBe('终端');
    expect(getToolDisplayName('read')).toBe('读取');
    expect(getToolDisplayName('write')).toBe('写入');
    expect(getToolDisplayName('edit')).toBe('编辑');
    expect(getToolDisplayName('ls')).toBe('列目录');
    expect(getToolDisplayName('grep')).toBe('搜索文本');
    expect(getToolDisplayName('glob')).toBe('匹配文件');
  });

  it('extracts the executable command for Bash and shell tools', () => {
    expect(isShellCommandTool('Bash')).toBe(true);
    expect(isShellCommandTool('bash')).toBe(true);
    expect(isShellCommandTool('shell_command')).toBe(true);
    expect(isShellCommandTool('shell')).toBe(true);
    expect(isShellCommandTool('exec_command')).toBe(true);
    expect(isShellCommandTool('exec')).toBe(true);
    // write_stdin 不是「跑什么命令」，只做名字映射。
    expect(isShellCommandTool('write_stdin')).toBe(false);
    expect(isShellCommandTool('Grep')).toBe(false);

    expect(getShellCommand({
      description: 'Check git status',
      command: 'git status --short',
    })).toBe('git status --short');
    expect(getShellCommand({ cmd: 'pwd' })).toBe('pwd');
    // `exec` 把要跑的内容写在 `input`（JS）里；头部摘要与展开面板共用同一份键序。
    expect(getShellCommand({ input: 'await tools.exec_command({ cmd: "git status" })' }))
      .toBe('await tools.exec_command({ cmd: "git status" })');
    expect(getShellCommand({ description: 'No command field' })).toBeUndefined();
  });

  it('Codex unified exec 的 exec_command / exec 按命令工具展示：命令就是头部摘要', () => {
    const execCommand = getToolHeaderSummary('exec_command', {
      cmd: 'Get-Content -Raw src/components/agent/toolHeaderSummary.ts',
      max_output_tokens: 30_000,
      workdir: 'D:/project/ai-code/codeMUX',
    });

    expect(execCommand.displayName).toBe('终端');
    expect(execCommand.text).toBe('Get-Content -Raw src/components/agent/toolHeaderSummary.ts');
    // Codex 的命令工具把命令之外的参数（workdir 等）留在展开面板里。
    expect(execCommand.consumedKeys).toEqual([]);
    expect(getToolActionLabel('exec_command')).toBe('运行');
    expect(getToolActionLabel('exec_command', { running: true })).toBe('正在运行');
    expect(getToolAction('exec_command')).toBe('run');
    expect(getToolGroupPhrase('exec_command', 3)).toBe('运行 3 个命令');

    const execInput = 'const r = await tools.exec_command({ cmd: "git status --short" }); r.output';
    const exec = getToolHeaderSummary('exec', { input: execInput });
    expect(exec.displayName).toBe('终端');
    expect(exec.text).toBe(execInput);
    expect(getToolActionLabel('exec')).toBe('运行');
    expect(getToolGroupPhrase('exec', 1)).toBe('运行 1 个命令');

    // `shell` 同族：过去只被命令面板认，没有中文名与动作词。
    expect(getToolDisplayName('shell')).toBe('终端');
    expect(getToolActionLabel('shell')).toBe('运行');

    // 命令里带 apply_patch 时仍算文件改动（与 Bash / shell_command 同口径）。
    expect(isFileMutationTool('exec_command', {
      cmd: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: src/a.ts\n+export {}\n*** End Patch\nPATCH",
    })).toBe(true);
  });

  it('Codex write_stdin 只映射工具名，不当作命令工具', () => {
    expect(getToolDisplayName('write_stdin')).toBe('向命令输入');
    expect(getToolActionLabel('write_stdin')).toBe('向命令输入');
    expect(getToolAction('write_stdin')).toBe('use');

    const summary = getToolHeaderSummary('write_stdin', {
      chars: '',
      session_id: 16043,
      yield_time_ms: 1000,
    });
    expect(summary.displayName).toBe('向命令输入');
    // 会话输入内容不是「跑什么命令」，不占头部摘要；参数照旧在展开面板可见。
    expect(summary.text).toBeUndefined();
    expect(summary.consumedKeys).toEqual([]);
  });

  it('prefers command over description in Bash header summaries', () => {
    const summary = getToolHeaderSummary('Bash', {
      description: 'Run affected tests',
      command: 'npx vitest run src/components/agent/assistant-ui/CodeMuxAssistantRuntime.test.tsx',
    });

    expect(summary.displayName).toBe('终端');
    expect(summary.text).toBe('npx vitest run src/components/agent/assistant-ui/CodeMuxAssistantRuntime.test.tsx');
  });

  it('treats write and edit tools from all agents as file mutations', () => {
    expect(isFileMutationTool('Write')).toBe(true);
    expect(isFileMutationTool('write')).toBe(true);
    expect(isFileMutationTool('Edit')).toBe(true);
    expect(isFileMutationTool('edit')).toBe(true);
    expect(isFileMutationTool('MultiEdit')).toBe(true);
    expect(isFileMutationTool('NotebookEdit')).toBe(true);
    expect(isFileMutationTool('apply_patch')).toBe(true);
    expect(isFileMutationTool('Read')).toBe(false);
    expect(isFileMutationTool('read')).toBe(false);
    expect(isFileMutationTool('Bash')).toBe(false);
    expect(isFileMutationTool('TodoWrite')).toBe(false);
    expect(isFileMutationTool('NotebookRead')).toBe(false);
    expect(isFileMutationTool('shell_command', {
      command: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: src/a.ts\n+export {}\n*** End Patch\nPATCH",
    })).toBe(true);
    expect(isFileMutationTool('Bash', { command: 'ls' })).toBe(false);
  });

  it('uses lowercase OpenCode aliases for header summaries', () => {
    const bashSummary = getToolHeaderSummary('bash', { command: 'pwd', cwd: 'D:/project/ai-code/codeMUX' });
    expect(bashSummary.displayName).toBe('终端');
    expect(bashSummary.text).toBe('pwd');
    expect(getDisplayableArgs({ command: 'pwd', cwd: 'D:/project/ai-code/codeMUX' }, bashSummary.consumedKeys)).toBeNull();

    const readInput = { file_path: 'src/components/agent/toolHeaderSummary.ts', offset: 0 };
    const readSummary = getToolHeaderSummary('read', readInput);
    expect(readSummary.displayName).toBe('读取');
    expect(readSummary.text).toBe('toolHeaderSummary.ts');
    expect(getDisplayableArgs(readInput, readSummary.consumedKeys)).toEqual({ offset: 0 });
  });

  it('shows line range for Read tool with file_path, offset, and limit', () => {
    const input = {
      file_path: 'D:/project/wfm/xjyd/xjwlcs/src/wlcs/install/service/InstallBaseService.java',
      offset: 515,
      limit: 20,
    };
    const summary = getToolHeaderSummary('Read', input);
    expect(summary.displayName).toBe('读取');
    expect(summary.text).toBe('InstallBaseService.java 515-534行');
    expect(summary.fullPath).toBe(input.file_path);
    expect(getDisplayableArgs(input, summary.consumedKeys)).toBeNull();
  });

  it('shows line range for Read tool with opencode filePath and limit', () => {
    const input = {
      filePath: '/home/user/src/app.ts',
      offset: 10,
      limit: 5,
    };
    const summary = getToolHeaderSummary('read', input);
    expect(summary.displayName).toBe('读取');
    expect(summary.text).toBe('app.ts 10-14行');
    expect(summary.fullPath).toBe('/home/user/src/app.ts');
    expect(getDisplayableArgs(input, summary.consumedKeys)).toBeNull();
  });

  it('falls back to just filename for Read when offset is 0 and no limit', () => {
    const input = {
      file_path: 'src/index.ts',
      offset: 0,
    };
    const summary = getToolHeaderSummary('read', input);
    expect(summary.text).toBe('index.ts');
    expect(getDisplayableArgs(input, summary.consumedKeys)).toEqual({ offset: 0 });
  });

  it('falls back to just filename for Read when limit is 0', () => {
    const input = {
      file_path: 'src/index.ts',
      offset: 10,
      limit: 0,
    };
    const summary = getToolHeaderSummary('read', input);
    expect(summary.text).toBe('index.ts');
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

  it('为 codemux-control 的全部工具别名提供简短中文名称', () => {
    const tools: [string, string][] = [
      ['browser_list', '浏览器页面列表'],
      ['browser_eval', '执行页面脚本'],
      ['browser_screenshot', '浏览器页面截图'],
      ['browser_input', '模拟浏览器输入'],
      ['browser_cdp', '执行浏览器 CDP 命令'],
      ['browser_snapshot', '读取页面快照'],
      ['browser_click', '点击页面元素'],
      ['browser_type', '输入页面文字'],
      ['browser_scroll', '滚动浏览器页面'],
      ['browser_select', '选择页面选项'],
      ['computer_windows', '桌面窗口列表'],
      ['computer_screenshot', '桌面截图'],
      ['computer_save_screenshot', '保存窗口截图'],
      ['computer_active_window', '查看当前窗口'],
      ['computer_apps', '查看桌面应用'],
      ['computer_elements', '读取窗口元素'],
      ['computer_wait', '等待窗口条件'],
      ['computer_click', '点击窗口元素'],
      ['computer_type', '向窗口输入文字'],
      ['computer_key', '发送键盘按键'],
      ['computer_paste', '粘贴文本'],
      ['computer_scroll', '滚动窗口内容'],
      ['computer_drag', '拖动窗口元素'],
      ['computer_set_value', '设置控件值'],
      ['computer_launch', '启动桌面应用'],
    ];

    for (const [tool, label] of tools) {
      expect(getToolDisplayName(`codemux-control_${tool}`)).toBe(label);
      expect(getToolDisplayName(`mcp__codemux-control__${tool}`)).toBe(label);
      expect(getToolActionLabel(`codemux-control_${tool}`)).toBe(label);
      expect(getToolActionLabel(`mcp__codemux-control__${tool}`)).toBe(label);
    }
  });

  it('电脑启动摘要优先显示应用名，并在缺少应用名时回退到 path 或 launchPath', () => {
    const named = getToolHeaderSummary('codemux-control_computer_launch', {
      name: 'Notepad',
      path: 'C:/Program Files/Notepad++/notepad++.exe',
    });
    expect(named.displayName).toBe('启动桌面应用');
    expect(named.text).toBe('Notepad');
    expect(named.consumedKeys).toEqual(['name']);

    const path = getToolHeaderSummary('mcp__codemux-control__computer_launch', {
      path: 'C:/Program Files/Notepad++/notepad++.exe',
    });
    expect(path.text).toBe('notepad++.exe');
    expect(path.fullPath).toBe('C:/Program Files/Notepad++/notepad++.exe');
    expect(path.consumedKeys).toEqual(['path']);

    const launchPath = getToolHeaderSummary('computer_launch', {
      launchPath: 'D:/Tools/notepad.exe',
    });
    expect(launchPath.text).toBe('notepad.exe');
    expect(launchPath.fullPath).toBe('D:/Tools/notepad.exe');
    expect(launchPath.consumedKeys).toEqual(['launchPath']);
  });

  it('内置 server 的工具用工具自己的标签,而不是 server 段(工单 16)', () => {
    // 卡片标题:两族工具过去都显示 server 段,看不出在干什么。
    expect(
      getToolHeaderSummary('mcp__codemux-control__browser_snapshot', {}).displayName,
    ).toBe('读取页面快照');
    expect(
      getToolHeaderSummary('mcp__codemux-control__computer_screenshot', {}).displayName,
    ).toBe('桌面截图');
    // OpenCode 一类的连写形态同样认。
    expect(getToolHeaderSummary('codemux-control_computer_click', {}).displayName).toBe('点击窗口元素');
    // 改名前的历史轨迹仍按工具标签显示(轨迹是持久数据)。
    expect(getToolHeaderSummary('mcp__codemux-browser__computer_type', {}).displayName).toBe('向窗口输入文字');
    // 折叠行措辞保持 server 段,不跟着变(非目标)。
    expect(getToolGroupPhrase('mcp__codemux-control__computer_click', 2)).toBe(
      '调用 2 次 codemux-control',
    );
  });
});

describe('getToolGroupPhrase', () => {
  it('renders count phrases for known built-in tools', () => {
    expect(getToolGroupPhrase('Read', 2)).toBe('读取 2 次文件');
    expect(getToolGroupPhrase('Bash', 1)).toBe('运行 1 个命令');
    expect(getToolGroupPhrase('shell_command', 3)).toBe('运行 3 个命令');
    expect(getToolGroupPhrase('TodoWrite', 1)).toBe('更新 1 项待办');
  });

  it('respects aliases and casing when picking the phrase', () => {
    expect(getToolGroupPhrase('edit', 2)).toBe('编辑 2 次文件');
    expect(getToolGroupPhrase('todowrite', 1)).toBe('更新 1 项待办');
  });

  it('falls back to the display name phrase for MCP and unknown tools', () => {
    expect(getToolGroupPhrase('mcp__context7__query_docs', 2)).toBe('调用 2 次 context7');
    expect(getToolGroupPhrase('some_custom_tool', 3)).toBe('some_custom_tool 3 次');
  });
});

describe('getToolActionLabel', () => {
  it('使用动作词而不是原始工具名，并按运行中切词', () => {
    expect(getToolActionLabel('Read')).toBe('读取');
    expect(getToolActionLabel('Read', { running: true })).toBe('正在读取');
    expect(getToolActionLabel('Grep')).toBe('搜索');
    expect(getToolActionLabel('Grep', { running: true })).toBe('正在搜索');
    expect(getToolActionLabel('Write')).toBe('写入');
    expect(getToolActionLabel('Edit')).toBe('编辑');
    expect(getToolActionLabel('Bash')).toBe('运行');
    expect(getToolActionLabel('Bash', { running: true })).toBe('正在运行');
    expect(getToolActionLabel('WebFetch')).toBe('获取');
    expect(getToolActionLabel('Glob')).toBe('列出');
    expect(getToolActionLabel('LS')).toBe('列出');
    expect(getToolActionLabel('Task')).toBe('委派');
    expect(getToolActionLabel('WebSearch')).toBe('搜索');
    expect(getToolActionLabel('apply_patch')).toBe('编辑');
    expect(getToolActionLabel('shell_command')).toBe('运行');
  });

  it('识别别名与大小写', () => {
    expect(getToolActionLabel('read')).toBe('读取');
    expect(getToolActionLabel('bash')).toBe('运行');
    expect(getToolActionLabel('BASH')).toBe('运行');
    // 别名表未收录的小写写法与 getToolDisplayName 行为一致（一起回落原名）。
    expect(getToolActionLabel('notebookedit')).toBe(getToolDisplayName('notebookedit'));
  });

  it('MCP 与无统一动词的工具回落到原有可读展示名', () => {
    // 这些工具名本身已经是可读动作（「更新待办」「技能」…），不该被硬塞成「调用」。
    expect(getToolActionLabel('mcp__context7__query_docs')).toBe(getToolDisplayName('mcp__context7__query_docs'));
    expect(getToolActionLabel('TodoWrite')).toBe(getToolDisplayName('TodoWrite'));
    expect(getToolActionLabel('Skill')).toBe(getToolDisplayName('Skill'));
  });

  it('动作分类：MCP 与未知工具都归到 use', () => {
    expect(getToolAction('mcp__context7__query_docs')).toBe('use');
    expect(getToolAction('some_custom_tool')).toBe('use');
    expect(getToolAction('Read')).toBe('read');
    expect(getToolAction('Bash')).toBe('run');
  });
});
