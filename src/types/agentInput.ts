export type AgentInputAttachmentType = 'image';

export interface AgentInputAttachment {
  type: AgentInputAttachmentType;
  name: string;
  mediaType: string;
  dataUrl: string;
  size?: number;
}

/** @deprecated Prefer AgentInputAttachment with type: 'image'. */
export interface AgentInputImage {
  name: string;
  mediaType: string;
  dataUrl: string;
  size?: number;
}

export interface AgentInputPayload {
  text: string;
  /** @deprecated Prefer attachments. Kept for backward compatibility. */
  images?: AgentInputImage[];
  attachments?: AgentInputAttachment[];
  /** UI/history-only attachments when the model payload omits images (e.g. enrichment). */
  historyAttachments?: AgentInputAttachment[];
}

export interface UserAttachmentPreview {
  type: 'image';
  name: string;
  mediaType: string;
  dataUrl: string;
}

export interface EnrichmentBlockResult {
  attachment_name: string;
  markdown: string;
  ok: boolean;
  error?: string;
}

export interface AttachmentEnrichmentResponse {
  blocks: EnrichmentBlockResult[];
}

export function getPayloadAttachments(payload?: AgentInputPayload): AgentInputAttachment[] {
  if (payload?.attachments?.length) {
    return payload.attachments;
  }
  return (payload?.images ?? []).map((image) => ({
    type: 'image' as const,
    name: image.name,
    mediaType: image.mediaType,
    dataUrl: image.dataUrl,
    size: image.size,
  }));
}

export function getPayloadImageAttachments(payload?: AgentInputPayload): AgentInputAttachment[] {
  return getPayloadAttachments(payload).filter((attachment) => attachment.type === 'image');
}

export function payloadHasAttachments(payload?: AgentInputPayload): boolean {
  return getPayloadAttachments(payload).length > 0;
}
