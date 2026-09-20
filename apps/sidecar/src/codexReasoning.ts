import { mapToOpenAIChatEffort, normalizeReasoningEffort } from './reasoningEffort.js';

function readResponsesEffort(body: Record<string, unknown>) {
  const reasoning = body.reasoning;
  if (!reasoning || typeof reasoning !== 'object') return undefined;
  return normalizeReasoningEffort((reasoning as Record<string, unknown>).effort);
}

/** True unless the Responses body explicitly turns thinking off. */
export function isResponsesReasoningEnabled(body: Record<string, unknown>): boolean {
  if (body.reasoning === undefined || body.reasoning === null) return true;
  return readResponsesEffort(body) !== 'none';
}

/**
 * Map Responses `reasoning.effort` onto Chat Completions protocol fields.
 * Vendors are expected to adapt `reasoning_effort` themselves.
 */
export function applyReasoningOptions(
  chatBody: Record<string, unknown>,
  responsesBody: Record<string, unknown>,
  model: string,
): void {
  const effort = readResponsesEffort(responsesBody);
  if (effort === undefined) return;

  const mapped = mapToOpenAIChatEffort(effort);
  if (mapped !== null) {
    chatBody.reasoning_effort = mapped;
  }

  if (model.toLowerCase().includes('gpt-5')) {
    chatBody.thinking = { type: mapped === null ? 'disabled' : 'enabled' };
  }
}
