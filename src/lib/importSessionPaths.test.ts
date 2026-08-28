import { describe, expect, it } from 'vitest';

import { isImportCandidateForProject } from './importSessionPaths';

describe('isImportCandidateForProject', () => {
  it('matches exact project cwd', () => {
    expect(isImportCandidateForProject('D:/project/codeMUX', 'D:/project/codeMUX')).toBe(true);
    expect(isImportCandidateForProject('D:\\project\\codeMUX', 'D:/project/codeMUX')).toBe(true);
  });

  it('matches cwd inside the project tree', () => {
    expect(isImportCandidateForProject('D:/project/codeMUX/.worktrees/feat', 'D:/project/codeMUX')).toBe(true);
  });

  it('rejects cwd outside the project', () => {
    expect(isImportCandidateForProject('D:/other/app', 'D:/project/codeMUX')).toBe(false);
    expect(isImportCandidateForProject('D:/project/codeMUX-other', 'D:/project/codeMUX')).toBe(false);
  });

  it('rejects missing cwd', () => {
    expect(isImportCandidateForProject(null, 'D:/project/codeMUX')).toBe(false);
    expect(isImportCandidateForProject('', 'D:/project/codeMUX')).toBe(false);
  });
});
