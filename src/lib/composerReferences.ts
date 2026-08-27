export function getProjectRelativePath(filePath: string, projectPath: string): string {
  const normalizedFilePath = filePath.replace(/\\/g, '/');
  const normalizedProjectPath = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalizedFilePath.startsWith(`${normalizedProjectPath}/`)
    ? normalizedFilePath.slice(normalizedProjectPath.length + 1)
    : filePath;
}

export function getPathLabel(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  return normalized.split('/').filter(Boolean).pop() || path;
}

export function formatComposerReference(reference: string, isDirectory = false): string {
  const normalized = reference.replace(/\\/g, '/');
  const path = isDirectory && !normalized.endsWith('/') ? `${normalized}/` : normalized;
  const label = getPathLabel(path);
  return `[${label}](${path}) `;
}

export function appendComposerReference(text: string, reference: string, isDirectory = false): string {
  const prefix = text.length === 0 || /\s$/.test(text) ? text : `${text} `;
  return `${prefix}${formatComposerReference(reference, isDirectory)}`;
}
