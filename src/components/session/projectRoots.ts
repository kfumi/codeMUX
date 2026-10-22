/** 项目根目录在对话框里的可编辑形态：顺序即展示顺序，isPrimary 只有一项。 */
export interface EditableProjectRoot {
  path: string;
  isPrimary: boolean;
}

export function normalizeProjectRootPath(path: string): string {
  // 与 daemon 的 root key 一致：Windows 分隔符与大小写不参与去重比较。
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function projectRootName(path: string): string {
  return path.split(/[/\\]+/).filter(Boolean).at(-1) ?? path;
}

/** 同一项目里出现同名文件夹时，用上一级目录名消歧。 */
export function disambiguatedRootNames(roots: readonly EditableProjectRoot[]): string[] {
  const names = roots.map((root) => projectRootName(root.path));
  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return roots.map((root, index) => {
    const name = names[index];
    if ((counts.get(name) ?? 0) < 2) {
      return name;
    }
    const segments = root.path.split(/[/\\]+/).filter(Boolean);
    const parent = segments.at(-2);
    return parent ? `${parent}/${name}` : name;
  });
}

/** 追加原生选择器选中的目录，按规范化路径去重；空列表的第一项成为主根。 */
export function appendPickedRoots(
  current: readonly EditableProjectRoot[],
  picked: readonly string[],
): EditableProjectRoot[] {
  const existing = new Set(current.map((root) => normalizeProjectRootPath(root.path)));
  const appended = [...current];
  for (const path of picked) {
    const key = normalizeProjectRootPath(path);
    if (!key || existing.has(key)) {
      continue;
    }
    existing.add(key);
    appended.push({ path, isPrimary: false });
  }
  if (appended.length > 0 && !appended.some((root) => root.isPrimary)) {
    appended[0] = { ...appended[0], isPrimary: true };
  }
  return appended;
}

/** 移除一个根；移除主根后顺序最小的剩余根自动继任。 */
export function removeRootKeepingPrimary(
  roots: readonly EditableProjectRoot[],
  path: string,
): EditableProjectRoot[] {
  const remaining = roots.filter((root) => root.path !== path);
  if (remaining.length > 0 && !remaining.some((root) => root.isPrimary)) {
    remaining[0] = { ...remaining[0], isPrimary: true };
  }
  return remaining;
}
