import type { ChatMessage, SessionSummaryDiff } from './eventToMessages';
import { isFileMutationTool } from './toolHeaderSummary';

export type DisplayRow =
  | { kind: 'single'; message: ChatMessage; sessionSummaries?: SessionSummaryDiff[] }
  | { kind: 'explore'; id: string; messages: ChatMessage[]; toolNames: string[] }
  | { kind: 'compact-toggle'; turnKey: string; processCount: number };

export interface BuildDisplayRowsOptions {
  compactAiOutput: boolean;
  expandedTurnKeys: ReadonlySet<string>;
}

/** Boundary markers that must stay visible outside compact process folds. */
export function isSeamMessage(message: ChatMessage): boolean {
  if (message.kind === 'runtime_switch') {
    return true;
  }
  if (message.kind === 'system' && message.content.trimStart().startsWith('—')) {
    return true;
  }
  return false;
}

type TurnPiece =
  | { type: 'seam'; message: ChatMessage }
  | { type: 'chunk'; messages: ChatMessage[] };

function isExploreProcessMessage(message: ChatMessage): boolean {
  if (message.kind === 'reasoning') {
    return true;
  }
  if (message.kind === 'tool') {
    return !isFileMutationTool(message.name, message.inputObj);
  }
  return false;
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

function splitTurnSegment(segment: ChatMessage[]): { process: ChatMessage[]; answer?: ChatMessage } {
  const process: ChatMessage[] = [];
  let answer: ChatMessage | undefined;

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

function groupExploreRows(messages: ChatMessage[]): DisplayRow[] {
  const rows: DisplayRow[] = [];
  let buffer: ChatMessage[] = [];

  const flushExplore = () => {
    if (buffer.length === 0) {
      return;
    }
    const toolNames = buffer
      .filter((message): message is Extract<ChatMessage, { kind: 'tool' }> => message.kind === 'tool')
      .map((message) => message.name);
    rows.push({
      kind: 'explore',
      id: buffer[0]?.id ?? `explore-${rows.length}`,
      messages: [...buffer],
      toolNames,
    });
    buffer = [];
  };

  for (const message of messages) {
    if (isExploreProcessMessage(message)) {
      buffer.push(message);
      continue;
    }
    flushExplore();
    rows.push({ kind: 'single', message });
  }

  flushExplore();
  return rows;
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

    if (options.compactAiOutput && process.length > 0) {
      rows.push({ kind: 'compact-toggle', turnKey, processCount: process.length });
      if (expanded) {
        rows.push(...groupExploreRows(process));
      }
    } else if (process.length > 0) {
      rows.push(...groupExploreRows(process));
    }

    if (answer) {
      rows.push({
        kind: 'single',
        message: answer,
        ...(index === lastAnswerPieceIndex && sessionSummaries.length > 0 ? { sessionSummaries } : {}),
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
      rows.push({ kind: 'single', message });
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
