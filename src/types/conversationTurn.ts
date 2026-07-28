export type ConversationTurnStatus = 'running' | 'completed' | 'interrupted' | 'failed';

export type ConversationTurnTerminationKind = 'completed' | 'interrupted' | 'failed';

export interface ConversationTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface ConversationTurnDiagnostic {
  code: string;
  message: string;
  eventIndex?: number;
}

export interface ConversationTurnTermination {
  kind: ConversationTurnTerminationKind;
  reason?: string;
}

export interface ConversationTurn<TMessage = unknown> {
  id: string;
  messages: TMessage[];
  eventIndices: number[];
  hasRealUser: boolean;
  status: ConversationTurnStatus;
  pendingToolIds: string[];
  usage?: ConversationTurnUsage;
  durationMs?: number;
  numTurns?: number;
  termination?: ConversationTurnTermination;
  diagnostics: ConversationTurnDiagnostic[];
  rawEvents?: unknown[];
  footerAnchorEventIndex?: number;
}
