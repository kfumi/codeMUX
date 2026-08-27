import { isTerminalAgentEvent } from '../stores/agentEventParsing';
import type { AgentMessage } from '../stores/agentStore';

export function shouldAttachLiveTurn(
  events: AgentMessage[],
  companionTurnActive: boolean,
): boolean {
  if (!companionTurnActive) return false;

  const lastUserIndex = findLastIndex(events, (event) => event.kind === 'user');
  if (lastUserIndex < 0) return true;

  return !events.slice(lastUserIndex + 1).some((event) => isTerminalAgentEvent(event.kind));
}

export function shouldFollowBackgroundStream(
  isRunning: boolean,
  backgroundLive: boolean,
): boolean {
  return backgroundLive || !isRunning;
}

export function shouldKeepLiveEventsOnHistoryLoad(
  isRunning: boolean,
  backgroundLive: boolean,
): boolean {
  return isRunning && !backgroundLive;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}
