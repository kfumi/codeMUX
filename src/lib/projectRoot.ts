import type { Project, ProjectRoot } from '../types/project';
import type { Session } from '../types/session';

export type { ProjectRoot };

/** 项目根在编辑器里的可编辑形态：顺序即展示顺序，isPrimary 只有一项。 */
export interface EditableProjectRoot {
  path: string;
  isPrimary: boolean;
}

/**
 * 项目根路径键。
 *
 * 与 daemon 的 root key 一致:Windows 分隔符、大小写与尾斜杠不参与比较,
 * 日期目录去重、同名消歧与「这个会话在哪个根下」都用它。
 */
export function normalizeProjectRootPath(path: string | null | undefined): string {
  return (path ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 路径最后一段目录名。 */
export function projectRootName(path: string): string {
  return path.split(/[/\\]+/).filter(Boolean).at(-1) ?? path;
}

/** 主根路径。主根缺失(老缓存/异常数据)时回落到顺序最小的根。 */
export function getPrimaryProjectRoot(project: Project | null | undefined): string | null {
  if (!project) return null;
  const primary = project.roots.find((root) => root.isPrimary);
  if (primary) return primary.path;
  const ordered = [...project.roots].sort((left, right) => left.position - right.position);
  return ordered[0]?.path ?? null;
}

/** 全部根路径,按添加顺序。 */
export function getProjectRootPaths(project: Project | null | undefined): string[] {
  if (!project) return [];
  return [...project.roots]
    .sort((left, right) => left.position - right.position)
    .map((root) => root.path);
}

/** 项目 id → 主根路径。 */
export function resolveProjectPath(
  projectId: string | null | undefined,
  projects: readonly Project[],
): string | null {
  if (!projectId) return null;
  return getPrimaryProjectRoot(projects.find((project) => project.id === projectId));
}

/** 会话绑定的项目主根。 */
export function getBoundProjectPath(
  session: Pick<Session, 'project_id'>,
  projects: readonly Project[],
): string | null {
  return resolveProjectPath(session.project_id, projects);
}

/** 同一项目里出现同名文件夹时，用上一级目录名消歧。 */
export function disambiguatedRootNames(roots: readonly { path: string }[]): string[] {
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

/** 路径是否位于某个根之下(按路径键比较,分隔符与大小写不敏感)。 */
export function isPathInsideProjectRoot(
  root: string | null | undefined,
  candidate: string | null | undefined,
): boolean {
  const normalizedRoot = normalizeProjectRootPath(root);
  const normalizedCandidate = normalizeProjectRootPath(candidate);
  if (!normalizedRoot || !normalizedCandidate) {
    return false;
  }
  return (
    normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

/** ProjectRoot[] → 编辑器形态；主根缺失时顺序最小者兜底。 */
export function toEditableProjectRoots(
  roots: readonly ProjectRoot[],
): EditableProjectRoot[] {
  const ordered = [...roots].sort((left, right) => left.position - right.position);
  const hasPrimary = ordered.some((root) => root.isPrimary);
  return ordered.map((root, index) => ({
    path: root.path,
    isPrimary: root.isPrimary || (!hasPrimary && index === 0),
  }));
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
