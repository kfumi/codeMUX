import type { UserAttachmentPreview } from '../types/agentInput';

export type SessionMessageAttachmentsMap = Record<number, UserAttachmentPreview[]>;

type UserEventLike = {
  kind: string;
  data: {
    attachments?: UserAttachmentPreview[];
  };
};

function isUserAttachmentPreview(value: unknown): value is UserAttachmentPreview {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.type === 'image'
    && typeof record.name === 'string'
    && typeof record.mediaType === 'string'
    && typeof record.dataUrl === 'string';
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

export function mergeSessionMessageAttachments<T extends UserEventLike>(
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
    if (!saved?.length || (event.data.attachments?.length ?? 0) > 0) {
      return event;
    }

    return {
      ...event,
      data: {
        ...event.data,
        attachments: saved,
      },
    };
  });
}
