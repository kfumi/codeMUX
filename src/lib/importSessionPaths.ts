function normalizeWindowsDrivePrefix(value: string): string {
  return value.replace(/^\/([A-Za-z]:[\\/])/, '$1');
}

export function normalizePathForCompare(value: string): string {
  return normalizeWindowsDrivePrefix(value).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

export function isImportCandidateForProject(cwd: string | null | undefined, projectPath: string): boolean {
  const trimmedCwd = cwd?.trim();
  if (!trimmedCwd) {
    return false;
  }

  const normalizedCwd = normalizePathForCompare(trimmedCwd);
  const normalizedProject = normalizePathForCompare(projectPath);
  if (!normalizedProject) {
    return false;
  }

  return normalizedCwd === normalizedProject || normalizedCwd.startsWith(`${normalizedProject}/`);
}
