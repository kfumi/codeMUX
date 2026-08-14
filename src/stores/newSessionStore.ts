import { create } from 'zustand';

import type { AgentKind, ReasoningEffort } from '../types/session';
import {
  buildDefaultPermissionConfig,
  type AgentPermissionConfig,
  type AgentPlanMode,
} from '../lib/agentPermissions';

/** Shared composer/runtime id for the empty-state new-session draft. */
export const NEW_SESSION_DRAFT_SESSION_ID = 'new-session-draft';

interface NewSessionState {
  selectedAgentKind: AgentKind;
  selectedModel: string | null;
  selectedProviderId: string | null;
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
  setSelectedProviderId: (providerId: string | null) => void;
  setSelectedReasoningEffort: (effort: ReasoningEffort) => void;
  setSelectedPermissionConfig: (permissionConfig: AgentPermissionConfig) => void;
  setSelectedPlanMode: (planMode: AgentPlanMode) => void;
}

export const useNewSessionStore = create<NewSessionState>((set) => ({
  selectedAgentKind: 'claude_code',
  selectedModel: null,
  selectedProviderId: null,
  selectedReasoningEffort: 'high',
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
    selectedProviderId: null,
    selectedReasoningEffort: 'high',
    selectedPermissionConfig: permissionConfig ?? buildDefaultPermissionConfig(state.selectedAgentKind),
    selectedPlanMode: 'off',
  })),
  closeDraft: () => set((state) => ({
    draftProjectId: null,
    isDraftOpen: false,
    selectedModel: null,
    selectedProviderId: null,
    selectedReasoningEffort: 'high',
    selectedPermissionConfig: buildDefaultPermissionConfig(state.selectedAgentKind),
    selectedPlanMode: 'off',
  })),
  setSelectedAgentKind: (selectedAgentKind) => set((state) => {
    if (state.selectedAgentKind === selectedAgentKind) {
      return state;
    }

    return {
      selectedAgentKind,
      selectedModel: null,
      selectedProviderId: null,
      selectedPermissionConfig: buildDefaultPermissionConfig(selectedAgentKind),
      selectedPlanMode: 'off',
    };
  }),
  setSelectedModel: (selectedModel) => set({ selectedModel }),
  setSelectedProviderId: (selectedProviderId) => set({ selectedProviderId }),
  setSelectedReasoningEffort: (selectedReasoningEffort) => set({ selectedReasoningEffort }),
  setSelectedPermissionConfig: (selectedPermissionConfig) => set({ selectedPermissionConfig }),
  setSelectedPlanMode: (selectedPlanMode) => set({ selectedPlanMode }),
}));
