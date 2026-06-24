import { diffLines, type Change } from 'diff';

export function splitDiffLines(value: string): string[] {
  return value.split('\n').filter((_line, index, lines) =>
    index < lines.length - 1 || lines[lines.length - 1] !== ''
  );
}

export function countDiffLines(oldContent: string, newContent: string): { additions: number; deletions: number } {
  const changes = diffLines(oldContent, newContent);
  return countDiffChanges(changes);
}

export function countDiffChanges(changes: Change[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const change of changes) {
    const lineCount = splitDiffLines(change.value).length;
    if (change.added) additions += lineCount;
    if (change.removed) deletions += lineCount;
  }
  return { additions, deletions };
}
