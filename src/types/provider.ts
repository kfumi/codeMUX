export type Theme = 'Light' | 'Dark' | 'System';

export interface Provider {
  id: string;
  name: string;
  api_key: string;
  anthropic_base_url: string;
  openai_base_url: string;
  default_model: string;
}

export interface AppConfig {
  providers: Provider[];
  active_provider_id: string | null;
  theme: Theme;
}
