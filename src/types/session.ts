export interface Session {
  id: string;
  title: string;
  provider_id: string | null;
  model: string | null;
  mode: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSessionRequest {
  title: string;
  mode?: string;
  project_id?: string;
}
