import { create } from 'zustand';

import type { AgentKind, ReasoningEffort } from '../types/session';
import {
  buildDefaultPermissionConfig,
  type AgentPermissionConfig,
  type AgentPlanMode,
} from '../lib/agentPermissions';

interface NewSessionState {
  selectedAgentKind: AgentKind;
  selectedProviderId: string | null;
  selectedModel: string | null;
  selectedReasoningEffort: ReasoningEffort;
  selectedPermissionConfig: AgentPermissionConfig;
  selectedPlanMode: AgentPlanMode;
  draftProjectId: string | null;
  isDraftOpen: boolean;
  openDraft: (projectId?: string | null) => void;
  closeDraft: () => void;
  setSelectedAgentKind: (agentKind: AgentKind) => void;
  setSelectedProviderId: (providerId: string | null) => void;
  setSelectedModel: (model: string | null) => void;
  setSelectedReasoningEffort: (effort: ReasoningEffort) => void;
  setSelectedPermissionConfig: (permissionConfig: AgentPermissionConfig) => void;
  setSelectedPlanMode: (planMode: AgentPlanMode) => void;
}

export const useNewSessionStore = create<NewSessionState>((set) => ({
  selectedAgentKind: 'claude_code',
  selectedProviderId: null,
  selectedModel: null,
  selectedReasoningEffort: 'medium',
  selectedPermissionConfig: buildDefaultPermissionConfig('claude_code'),
  selectedPlanMode: 'off',
  draftProjectId: null,
  isDraftOpen: false,
  openDraft: (draftProjectId = null) => set((state) => ({
    draftProjectId,
    isDraftOpen: true,
    selectedProviderId: null,
    selectedModel: null,
    selectedReasoningEffort: 'medium',
    selectedPermissionConfig: buildDefaultPermissionConfig(state.selectedAgentKind),
    selectedPlanMode: 'off',
  })),
  closeDraft: () => set((state) => ({
    draftProjectId: null,
    isDraftOpen: false,
    selectedProviderId: null,
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
  setSelectedProviderId: (selectedProviderId) => set({ selectedProviderId }),
  setSelectedModel: (selectedModel) => set({ selectedModel }),
  setSelectedReasoningEffort: (selectedReasoningEffort) => set({ selectedReasoningEffort }),
  setSelectedPermissionConfig: (selectedPermissionConfig) => set({ selectedPermissionConfig }),
  setSelectedPlanMode: (selectedPlanMode) => set({ selectedPlanMode }),
}));
