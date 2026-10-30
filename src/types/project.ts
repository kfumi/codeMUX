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
