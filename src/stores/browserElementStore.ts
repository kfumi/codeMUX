import { create } from 'zustand';

import {
  mergeBrowserElementsIntoText,
  type BrowserElementCapture,
} from '../lib/browserElementFormat';
import { createBrowserId } from '../lib/browserPage';
import type { AgentInputPayload } from '../types/agentInput';

export interface BrowserElementReference extends BrowserElementCapture {
  id: string;
}

interface BrowserElementState {
  elementsBySession: Record<string, BrowserElementReference[]>;
  add: (sessionId: string, capture: BrowserElementCapture) => void;
  remove: (sessionId: string, id: string) => void;
  clear: (sessionId: string) => void;
  consume: (sessionId: string) => BrowserElementReference[];
  reset: () => void;
}

export const useBrowserElementStore = create<BrowserElementState>((set, get) => ({
  elementsBySession: {},

  add: (sessionId, capture) => {
    const reference: BrowserElementReference = { ...capture, id: createBrowserId() };
    set((state) => ({
      elementsBySession: {
        ...state.elementsBySession,
        [sessionId]: [...(state.elementsBySession[sessionId] ?? []), reference],
      },
    }));
  },

  remove: (sessionId, id) => {
    set((state) => ({
      elementsBySession: {
        ...state.elementsBySession,
        [sessionId]: (state.elementsBySession[sessionId] ?? []).filter((item) => item.id !== id),
      },
    }));
  },

  clear: (sessionId) => {
    set((state) => ({
      elementsBySession: { ...state.elementsBySession, [sessionId]: [] },
    }));
  },

  consume: (sessionId) => {
    const elements = get().elementsBySession[sessionId] ?? [];
    if (elements.length > 0) {
      set((state) => ({
        elementsBySession: { ...state.elementsBySession, [sessionId]: [] },
      }));
    }
    return elements;
  },

  reset: () => set({ elementsBySession: {} }),
}));

export function consumeBrowserElementsForSend(
  sessionId: string,
  payload: AgentInputPayload,
): AgentInputPayload {
  const elements = useBrowserElementStore.getState().consume(sessionId);
  if (elements.length === 0) {
    return payload;
  }
  return {
    ...payload,
    text: mergeBrowserElementsIntoText(payload.text, elements),
  };
}
