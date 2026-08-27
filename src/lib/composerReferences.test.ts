import { describe, expect, it } from 'vitest';

import { appendComposerReference, formatComposerReference, getProjectRelativePath } from './composerReferences';

describe('composerReferences', () => {
  it('computes project-relative paths', () => {
    expect(getProjectRelativePath('D:/project/app/src/main.ts', 'D:/project/app')).toBe('src/main.ts');
  });

  it('formats file references for the composer', () => {
    expect(formatComposerReference('src/main.ts')).toBe('[main.ts](src/main.ts) ');
  });

  it('formats directory references with a trailing slash', () => {
    expect(formatComposerReference('src/components', true)).toBe('[components](src/components/) ');
  });

  it('appends references with spacing', () => {
    expect(appendComposerReference('hello', 'src/main.ts')).toBe('hello [main.ts](src/main.ts) ');
  });
});
