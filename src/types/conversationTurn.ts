export type ConversationTurnStatus = 'running' | 'completed' | 'interrupted' | 'failed';

export type ConversationTurnTerminationKind = 'completed' | 'interrupted' | 'failed';

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
  durationMs?: number;
  numTurns?: number;
  termination?: ConversationTurnTermination;
  diagnostics: ConversationTurnDiagnostic[];
  rawEvents?: unknown[];
  footerAnchorEventIndex?: number;
}
