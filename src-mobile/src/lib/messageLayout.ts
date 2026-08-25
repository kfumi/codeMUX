import type { ChatMessage, SessionSummaryDiff } from './eventToMessages';

export interface MessageFooterData {
  timestamp?: number;
  durationMs?: number;
  sourceUuid?: string;
}

export type DisplayRow =
  | {
      kind: 'single';
      message: ChatMessage;
      sessionSummaries?: SessionSummaryDiff[];
      footer?: MessageFooterData;
    }
  | { kind: 'thinking'; id: string; messages: Extract<ChatMessage, { kind: 'reasoning' }>[] }
  | { kind: 'tool-group'; id: string; messages: Extract<ChatMessage, { kind: 'tool' }>[]; toolNames: string[] }
  | { kind: 'compact-toggle'; turnKey: string; processCount: number; durationMs?: number };

export interface BuildDisplayRowsOptions {
  compactAiOutput: boolean;
  expandedTurnKeys: ReadonlySet<string>;
  turnDurationsByUserId?: ReadonlyMap<string, number>;
}

/** Boundary markers that must stay visible outside compact process folds. */
export function isSeamMessage(message: ChatMessage): boolean {
  if (message.kind === 'system' && message.content.trimStart().startsWith('—')) {
    return true;
  }
  return false;
}

type TurnPiece =
  | { type: 'seam'; message: ChatMessage }
  | { type: 'chunk'; messages: ChatMessage[] };

function isGroupableToolMessage(message: ChatMessage): message is Extract<ChatMessage, { kind: 'tool' }> {
  return message.kind === 'tool';
}

function groupProcessRows(messages: ChatMessage[]): DisplayRow[] {
  const rows: DisplayRow[] = [];
  let toolBuffer: Extract<ChatMessage, { kind: 'tool' }>[] = [];
  let reasoningBuffer: Extract<ChatMessage, { kind: 'reasoning' }>[] = [];

  const flushReasoning = () => {
    if (reasoningBuffer.length === 0) {
      return;
    }
    rows.push({
      kind: 'thinking',
      id: reasoningBuffer[0]?.id ?? `thinking-${rows.length}`,
      messages: [...reasoningBuffer],
    });
    reasoningBuffer = [];
  };

  const flushTools = () => {
    if (toolBuffer.length === 0) {
      return;
    }
    rows.push({
      kind: 'tool-group',
      id: toolBuffer[0]?.id ?? `tool-group-${rows.length}`,
      messages: [...toolBuffer],
      toolNames: toolBuffer.map((message) => message.name),
    });
    toolBuffer = [];
  };

  for (const message of messages) {
    if (message.kind === 'reasoning') {
      flushTools();
      reasoningBuffer.push(message);
      continue;
    }
    if (isGroupableToolMessage(message)) {
      flushReasoning();
      toolBuffer.push(message);
      continue;
    }
    flushReasoning();
    flushTools();
    rows.push({ kind: 'single', message });
  }

  flushReasoning();
  flushTools();
  return rows;
}

function partitionTurnSegment(segment: ChatMessage[]): {
  body: ChatMessage[];
  summaries: Extract<ChatMessage, { kind: 'session_summary' }>[];
} {
  const summaries: Extract<ChatMessage, { kind: 'session_summary' }>[] = [];
  const body = segment.filter((message) => {
    if (message.kind === 'session_summary') {
      summaries.push(message);
      return false;
    }
    return true;
  });
  return { body, summaries };
}

function coalesceSessionSummaryDiffs(
  summaries: Extract<ChatMessage, { kind: 'session_summary' }>[],
): SessionSummaryDiff[] {
  const latestByFile = new Map<string, SessionSummaryDiff>();
  for (const summary of summaries) {
    for (const diff of summary.diffs) {
      latestByFile.set(diff.file, diff);
    }
  }
  return [...latestByFile.values()];
}

function splitTurnSegment(
  segment: ChatMessage[],
): { process: ChatMessage[]; answer?: Extract<ChatMessage, { kind: 'assistant' }> } {
  const process: ChatMessage[] = [];
  let answer: Extract<ChatMessage, { kind: 'assistant' }> | undefined;

  for (const message of segment) {
    if (message.kind === 'assistant') {
      if (answer) {
        process.push(answer);
      }
      answer = message;
      continue;
    }
    process.push(message);
  }

  return { process, answer };
}

