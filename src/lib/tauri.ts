import { invoke, Channel } from '@tauri-apps/api/core';
import type { Session } from '../types/session';
import type { AppConfig, Provider, Theme } from '../types/provider';
import type { Project } from '../types/project';

export const projectApi = {
  create: (name: string, path: string): Promise<Project> => invoke('create_project', { name, path }),
  getAll: (): Promise<Project[]> => invoke('get_all_projects'),
  delete: (projectId: string): Promise<void> => invoke('delete_project', { projectId }),
  rename: (projectId: string, name: string): Promise<void> => invoke('rename_project', { projectId, name }),
};

export const sessionApi = {
  create: (title: string, mode?: string, projectId?: string): Promise<Session> =>
    invoke('create_session', { title, mode, projectId: projectId ?? null }),
  getAll: (): Promise<Session[]> => invoke('get_all_sessions'),
  delete: (sessionId: string): Promise<void> => invoke('delete_session', { sessionId }),
  updateTitle: (sessionId: string, title: string): Promise<void> => invoke('update_session_title', { sessionId, title }),
  getMessages: (sessionId: string): Promise<unknown[]> => invoke('get_messages', { sessionId }),
};

export const agentApi = {
  startSession: (
    sessionId: string,
    prompt: string,
    cwd: string,
    onEvent: (event: string) => void,
    apiKey?: string,
    baseUrl?: string,
  ): Promise<void> => {
    const channel = new Channel<string>();
    channel.onmessage = (event: string) => {
      onEvent(event);
    };
    return invoke('start_agent_session', { sessionId, prompt, cwd, channel, apiKey, baseUrl });
  },
  interrupt: (): Promise<void> => invoke('interrupt_agent_session'),
  shutdown: (): Promise<void> => invoke('shutdown_agent'),
  resetSession: (sessionId: string): Promise<void> => invoke('reset_agent_session', { sessionId }),
  saveEvents: (sessionId: string, eventsJson: string): Promise<void> =>
    invoke('save_agent_events', { sessionId, eventsJson }),
  getEvents: (sessionId: string): Promise<string> =>
    invoke('get_agent_events', { sessionId }),
};

export const configApi = {
  get: (): Promise<AppConfig> => invoke('get_config'),
  updateProvider: (provider: Provider): Promise<void> => invoke('update_provider', { provider }),
  deleteProvider: (providerId: string): Promise<void> => invoke('delete_provider', { providerId }),
  setActiveProvider: (providerId: string): Promise<void> => invoke('set_active_provider', { providerId }),
  setTheme: (theme: Theme): Promise<void> => invoke('set_theme', { theme: theme.toLowerCase() }),
  fetchModels: (apiKey: string, baseUrl: string): Promise<string[]> =>
    invoke('fetch_provider_models', { apiKey, baseUrl }),
};

export const fileApi = {
  readFile: (path: string): Promise<string> => invoke('read_file', { path }),
};
