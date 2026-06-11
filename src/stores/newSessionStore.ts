import { create } from 'zustand';

import type { AgentKind } from '../types/session';

interface NewSessionState {
  selectedAgentKind: AgentKind;
  draftProjectId: string | null;
  isDraftOpen: boolean;
  openDraft: (projectId?: string | null) => void;
  closeDraft: () => void;
  setSelectedAgentKind: (agentKind: AgentKind) => void;
}

export const useNewSessionStore = create<NewSessionState>((set) => ({
  selectedAgentKind: 'claude_code',
  draftProjectId: null,
  isDraftOpen: false,
  openDraft: (draftProjectId = null) => set({ draftProjectId, isDraftOpen: true }),
  closeDraft: () => set({ draftProjectId: null, isDraftOpen: false }),
  setSelectedAgentKind: (selectedAgentKind) => set({ selectedAgentKind }),
}));
