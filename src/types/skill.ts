export interface Skill {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  installed_at: string;
  enabled: boolean;
  is_builtin: boolean;
}
