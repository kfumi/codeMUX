import {
  extractLinkableFileReferences,
  normalizeLocalMarkdownHref,
} from '@/components/assistant-ui/markdown-link';

function stripLocalFileLineSuffix(value: string): string {
  return value.replace(/(?::\d+(?::\d+)?(?:-\d+(?:\.\d+)?)?|#L?\d+(?:-L?\d+)?|\s+\(line\s+\d+\)|\s+\(\d+(?:,\s*\d+)?\)|\s+on\s+line\s+\d+)$/i, '');
}

function normalizePathForCompare(value: string): string {
  return value.replace(/^\/([A-Za-z]:[\\/])/, '$1').replace(/\\/g, '/').toLowerCase();
}

function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(stripLocalFileLineSuffix(path));
}

export function extractReferencedMarkdownFiles(text: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  const addPath = (rawPath: string) => {
    const path = stripLocalFileLineSuffix(rawPath.trim());
    if (!path || !isMarkdownPath(path)) {
      return;
    }

    const key = normalizePathForCompare(path);
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    results.push(path);
  };

  for (const reference of extractLinkableFileReferences(text)) {
    addPath(reference.path);
  }

  for (const match of text.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
    const href = match[2]?.trim();
    if (!href) {
      continue;
    }

    const normalized = normalizeLocalMarkdownHref(href);
    if (normalized) {
      addPath(normalized);
    }
  }

  return results;
}
