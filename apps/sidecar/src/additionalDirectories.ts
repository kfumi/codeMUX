/**
 * 附加目录（项目除会话工作目录以外的根）的系统提示片段。
 *
 * 只写增量：不重复主工作目录、不出现 `# Environment` 标题，避免与各家 CLI
 * 自带的环境段出现两个互相矛盾的「主工作目录」。附加目录为空时返回空串，
 * 调用方据此不注入任何内容（ADR 0020）。
 */
export function formatAdditionalDirectoriesPrompt(
  directories: string[] | undefined,
): string {
  const normalized = (directories ?? [])
    .map((directory) => directory.trim())
    .filter((directory) => directory.length > 0);
  if (normalized.length === 0) {
    return '';
  }
  const lines = normalized.map((directory) => `  - ${directory}`).join('\n');
  return [
    'Additional directories (outside the working directory):',
    lines,
    'Use absolute paths when reading or editing files in these directories.',
  ].join('\n');
}
