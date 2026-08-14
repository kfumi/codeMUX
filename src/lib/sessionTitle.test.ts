import { describe, expect, it } from 'vitest';

import {
  buildSessionTitleFromUserContent,
  getSessionDisplayTitle,
  isLegacyTruncatedTitle,
  normalizeSessionTitle,
  shouldResolveStoredSessionTitle,
} from './sessionTitle';

describe('sessionTitle', () => {
  it('detects legacy truncated titles', () => {
    expect(isLegacyTruncatedTitle('研究下这个项目：https://github.com/Che...')).toBe(true);
    expect(isLegacyTruncatedTitle('完整标题不会被误判')).toBe(false);
    expect(shouldResolveStoredSessionTitle('研究下这个项目：https://github.com/Che...')).toBe(true);
  });

  it('keeps the first line as the session title', () => {
    expect(normalizeSessionTitle('第一行\n第二行')).toBe('第一行');
    expect(buildSessionTitleFromUserContent('研究下这个项目：https://github.com/CherryHQ/cherry-studio')).toBe(
      '研究下这个项目：https://github.com/CherryHQ/cherry-studio',
    );
  });

  it('falls back to unnamed title', () => {
    expect(getSessionDisplayTitle('   ')).toBe('未命名对话');
  });
});
