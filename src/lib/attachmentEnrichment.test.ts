import { describe, expect, it } from 'vitest';

import {
  countEnrichmentFailures,
  filterSuccessfulEnrichmentBlocks,
  firstEnrichmentFailureSummary,
  formatEnrichedContextBlock,
  mergeEnrichedContext,
  stripAttachmentEnrichmentContext,
  summarizeEnrichmentError,
} from './attachmentEnrichment';

describe('attachmentEnrichment', () => {
  it('wraps successful blocks in attachment_context', () => {
    const text = formatEnrichedContextBlock([
      { attachment_name: 'screen.png', markdown: 'Terminal shows ECONNREFUSED.', ok: true },
    ]);

    expect(text).toContain('<attachment_context>');
    expect(text).toContain('不要声称无法查看图片');
    expect(text).toContain('### [1/1] screen.png');
    expect(text).toContain('Terminal shows ECONNREFUSED.');
  });

  it('merges enriched context ahead of the user text', () => {
    const merged = mergeEnrichedContext('fix this', [
      { attachment_name: 'screen.png', markdown: 'Visible error output.', ok: true },
    ]);

    expect(merged.startsWith('<attachment_context>')).toBe(true);
    expect(merged.endsWith('fix this')).toBe(true);
  });

  it('strips attachment_context from user-visible text', () => {
    const stripped = stripAttachmentEnrichmentContext([
      '<attachment_context>',
      'secret',
      '</attachment_context>',
      '',
      '这是谁',
    ].join('\n'));
    expect(stripped).toBe('这是谁');
  });

  it('filters failed blocks for silent merge', () => {
    expect(filterSuccessfulEnrichmentBlocks([
      { attachment_name: 'a.png', markdown: 'ok', ok: true },
      { attachment_name: 'b.png', markdown: '', ok: false, error: 'timeout' },
    ])).toEqual([
      { attachment_name: 'a.png', markdown: 'ok', ok: true },
    ]);
  });

  it('annotates failed blocks when explicitly merged', () => {
    const merged = mergeEnrichedContext('fix this', [
      { attachment_name: 'a.png', markdown: 'ok', ok: true },
      { attachment_name: 'b.png', markdown: '', ok: false, error: 'timeout' },
    ]);

    expect(merged).toContain('ok');
    expect(merged).toContain('Attachment Enrichment failed (timeout)');
  });

  it('summarizes JSON API errors for display', () => {
    const summary = summarizeEnrichmentError(
      'Enrichment API failed (400): {"error":{"message":"Unknown Model, correct model keys: glm-4.6v-flash"}}',
    );
    expect(summary).toContain('HTTP 400');
    expect(summary).toContain('Unknown Model');
  });

  it('extracts first failure summary for logging', () => {
    expect(firstEnrichmentFailureSummary([
      { attachment_name: 'ggbond.jpg', markdown: '', ok: false, error: 'Enrichment API failed (401): unauthorized' },
    ])).toBe('ggbond.jpg: HTTP 401: unauthorized');
  });
});
