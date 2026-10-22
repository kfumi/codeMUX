import { describe, expect, it } from 'vitest';

import { isImportCandidateForProject } from './importSessionPaths';

const ROOTS = ['D:/project/codeMUX', 'D:/project/backend'];

describe('isImportCandidateForProject', () => {
  it('matches exact project cwd', () => {
    expect(isImportCandidateForProject('D:/project/codeMUX', ROOTS)).toBe(true);
    expect(isImportCandidateForProject('D:\\project\\codeMUX', ROOTS)).toBe(true);
  });

  it('matches cwd inside the project tree', () => {
    expect(isImportCandidateForProject('D:/project/codeMUX/.worktrees/feat', ROOTS)).toBe(true);
  });

  it('matches any of the project roots', () => {
    expect(isImportCandidateForProject('D:/project/backend', ROOTS)).toBe(true);
    expect(isImportCandidateForProject('D:/project/backend/src/api', ROOTS)).toBe(true);
  });

  it('respects path segment boundaries', () => {
    expect(isImportCandidateForProject('D:/other/app', ROOTS)).toBe(false);
    expect(isImportCandidateForProject('D:/project/codeMUX-other', ROOTS)).toBe(false);
    expect(isImportCandidateForProject('D:/project/backend-old', ROOTS)).toBe(false);
  });

  it('is case-insensitive for Windows paths', () => {
    expect(isImportCandidateForProject('d:/PROJECT/codemux/src', ROOTS)).toBe(true);
  });

  it('rejects missing cwd or an empty root set', () => {
    expect(isImportCandidateForProject(null, ROOTS)).toBe(false);
    expect(isImportCandidateForProject('', ROOTS)).toBe(false);
    expect(isImportCandidateForProject('D:/project/codeMUX', [])).toBe(false);
    expect(isImportCandidateForProject('D:/project/codeMUX', [''])).toBe(false);
  });
});
