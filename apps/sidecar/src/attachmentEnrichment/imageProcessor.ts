import type { AgentInputAttachment } from '../agentInputPayload.js';
import type { AttachmentEnricher, EnrichmentRuntimeConfig } from './types.js';
import { IMAGE_ENRICHMENT_MAX_OUTPUT_TOKENS, IMAGE_ENRICHMENT_SYSTEM_PROMPT } from './types.js';

export function resolveChatCompletionsUrls(baseUrl: string): string[] {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    return [];
  }
  if (normalized.endsWith('/v1/chat/completions') || normalized.endsWith('/chat/completions')) {
    return [normalized];
  }
  if (normalized.endsWith('/v1')) {
    return [`${normalized}/chat/completions`];
  }
  // Zhipu / OpenAI-compatible bases ending in /vN (e.g. .../paas/v4) use /chat/completions only.
  if (/\/v\d+$/i.test(normalized) || /bigmodel\.cn/i.test(normalized)) {
    return [`${normalized}/chat/completions`];
  }
  return [`${normalized}/v1/chat/completions`, `${normalized}/chat/completions`];
}

async function callOpenAiCompatibleVision(
  config: EnrichmentRuntimeConfig,
  attachment: AgentInputAttachment,
): Promise<string> {
  const urls = resolveChatCompletionsUrls(config.baseUrl);
  if (urls.length === 0) {
    throw new Error('Enrichment base URL is empty');
  }

  const body = {
    model: config.model,
    max_tokens: IMAGE_ENRICHMENT_MAX_OUTPUT_TOKENS,
    messages: [
      { role: 'system', content: IMAGE_ENRICHMENT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Analyze attachment "${attachment.name}" for a coding agent.` },
          { type: 'image_url', image_url: { url: attachment.dataUrl } },
        ],
      },
    ],
  };

  let lastError: unknown;
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Enrichment API failed (${response.status}): ${errorText || response.statusText}`);
      }
      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.trim()) {
        return content.trim();
      }
      if (Array.isArray(content)) {
        const text = content
          .map((part) => (typeof part.text === 'string' ? part.text : ''))
          .join('\n')
          .trim();
        if (text) {
          return text;
        }
      }
      throw new Error('Enrichment API returned empty content');
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function callAnthropicVision(
  config: EnrichmentRuntimeConfig,
  attachment: AgentInputAttachment,
): Promise<string> {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, '') || 'https://api.anthropic.com';
  const url = baseUrl.endsWith('/v1/messages') ? baseUrl : `${baseUrl}/v1/messages`;
  const match = attachment.dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    throw new Error('Invalid image data URL');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: IMAGE_ENRICHMENT_MAX_OUTPUT_TOKENS,
      system: IMAGE_ENRICHMENT_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: match[1] || attachment.mediaType || 'image/png',
                data: match[2] || '',
              },
            },
            {
              type: 'text',
              text: `Analyze attachment "${attachment.name}" for a coding agent.`,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Enrichment API failed (${response.status}): ${errorText || response.statusText}`);
  }

  const payload = await response.json() as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = (payload.content ?? [])
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('\n')
    .trim();
  if (!text) {
    throw new Error('Enrichment API returned empty content');
  }
  return text;
}

export class ImageAttachmentProcessor implements AttachmentEnricher {
  readonly type = 'image' as const;

  async enrich(attachment: AgentInputAttachment, config: EnrichmentRuntimeConfig): Promise<string> {
    if (config.protocol === 'anthropic') {
      return callAnthropicVision(config, attachment);
    }
    return callOpenAiCompatibleVision(config, attachment);
  }
}
