import type { UserAttachmentPreview } from '../types/agentInput';

export type SessionMessageAttachmentsMap = Record<number, UserAttachmentPreview[]>;

type EventLike = {
  kind: string;
};

type UserDataWithAttachments = {
  attachments?: UserAttachmentPreview[];
};

function isUserAttachmentPreview(value: unknown): value is UserAttachmentPreview {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.type === 'image'
    && typeof record.name === 'string'
    && typeof record.mediaType === 'string'
    && typeof record.dataUrl === 'string';
}

function readUserAttachments(event: EventLike): UserAttachmentPreview[] | undefined {
  if (!('data' in event) || !event.data || typeof event.data !== 'object') {
    return undefined;
  }
  return (event.data as UserDataWithAttachments).attachments;
}

export function parseSessionMessageAttachmentsMap(
  raw: Record<number, unknown[]>,
): SessionMessageAttachmentsMap {
  const map: SessionMessageAttachmentsMap = {};
  for (const [index, attachments] of Object.entries(raw)) {
    const parsed = (attachments ?? []).filter(isUserAttachmentPreview);
    if (parsed.length > 0) {
      map[Number(index)] = parsed;
    }
  }
  return map;
}

/** Merge persisted previews into user events. Accepts full session event unions (incl. variants without `data`). */
export function mergeSessionMessageAttachments<T extends EventLike>(
  events: T[],
  attachmentsByUserIndex: SessionMessageAttachmentsMap,
): T[] {
  if (Object.keys(attachmentsByUserIndex).length === 0) {
    return events;
  }

  let userIndex = 0;
  return events.map((event) => {
    if (event.kind !== 'user') {
      return event;
    }

    const saved = attachmentsByUserIndex[userIndex];
    userIndex += 1;
    const existing = readUserAttachments(event);
    if (!saved?.length || (existing?.length ?? 0) > 0) {
      return event;
    }

    const data = ('data' in event && event.data && typeof event.data === 'object')
      ? event.data as UserDataWithAttachments
      : {};

    return {
      ...event,
      data: {
        ...data,
        attachments: saved,
      },
    };
  });
}
