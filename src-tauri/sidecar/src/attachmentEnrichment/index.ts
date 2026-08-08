import type { AgentInputAttachment } from '../agentInputPayload.js';
import { ImageAttachmentProcessor } from './imageProcessor.js';
import type { AttachmentEnricher, EnrichmentBlockResult, EnrichmentRuntimeConfig } from './types.js';

const enricherRegistry = new Map<AgentInputAttachment['type'], AttachmentEnricher>([
  ['image', new ImageAttachmentProcessor()],
]);

export function registerAttachmentEnricher(enricher: AttachmentEnricher): void {
  enricherRegistry.set(enricher.type, enricher);
}

export async function enrichAttachments(
  attachments: AgentInputAttachment[],
  config: EnrichmentRuntimeConfig,
): Promise<EnrichmentBlockResult[]> {
  return Promise.all(attachments.map(async (attachment) => {
    const enricher = enricherRegistry.get(attachment.type);
    if (!enricher) {
      return {
        attachment_name: attachment.name,
        markdown: '',
        ok: false,
        error: `unsupported attachment type: ${attachment.type}`,
      };
    }

    try {
      const markdown = await enricher.enrich(attachment, config);
      return {
        attachment_name: attachment.name,
        markdown,
        ok: true,
      };
    } catch (error) {
      return {
        attachment_name: attachment.name,
        markdown: '',
        ok: false,
        error: String(error),
      };
    }
  }));
}

export { formatEnrichedContextBlock } from './types.js';
