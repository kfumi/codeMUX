import type { AgentInputAttachment } from '../agentInputPayload.js';

export interface EnrichmentRuntimeConfig {
  protocol: 'anthropic' | 'openai_compatible';
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface EnrichmentBlockResult {
  attachment_name: string;
  markdown: string;
  ok: boolean;
  error?: string;
}

export interface AttachmentEnricher {
  readonly type: AgentInputAttachment['type'];
  enrich(attachment: AgentInputAttachment, config: EnrichmentRuntimeConfig): Promise<string>;
}

export interface EnrichmentResultEvent {
  type: 'enrichment_result';
  request_id: string;
  ok: boolean;
  blocks?: EnrichmentBlockResult[];
  error?: string;
}

export const IMAGE_ENRICHMENT_MAX_OUTPUT_TOKENS = 1024;

export const IMAGE_ENRICHMENT_SYSTEM_PROMPT = [
  'You analyze attachments for a coding agent.',
  'Return concise Markdown in Simplified Chinese describing everything visible in the image.',
  'Prioritize verbatim extraction of visible text, especially errors, stack traces, file paths, line numbers, terminal output, and code snippets.',
  'Identify characters, UI components, or IDE context when relevant; name recognizable people or fictional characters when visible.',
  'Do not speculate beyond what is visible.',
].join(' ');

export function formatEnrichedContextBlock(blocks: EnrichmentBlockResult[]): string {
  if (blocks.length === 0) {
    return '';
  }

  const sections = blocks.map((block, index) => {
    const header = `### [${index + 1}/${blocks.length}] ${block.attachment_name}`;
    if (block.ok) {
      return `${header}\n${block.markdown.trim()}`;
    }
    const reason = block.error?.trim() || 'unknown error';
    return `${header}\n⚠️ Attachment Enrichment failed (${reason}). Image content unavailable to the model.`;
  });

  return [
    '<attachment_context>',
    '以下为用户附件的已识别内容（由视觉模型预处理）。请直接据此回答用户问题；不要声称无法查看图片或附件。',
    '',
    ...sections,
    '',
    '</attachment_context>',
  ].join('\n');
}
