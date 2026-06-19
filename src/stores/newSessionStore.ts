import { create } from 'zustand';

import type { AgentKind, ReasoningEffort } from '../types/session';

interface NewSessionState {
  selectedAgentKind: AgentKind;
  selectedModel: string | null;
  selectedReasoningEffort: ReasoningEffort;
  draftProjectId: string | null;
  isDraftOpen: boolean;
  openDraft: (projectId?: string | null) => void;
  closeDraft: () => void;
  setSelectedAgentKind: (agentKind: AgentKind) => void;
  setSelectedModel: (model: string | null) => void;
  setSelectedReasoningEffort: (effort: ReasoningEffort) => void;
}

export const useNewSessionStore = create<NewSessionState>((set) => ({
  selectedAgentKind: 'claude_code',
  selectedModel: null,
  selectedReasoningEffort: 'medium',
  draftProjectId: null,
  isDraftOpen: false,
  openDraft: (draftProjectId = null) => set({ draftProjectId, isDraftOpen: true, selectedModel: null, selectedReasoningEffort: 'medium' }),
  closeDraft: () => set({ draftProjectId: null, isDraftOpen: false, selectedModel: null, selectedReasoningEffort: 'medium' }),
  setSelectedAgentKind: (selectedAgentKind) => set({ selectedAgentKind }),
  setSelectedModel: (selectedModel) => set({ selectedModel }),
  setSelectedReasoningEffort: (selectedReasoningEffort) => set({ selectedReasoningEffort }),
}));
