export type ProposedPlanParseResult = {
  beforeText: string;
  planMarkdown: string;
  afterText: string;
};

const PROPOSED_PLAN_RE = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/;

export function parseProposedPlan(text: string): ProposedPlanParseResult | null {
  const match = text.match(PROPOSED_PLAN_RE);
  if (!match || match.index == null) {
    return null;
  }

  return {
    beforeText: text.slice(0, match.index).trim(),
    planMarkdown: (match[1] ?? '').trim(),
    afterText: text.slice(match.index + match[0].length).trim(),
  };
}

export function getProposedPlanTitle(planMarkdown: string): string {
  const heading = planMarkdown
    .split(/\r?\n/)
    .map((line) => line.match(/^#\s+(.+?)\s*$/)?.[1]?.trim())
    .find((value): value is string => Boolean(value));

  return heading || '计划';
}

export function getProposedPlanSummary(planMarkdown: string): string {
  const lines = planMarkdown.split(/\r?\n/);
  const summaryStart = lines.findIndex((line) => /^#{1,6}\s+summary\s*$/i.test(line.trim()) || /^summary\s*$/i.test(line.trim()));

  if (summaryStart >= 0) {
    const summaryLines: string[] = [];
    for (const line of lines.slice(summaryStart + 1)) {
      if (/^#{1,6}\s+\S/.test(line.trim())) {
        break;
      }
      summaryLines.push(line);
    }

    const summary = summaryLines.join('\n').trim();
    if (summary) {
      return summary;
    }
  }

  return lines
    .filter((line) => !/^#{1,6}\s+/.test(line.trim()))
    .join('\n')
    .trim();
}

export function getProposedPlanPreview(planMarkdown: string): string {
  const lines = planMarkdown.split(/\r?\n/);
  const sectionStart = lines.findIndex((line) => /^##\s+\S/.test(line.trim()));

  if (sectionStart >= 0) {
    const sectionLines: string[] = [lines[sectionStart].trim()];

    for (const line of lines.slice(sectionStart + 1)) {
      if (/^#{1,2}\s+\S/.test(line.trim())) {
        break;
      }
      sectionLines.push(line);
    }

    return trimBlankLines(sectionLines).join('\n').trim();
  }

  const summary = getProposedPlanSummary(planMarkdown);
  if (summary) {
    return summary;
  }

  return trimBlankLines(lines.filter((line) => !/^#\s+\S/.test(line.trim()))).join('\n').trim();
}

export function hasProposedPlan(text: string): boolean {
  return parseProposedPlan(text) !== null;
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start].trim().length === 0) {
    start += 1;
  }
  while (end > start && lines[end - 1].trim().length === 0) {
    end -= 1;
  }

  return lines.slice(start, end);
}
