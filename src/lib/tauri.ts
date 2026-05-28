import { invoke } from '@tauri-apps/api/core';
import type { Session } from '../types/session';
import type { ChatMessage } from '../types/chat';
import type { AppConfig, ProviderConfig, Theme } from '../types/provider';

export const sessionApi = {
  create: (title: string): Promise<Session> => invoke('create_session', { title }),
  getAll: (): Promise<Session[]> => invoke('get_all_sessions'),
  delete: (sessionId: string): Promise<void> => invoke('delete_session', { sessionId }),
  updateTitle: (sessionId: string, title: string): Promise<void> => invoke('update_session_title', { sessionId, title }),
  getMessages: (sessionId: string): Promise<ChatMessage[]> => invoke('get_messages', { sessionId }),
};

export const chatApi = {
  sendMessage: (sessionId: string, content: string): Promise<string> => invoke('send_message', { sessionId, content }),
};

export const configApi = {
  get: (): Promise<AppConfig> => invoke('get_config'),
  updateProvider: (provider: ProviderConfig): Promise<void> => invoke('update_provider', { provider }),
  setActiveProvider: (providerId: string): Promise<void> => invoke('set_active_provider', { providerId }),
  setTheme: (theme: Theme): Promise<void> => invoke('set_theme', { theme: theme.toLowerCase() }),
};
