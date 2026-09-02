export function splitDiffLines(value: string): string[] {
  return value.split('\n').filter((_line, index, lines) =>
    index < lines.length - 1 || lines[lines.length - 1] !== '',
  );
}

export function countDiffLines(oldContent: string, newContent: string): { additions: number; deletions: number } {
  const oldLines = splitDiffLines(oldContent);
  const newLines = splitDiffLines(newContent);

  const m = oldLines.length;
  const n = newLines.length;
  const lengths = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        lengths[i][j] = lengths[i - 1][j - 1] + 1;
      } else {
        lengths[i][j] = Math.max(lengths[i - 1][j], lengths[i][j - 1]);
      }
    }
  }

  let additions = 0;
  let deletions = 0;
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lengths[i][j - 1] >= lengths[i - 1][j])) {
      additions++;
      j--;
    } else {
      deletions++;
      i--;
    }
  }

  return { additions, deletions };
}
