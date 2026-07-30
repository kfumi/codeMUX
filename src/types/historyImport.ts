import type { AgentKind, Session } from './session';

export interface ImportCandidate {
  key: string;
  agentKind: AgentKind;
  agentSessionId: string;
  title: string;
  cwd: string | null;
  createdAt: string;
  updatedAt: string;
  sourceLocator: string;
  sourceFingerprint: string;
  eventCount: number;
  alreadyImported: boolean;
  warnings: string[];
}

export interface ImportSessionsRequest {
  candidateKeys: string[];
  projectId?: string | null;
  refreshExisting: boolean;
  agentKind?: AgentKind;
}

export interface ImportSessionsResult {
  sessions: Session[];
  importedCount: number;
  refreshedCount: number;
  skippedKeys: string[];
  errors: string[];
}
