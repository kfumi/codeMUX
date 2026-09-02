export const BROWSER_ELEMENT_TEXT_LIMIT = 500;

export interface BrowserElementCapture {
  url: string;
  tag: string;
  text: string;
  selector?: string;
  width?: number;
  height?: number;
  color?: string;
  font?: string;
}

export function truncateBrowserElementText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= BROWSER_ELEMENT_TEXT_LIMIT
    ? normalized
    : normalized.slice(0, BROWSER_ELEMENT_TEXT_LIMIT);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatBrowserElementBlock(element: BrowserElementCapture): string {
  const tag = escapeXml(element.tag.trim() || 'unknown');
  const text = escapeXml(truncateBrowserElementText(element.text));
  const selector = element.selector?.trim() ?? '';
  const lines = [
    `<browser-element url="${escapeXml(element.url)}">`,
    `  <tag>${tag}</tag>`,
    `  <text>${text}</text>`,
  ];
  if (selector) {
    lines.push(`  <selector>${escapeXml(selector)}</selector>`);
  }
  lines.push('</browser-element>');
  return lines.join('\n');
}

export function formatBrowserElements(elements: BrowserElementCapture[]): string {
  return elements.map(formatBrowserElementBlock).join('\n\n');
}

export function mergeBrowserElementsIntoText(text: string, elements: BrowserElementCapture[]): string {
  if (elements.length === 0) {
    return text;
  }
  const block = formatBrowserElements(elements);
  const trimmed = text.trim();
  return trimmed.length === 0 ? block : `${text.trimEnd()}\n\n${block}`;
}
