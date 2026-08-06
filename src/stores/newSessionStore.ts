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
  draftRevision: number;
  isDraftOpen: boolean;
  openDraft: (projectId?: string | null, permissionConfig?: AgentPermissionConfig) => void;
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
  draftRevision: 0,
  isDraftOpen: false,
  openDraft: (draftProjectId = null, permissionConfig) => set((state) => ({
    draftProjectId,
    draftRevision: state.draftRevision + 1,
    isDraftOpen: true,
    selectedModel: null,
    selectedReasoningEffort: 'medium',
    selectedPermissionConfig: permissionConfig ?? buildDefaultPermissionConfig(state.selectedAgentKind),
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
  setSelectedAgentKind: (selectedAgentKind) => set((state) => {
    if (state.selectedAgentKind === selectedAgentKind) {
      return state;
    }

    return {
      selectedAgentKind,
      selectedPermissionConfig: buildDefaultPermissionConfig(selectedAgentKind),
      selectedPlanMode: 'off',
    };
  }),
  setSelectedModel: (selectedModel) => set({ selectedModel }),
  setSelectedReasoningEffort: (selectedReasoningEffort) => set({ selectedReasoningEffort }),
  setSelectedPermissionConfig: (selectedPermissionConfig) => set({ selectedPermissionConfig }),
  setSelectedPlanMode: (selectedPlanMode) => set({ selectedPlanMode }),
}));
