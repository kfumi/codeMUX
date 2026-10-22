import { describe, expect, it } from 'vitest';

import { formatAdditionalDirectoriesPrompt } from './additionalDirectories.js';

describe('formatAdditionalDirectoriesPrompt', () => {
  it('omits the section when there are no additional directories', () => {
    expect(formatAdditionalDirectoriesPrompt(undefined)).toBe('');
    expect(formatAdditionalDirectoriesPrompt([])).toBe('');
    expect(formatAdditionalDirectoriesPrompt(['  '])).toBe('');
  });

  it('lists absolute paths and asks for absolute path use', () => {
    expect(formatAdditionalDirectoriesPrompt(['D:/work/backend', 'D:/work/shared'])).toBe(
      [
        'Additional directories (outside the working directory):',
        '  - D:/work/backend',
        '  - D:/work/shared',
        'Use absolute paths when reading or editing files in these directories.',
      ].join('\n'),
    );
  });

  it('never repeats the working directory or an environment heading', () => {
    const prompt = formatAdditionalDirectoriesPrompt(['D:/work/backend']);
    expect(prompt).not.toContain('# Environment');
    expect(prompt).not.toContain('working directory: D:/work');
  });
});
