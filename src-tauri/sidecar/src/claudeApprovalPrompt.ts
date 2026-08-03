export function getClaudeApprovalTitle(
  toolName: string,
  input: Record<string, unknown>,
  opts: { title?: string; displayName?: string; toolUseID?: string; description?: string } = {},
): string {
  if (typeof opts.title === 'string' && opts.title.trim()) {
    return opts.title;
  }

  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
  if (filePath && (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit')) {
    const action = toolName === 'Write' ? '写入' : '编辑';
    return `允许 Claude ${action} ${filePath} 吗？`;
  }

  const command = typeof input.command === 'string' ? input.command : undefined;
  if (toolName === 'Bash' && command) {
    return `允许 Claude 运行命令：${command}`;
  }

  const displayName = typeof opts.displayName === 'string' && opts.displayName.trim()
    ? opts.displayName
    : toolName;
  return `允许 Claude 使用 ${displayName} 吗？`;
}

export function buildExitPlanModeQuestion() {
  return {
    presentation: 'plan-approval' as const,
    header: '需要权限',
    question: '实施计划',
    options: [{ label: '批准', description: '退出计划模式并开始实施。' }],
    allowOther: true,
    inputPlaceholder: '输入你的回答...',
  };
}
