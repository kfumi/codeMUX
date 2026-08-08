import type { EnrichmentBlockResult } from '../types/agentInput';

const ATTACHMENT_CONTEXT_BLOCK_PATTERN = /<attachment_context>[\s\S]*?<\/attachment_context>\s*/gi;

/** Remove auto-generated enrichment blocks from user-visible message text. */
export function stripAttachmentEnrichmentContext(text: string): string {
  return text.replace(ATTACHMENT_CONTEXT_BLOCK_PATTERN, '').trim();
}

/** Shorten API error payloads for UI and model context. */
export function summarizeEnrichmentError(error: string | undefined): string {
  const trimmed = (error ?? '').trim();
  if (!trimmed) return 'unknown error';

  const statusMatch = trimmed.match(/Enrichment API failed \((\d+)\):\s*([\s\S]*)/);
  if (statusMatch) {
    const status = statusMatch[1];
    let body = statusMatch[2].trim();
    try {
      const json = JSON.parse(body) as { error?: { message?: string }; message?: string; msg?: string };
      const message = json.error?.message ?? json.message ?? json.msg;
      if (typeof message === 'string' && message.trim()) {
        return `HTTP ${status}: ${message.trim()}`;
      }
    } catch {
      // keep raw body
    }
    if (body.length > 200) {
      body = `${body.slice(0, 200)}…`;
    }
    return `HTTP ${status}: ${body}`;
  }

  if (trimmed.length > 240) {
    return `${trimmed.slice(0, 240)}…`;
  }
  return trimmed;
}

export const ATTACHMENT_CONTEXT_INSTRUCTION = [
  '以下为用户附件的已识别内容（由视觉模型预处理）。',
  '请直接据此回答用户问题；不要声称无法查看图片或附件。',
  '若内容足以识别主体/人物/场景，请明确作答，避免仅用“推测”“可能”等措辞。',
].join('');

export function formatEnrichedContextBlock(blocks: EnrichmentBlockResult[]): string {
  if (blocks.length === 0) {
    return '';
  }

  const sections = blocks.map((block, index) => {
    const header = `### [${index + 1}/${blocks.length}] ${block.attachment_name}`;
    if (block.ok) {
      return `${header}\n${block.markdown.trim()}`;
    }
    const reason = summarizeEnrichmentError(block.error);
    return `${header}\n⚠️ Attachment Enrichment failed (${reason}). Image content unavailable to the model.`;
  });

  return [
    '<attachment_context>',
    ATTACHMENT_CONTEXT_INSTRUCTION,
    '',
    ...sections,
    '',
    '</attachment_context>',
  ].join('\n');
}

export function mergeEnrichedContext(userText: string, blocks: EnrichmentBlockResult[]): string {
  const context = formatEnrichedContextBlock(blocks);
  if (!context) {
    return userText;
  }
  const trimmed = userText.trim();
  return trimmed ? `${context}\n\n${trimmed}` : context;
}

export function filterSuccessfulEnrichmentBlocks(blocks: EnrichmentBlockResult[]): EnrichmentBlockResult[] {
  return blocks.filter((block) => block.ok);
}

export function countEnrichmentFailures(blocks: EnrichmentBlockResult[]): number {
  return blocks.filter((block) => !block.ok).length;
}

export function firstEnrichmentFailureSummary(blocks: EnrichmentBlockResult[]): string | null {
  const failed = blocks.find((block) => !block.ok);
  if (!failed) return null;
  const name = failed.attachment_name || 'attachment';
  return `${name}: ${summarizeEnrichmentError(failed.error)}`;
}
