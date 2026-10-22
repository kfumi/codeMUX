export interface ProjectRoot {
  path: string;
  /** 添加顺序；移除主根后顺序最小的剩余根继任。 */
  position: number;
  isPrimary: boolean;
}

export interface Project {
  id: string;
  name: string;
  roots: ProjectRoot[];
  created_at: string;
  updated_at: string;
}

/** 主根路径。主根缺失（老缓存/异常数据）时回落到顺序最小的根。 */
export function getPrimaryProjectRoot(
  project: Project | null | undefined,
): string | null {
  if (!project) return null;
  const primary = project.roots.find((root) => root.isPrimary);
  if (primary) return primary.path;
  const ordered = [...project.roots].sort((left, right) => left.position - right.position);
  return ordered[0]?.path ?? null;
}

/** 全部根路径，按添加顺序。 */
export function getProjectRootPaths(project: Project | null | undefined): string[] {
  if (!project) return [];
  return [...project.roots]
    .sort((left, right) => left.position - right.position)
    .map((root) => root.path);
}
