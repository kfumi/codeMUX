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
