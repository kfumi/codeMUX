export interface Skill {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  source_repo: string | null;
  source_path: string | null;
  version: string | null;
  installed_at: string;
  enabled: boolean;
  is_builtin: boolean;
}

export interface RepoSkillEntry {
  name: string;
  description: string | null;
  path: string;
  installed: boolean;
}

export interface SkillSource {
  repo: string;
  branch: string;
  skills_path: string;
}
