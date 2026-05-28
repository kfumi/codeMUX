import { invoke, Channel } from '@tauri-apps/api/core';
import type { Session } from '../types/session';
import type { ChatMessage } from '../types/chat';
import type { AppConfig, ProviderConfig, Theme } from '../types/provider';

export const sessionApi = {
  create: (title: string, mode?: string): Promise<Session> => invoke('create_session', { title, mode }),
  getAll: (): Promise<Session[]> => invoke('get_all_sessions'),
  delete: (sessionId: string): Promise<void> => invoke('delete_session', { sessionId }),
  updateTitle: (sessionId: string, title: string): Promise<void> => invoke('update_session_title', { sessionId, title }),
  getMessages: (sessionId: string): Promise<ChatMessage[]> => invoke('get_messages', { sessionId }),
};

export const chatApi = {
  sendMessage: (sessionId: string, content: string): Promise<string> => invoke('send_message', { sessionId, content }),
  sendMessageStream: (sessionId: string, content: string, onChunk: (token: string) => void): Promise<void> => {
    const channel = new Channel<string>();
    channel.onmessage = (token: string) => {
      onChunk(token);
    };
    return invoke('send_message_stream', { sessionId, content, channel });
  },
};

export const agentApi = {
  startSession: (
    sessionId: string,
    prompt: string,
    cwd: string,
    onEvent: (event: string) => void,
    apiKey?: string,
    model?: string,
  ): Promise<void> => {
    const channel = new Channel<string>();
    channel.onmessage = (event: string) => {
      onEvent(event);
    };
    return invoke('start_agent_session', { sessionId, prompt, cwd, channel, apiKey, model });
  },
  interrupt: (): Promise<void> => invoke('interrupt_agent_session'),
  shutdown: (): Promise<void> => invoke('shutdown_agent'),
};

export const configApi = {
  get: (): Promise<AppConfig> => invoke('get_config'),
  updateProvider: (provider: ProviderConfig): Promise<void> => invoke('update_provider', { provider }),
  setActiveProvider: (providerId: string): Promise<void> => invoke('set_active_provider', { providerId }),
  setTheme: (theme: Theme): Promise<void> => invoke('set_theme', { theme: theme.toLowerCase() }),
  testConnection: (provider: ProviderConfig): Promise<string> => invoke('test_connection', { provider }),
};

export const fileApi = {
  readFile: (path: string): Promise<string> => invoke('read_file', { path }),
};
