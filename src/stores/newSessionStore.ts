import { create } from 'zustand';

import type { AgentKind, ReasoningEffort } from '../types/session';
import {
  buildDefaultPermissionConfig,
  type AgentPermissionConfig,
  type AgentPlanMode,
} from '../lib/agentPermissions';

interface NewSessionState {
  selectedAgentKind: AgentKind;
  selectedModel: string | null;
  selectedReasoningEffort: ReasoningEffort;
  selectedPermissionConfig: AgentPermissionConfig;
  selectedPlanMode: AgentPlanMode;
  draftProjectId: string | null;
  isDraftOpen: boolean;
  openDraft: (projectId?: string | null) => void;
  closeDraft: () => void;
  setSelectedAgentKind: (agentKind: AgentKind) => void;
  setSelectedModel: (model: string | null) => void;
  setSelectedReasoningEffort: (effort: ReasoningEffort) => void;
  setSelectedPermissionConfig: (permissionConfig: AgentPermissionConfig) => void;
  setSelectedPlanMode: (planMode: AgentPlanMode) => void;
}

export const useNewSessionStore = create<NewSessionState>((set) => ({
  selectedAgentKind: 'claude_code',
  selectedModel: null,
  selectedReasoningEffort: 'medium',
  selectedPermissionConfig: buildDefaultPermissionConfig('claude_code'),
  selectedPlanMode: 'off',
  draftProjectId: null,
  isDraftOpen: false,
  openDraft: (draftProjectId = null) => set((state) => ({
    draftProjectId,
    isDraftOpen: true,
    selectedModel: null,
    selectedReasoningEffort: 'medium',
    selectedPermissionConfig: buildDefaultPermissionConfig(state.selectedAgentKind),
    selectedPlanMode: 'off',
  })),
  closeDraft: () => set((state) => ({
    draftProjectId: null,
    isDraftOpen: false,
    selectedModel: null,
    selectedReasoningEffort: 'medium',
    selectedPermissionConfig: buildDefaultPermissionConfig(state.selectedAgentKind),
    selectedPlanMode: 'off',
  })),
  setSelectedAgentKind: (selectedAgentKind) => set({
    selectedAgentKind,
    selectedPermissionConfig: buildDefaultPermissionConfig(selectedAgentKind),
    selectedPlanMode: 'off',
  }),
  setSelectedModel: (selectedModel) => set({ selectedModel }),
  setSelectedReasoningEffort: (selectedReasoningEffort) => set({ selectedReasoningEffort }),
  setSelectedPermissionConfig: (selectedPermissionConfig) => set({ selectedPermissionConfig }),
  setSelectedPlanMode: (selectedPlanMode) => set({ selectedPlanMode }),
}));
