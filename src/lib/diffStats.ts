import { diffLines, type Change } from 'diff';

export function splitDiffLines(value: string): string[] {
  return value.split('\n').filter((_line, index, lines) =>
    index < lines.length - 1 || lines[lines.length - 1] !== ''
  );
}

/**
 * Parse a unified diff patch into old and new file content.
 * Returns null if the patch contains no diffable hunks.
 */
export function parseUnifiedDiffPatch(patch: string): { oldContent: string; newContent: string } | null {
  const lines = patch.split('\n');
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let inHunk = false;
  let hasContent = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Hunk header: @@ -start,count +start,count @@
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }

    // File headers and metadata — skip but note when we pass +++
    if (line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') ||
        line.startsWith('new file') || line.startsWith('deleted file') ||
        line.startsWith('old mode') || line.startsWith('new mode') ||
        line.startsWith('similarity ') || line.startsWith('rename ') || line.startsWith('copy ')) {
      continue;
    }
    if (line.startsWith('+++')) {
      // After +++ header, treat subsequent +/-/space lines as hunk content
      inHunk = true;
      continue;
    }

    if (!inHunk) {
      // Skip anything before hunk headers
      continue;
    }

    // No newline marker
    if (line.startsWith('\\')) {
      continue;
    }

    if (line.startsWith('-')) {
      // Removed line
      oldLines.push(line.slice(1));
      hasContent = true;
    } else if (line.startsWith('+')) {
      // Added line
      newLines.push(line.slice(1));
      hasContent = true;
    } else if (line.startsWith(' ')) {
      // Context line
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
      hasContent = true;
    } else if (line === '') {
      // Empty lines within a hunk are context lines
      oldLines.push('');
      newLines.push('');
      hasContent = true;
    }
  }

  if (!hasContent) return null;

  return {
    oldContent: oldLines.join('\n'),
    newContent: newLines.join('\n'),
  };
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
