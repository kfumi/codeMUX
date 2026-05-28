export type ApiType = 'DeepSeek' | 'OpenAICompatible' | 'Claude';

export type Theme = 'Light' | 'Dark' | 'System';

export interface ProviderConfig {
  id: string;
  name: string;
  api_type: ApiType;
  api_key: string;
  endpoint_url: string;
  default_model: string;
  is_active: boolean;
}

export interface AppConfig {
  providers: ProviderConfig[];
  active_provider_id: string | null;
  theme: Theme;
}