function splitTurnBodyIntoPieces(body: ChatMessage[]): TurnPiece[] {
  const pieces: TurnPiece[] = [];
  let chunk: ChatMessage[] = [];

  const flushChunk = () => {
    if (chunk.length === 0) {
      return;
    }
    pieces.push({ type: 'chunk', messages: chunk });
    chunk = [];
  };

  for (const message of body) {
    if (isSeamMessage(message)) {
      flushChunk();
      pieces.push({ type: 'seam', message });
      continue;
    }
    chunk.push(message);
  }

  flushChunk();
  return pieces;
}

function emitTurnRows(
  turnKey: string,
  segment: ChatMessage[],
  options: BuildDisplayRowsOptions,
  rows: DisplayRow[],
) {
  if (segment.length === 0) {
    return;
  }

  const { body, summaries } = partitionTurnSegment(segment);
  const sessionSummaries = coalesceSessionSummaryDiffs(summaries);
  const pieces = splitTurnBodyIntoPieces(body);

  let lastAnswerPieceIndex = -1;
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const piece = pieces[index];
    if (piece.type !== 'chunk') {
      continue;
    }
    const { answer } = splitTurnSegment(piece.messages);
    if (answer) {
      lastAnswerPieceIndex = index;
      break;
    }
  }

  pieces.forEach((piece, index) => {
    if (piece.type === 'seam') {
      rows.push({ kind: 'single', message: piece.message });
      return;
    }

    const { process, answer } = splitTurnSegment(piece.messages);
    const expanded = options.expandedTurnKeys.has(turnKey);

    const hasNonReasoningProcess = process.some((message) => message.kind !== 'reasoning');
    if (options.compactAiOutput && hasNonReasoningProcess) {
      rows.push({
        kind: 'compact-toggle',
        turnKey,
        processCount: process.length,
        durationMs: options.turnDurationsByUserId?.get(turnKey),
      });
      if (expanded) {
        rows.push(...groupProcessRows(process));
      }
    } else if (process.length > 0) {
      rows.push(...groupProcessRows(process));
    }

    if (answer) {
      const durationMs = options.turnDurationsByUserId?.get(turnKey);
      rows.push({
        kind: 'single',
        message: answer,
        ...(index === lastAnswerPieceIndex && sessionSummaries.length > 0 ? { sessionSummaries } : {}),
        ...(index === lastAnswerPieceIndex && durationMs != null
          ? {
              footer: {
                ...(answer.timestamp != null ? { timestamp: answer.timestamp } : {}),
                ...(answer.sourceUuid ? { sourceUuid: answer.sourceUuid } : {}),
                durationMs,
              },
            }
          : {}),
      });
    }
  });

  if (sessionSummaries.length > 0 && lastAnswerPieceIndex < 0) {
    rows.push({
      kind: 'single',
      message: {
        kind: 'session_summary',
        id: `${turnKey}-summary`,
        diffs: sessionSummaries,
      },
    });
  }
}

export function buildDisplayRows(
  messages: ChatMessage[],
  options: BuildDisplayRowsOptions,
): DisplayRow[] {
  const rows: DisplayRow[] = [];
  let segment: ChatMessage[] = [];
  let turnKey = 'turn-0';
  let turnIndex = 0;

  const flushSegment = () => {
    emitTurnRows(turnKey, segment, options, rows);
    segment = [];
  };

  for (const message of messages) {
    if (message.kind === 'user') {
      flushSegment();
      rows.push({
        kind: 'single',
        message,
        footer: {
          ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
          ...(message.sourceUuid ? { sourceUuid: message.sourceUuid } : {}),
        },
      });
      turnKey = message.id;
      turnIndex += 1;
      continue;
    }

    if (segment.length === 0 && turnIndex === 0) {
      turnKey = `turn-${turnIndex}`;
    }

    segment.push(message);
  }

  flushSegment();
  return rows;
}
