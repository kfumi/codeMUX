export const BLANK_PAGE_TITLE = '新标签页';

export function createBrowserId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `b-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function browserPageTitle(title: string, url: string): string {
  const trimmed = title.trim();
  if (trimmed) return trimmed;
  try {
    const host = new URL(url).hostname;
    if (host) return host;
  } catch {
    // ignore invalid url
  }
  return BLANK_PAGE_TITLE;
}
