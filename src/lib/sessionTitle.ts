import { agentApi } from './tauri';
import { mapPersistedClaudeMessage } from '../stores/agentEventParsing';
import type { AgentKind } from '../types/session';

export function normalizeSessionTitle(text: string): string {
  return text.split('\n')[0].trim();
}

export function isLegacyTruncatedTitle(title: string): boolean {
  const trimmed = title.trim();
  return trimmed.endsWith('...') && trimmed.length <= 33;
}

export function extractTitleFromCommandMessage(content: string): string | null {
  const trimmed = content.trimStart();
  const slashMatch = /^\/\S+\s+(.*)$/.exec(trimmed);
  if (slashMatch) {
    return slashMatch[1].trim() || null;
  }
  const chipMatch = /^\[\$[^\]]+\]\([^)]+\)\s*([\s\S]*)$/.exec(trimmed);
  if (chipMatch) {
    return chipMatch[1].trim() || null;
  }
  return null;
}

export function getSessionDisplayTitle(title: string): string {
  return title.trim() || '未命名对话';
}

export function buildSessionTitleFromUserContent(content: string): string {
  const extracted = extractTitleFromCommandMessage(content);
  const normalized = normalizeSessionTitle(extracted ?? content);
  return normalized || '未命名对话';
}

export async function resolveSessionTitle(
  sessionId: string,
  agentKind: AgentKind,
  storedTitle: string,
): Promise<string> {
  const trimmed = storedTitle.trim();
  if (trimmed && !isLegacyTruncatedTitle(trimmed)) {
    return getSessionDisplayTitle(trimmed);
  }

  try {
    const rawEvents = await agentApi.loadSessionEvents(sessionId);
    for (const raw of rawEvents) {
      const event = mapPersistedClaudeMessage(raw, agentKind);
      if (event?.kind !== 'user') continue;
      const content = event.data.content.trim();
      if (!content) continue;
      return buildSessionTitleFromUserContent(content);
    }
  } catch {
    // ignore load failures and fall back to stored title
  }

  return getSessionDisplayTitle(trimmed);
}

export function shouldResolveStoredSessionTitle(title: string): boolean {
  const trimmed = title.trim();
  return !trimmed || isLegacyTruncatedTitle(trimmed);
}
