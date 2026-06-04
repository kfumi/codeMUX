export type Theme = 'Light' | 'Dark' | 'System';

export interface Provider {
  id: string;
  name: string;
  api_key: string;
  anthropic_base_url: string;
  openai_base_url: string;
  default_model: string;
  /** 输入 token 单价 ($/1M tokens) */
  input_price?: number;
  /** 缓存命中 token 单价 ($/1M tokens) */
  cache_read_price?: number;
  /** 输出 token 单价 ($/1M tokens) */
  output_price?: number;
  /** 1M 上下文窗口（模型名会追加 [1m]） */
  context_1m?: boolean;
}

export interface AppConfig {
  providers: Provider[];
  active_provider_id: string | null;
  theme: Theme;
}
