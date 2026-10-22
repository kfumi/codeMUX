function normalizeWindowsDrivePrefix(value: string): string {
  return value.replace(/^\/([A-Za-z]:[\\/])/, '$1');
}

export function normalizePathForCompare(value: string): string {
  return normalizeWindowsDrivePrefix(value).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

export function isImportCandidateForProject(
  cwd: string | null | undefined,
  projectRoots: readonly string[],
): boolean {
  const trimmedCwd = cwd?.trim();
  if (!trimmedCwd) {
    return false;
  }

  const normalizedCwd = normalizePathForCompare(trimmedCwd);
  return projectRoots.some((root) => {
    const normalizedRoot = normalizePathForCompare(root);
    if (!normalizedRoot) {
      return false;
    }
    // 路径段边界：`frontend-old` 不能算作 `frontend` 的子目录。
    return normalizedCwd === normalizedRoot || normalizedCwd.startsWith(`${normalizedRoot}/`);
  });
}
