import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildPiExtensionSource,
  createPiExtensionFile,
  parsePiInteractiveTitle,
  piApprovalTools,
  PI_APPROVAL_CHOICES,
  PI_APPROVE_TITLE_PREFIX,
  PI_ASK_TITLE_PREFIX,
} from './piExtension.js';

const pendingCleanups: Array<() => void> = [];

afterEach(() => {
  while (pendingCleanups.length > 0) {
    pendingCleanups.pop()?.();
  }
});

describe('piExtension', () => {
  it('maps approval tiers onto tool sets', () => {
    expect(piApprovalTools('confirm_before_edit')).toEqual(['bash', 'edit', 'write']);
    expect(piApprovalTools('auto_edit')).toEqual(['bash']);
    expect(piApprovalTools('full_access')).toEqual([]);
  });

  it('embeds markers, choices and the policy mode into the extension source', () => {
    const source = buildPiExtensionSource('auto_edit');
    expect(source).toContain(PI_APPROVE_TITLE_PREFIX);
    expect(source).toContain(PI_ASK_TITLE_PREFIX);
    expect(source).toContain(JSON.stringify(PI_APPROVAL_CHOICES));
    expect(source).toContain(JSON.stringify(['bash']));
    expect(source).toContain('registerTool');
    expect(source).toContain('"ask_user_question"');
    expect(source).toContain('tool_call');
    // 生成物在 tmpdir 加载，必须经 typebox 别名导入 schema。
    expect(source).toContain('from "typebox"');
  });

  it('parses marker titles and rejects foreign payloads', () => {
    const payload = { toolCallId: 't1', toolName: 'bash' };
    expect(parsePiInteractiveTitle(PI_APPROVE_TITLE_PREFIX, PI_APPROVE_TITLE_PREFIX + JSON.stringify(payload)))
      .toEqual(payload);
    expect(parsePiInteractiveTitle(PI_APPROVE_TITLE_PREFIX, PI_ASK_TITLE_PREFIX + '{}')).toBeNull();
    expect(parsePiInteractiveTitle(PI_APPROVE_TITLE_PREFIX, PI_APPROVE_TITLE_PREFIX + 'not-json')).toBeNull();
    expect(parsePiInteractiveTitle(PI_APPROVE_TITLE_PREFIX, PI_APPROVE_TITLE_PREFIX + '[1]')).toBeNull();
  });

  it('creates the extension file in a temp dir and cleans it up', () => {
    const file = createPiExtensionFile('confirm_before_edit');
    pendingCleanups.push(file.cleanup);
    expect(fs.existsSync(file.path)).toBe(true);
    expect(fs.readFileSync(file.path, 'utf8')).toContain('codemuxIntegration');
    file.cleanup();
    expect(fs.existsSync(file.path)).toBe(false);
  });
});
