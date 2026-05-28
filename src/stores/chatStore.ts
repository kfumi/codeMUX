import { create } from 'zustand';
import type { ChatMessage } from '../types/chat';
import { chatApi, sessionApi } from '../lib/tauri';

interface ChatState {
  messages: Record<string, ChatMessage[]>;
  isLoading: boolean;
  isStreaming: boolean;
  streamingContent: Record<string, string>;
  error: string | null;
  fetchMessages: (sessionId: string) => Promise<void>;
  sendMessage: (sessionId: string, content: string) => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: {},
  isLoading: false,
  isStreaming: false,
  streamingContent: {},
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
    set({ isStreaming: true, error: null, streamingContent: { ...get().streamingContent, [sessionId]: '' } });

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
      await chatApi.sendMessageStream(sessionId, content, (token: string) => {
        set((state) => ({
          streamingContent: {
            ...state.streamingContent,
            [sessionId]: (state.streamingContent[sessionId] || '') + token,
          },
        }));
      });

      const messages = await sessionApi.getMessages(sessionId);
      set((state) => {
        const newStreamingContent = { ...state.streamingContent };
        delete newStreamingContent[sessionId];
        return {
          messages: { ...state.messages, [sessionId]: messages },
          isStreaming: false,
          streamingContent: newStreamingContent,
        };
      });
    } catch (error) {
      set({ error: String(error), isStreaming: false });
    }
  },
}));
