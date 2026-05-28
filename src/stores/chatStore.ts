import { create } from 'zustand';
import type { ChatMessage } from '../types/chat';
import { chatApi, sessionApi } from '../lib/tauri';

interface ChatState {
  messages: Record<string, ChatMessage[]>;
  isLoading: boolean;
  isStreaming: boolean;
  error: string | null;
  fetchMessages: (sessionId: string) => Promise<void>;
  sendMessage: (sessionId: string, content: string) => Promise<void>;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: {},
  isLoading: false,
  isStreaming: false,
  error: null,
  fetchMessages: async (sessionId: string) => {
    set({ isLoading: true, error: null });
    try {
      const messages = await sessionApi.getMessages(sessionId);
      set((state) => ({
        messages: { ...state.messages, [sessionId]: messages },
        isLoading: false,
      }));
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },
  sendMessage: async (sessionId: string, content: string) => {
    set({ isStreaming: true, error: null });
    const tempUserMessage: ChatMessage = {
      id: `temp-${Date.now()}`,
      session_id: sessionId,
      role: 'user',
      content,
      created_at: new Date().toISOString(),
    };
    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: [...(state.messages[sessionId] || []), tempUserMessage],
      },
    }));
    try {
      await chatApi.sendMessage(sessionId, content);
      const messages = await sessionApi.getMessages(sessionId);
      set((state) => ({
        messages: { ...state.messages, [sessionId]: messages },
        isStreaming: false,
      }));
    } catch (error) {
      set({ error: String(error), isStreaming: false });
    }
  },
}));
