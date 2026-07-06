export interface SkillApps {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  opencode: boolean;
}

export interface Skill {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  installed_at: string;
  apps: SkillApps;
  disk_path: string | null;
  directory: string;
}

export interface ImportableSkill {
  name: string;
  display_name: string | null;
  description: string | null;
  source_app: string;
  disk_path: string;
}
