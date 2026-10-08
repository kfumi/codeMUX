/** 浏览器工具结果里的截图提取与同消息步骤上下文（02 票轨迹回放）。 */

export interface BrowserShotExtraction {
  shots: string[];
  text: string | undefined;
}

export interface BrowserStepPart {
  toolName: string;
  result: unknown;
}

export interface BrowserStepInfo {
  step?: number;
  beforeShot?: string;
  afterShot?: string;
}

const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'browser_list',
  'browser_eval',
  'browser_screenshot',
  'browser_input',
  'browser_cdp',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_select',
]);

export function isBrowserToolName(toolName: string): boolean {
  return BROWSER_TOOL_NAMES.has(toolName);
}

const MIN_IMAGE_DATA_LENGTH = 1000;
const BASE64_PATTERN = /^[A-Za-z0-9+/=\s]+$/;
const LONG_BASE64_RUN_PATTERN = /[A-Za-z0-9+/=]{500,}/g;
const MAX_SHOTS = 4;
const BARE_IMAGE_MAGIC_PREFIXES = ['iVBOR', '/9j/', 'R0lG', 'UklGR'];

function isPlausibleImageData(value: unknown): value is string {
  return typeof value === 'string' && value.length >= MIN_IMAGE_DATA_LENGTH && BASE64_PATTERN.test(value);
}

function toDataUrl(data: string, mimeType?: string): string {
  const mime = typeof mimeType === 'string' && mimeType.startsWith('image/') ? mimeType : 'image/png';
  return 'data:' + mime + ';base64,' + data;
}

function collectShots(value: unknown, shots: string[]): void {
  if (shots.length >= MAX_SHOTS || typeof value !== 'object' || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectShots(item, shots);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.type === 'image' && typeof record.data === 'string') {
    if (isPlausibleImageData(record.data)) {
      shots.push(toDataUrl(record.data, typeof record.mimeType === 'string' ? record.mimeType : undefined));
    }
    return;
  }
  if (typeof record.screenshot === 'string' && record.screenshot.length > 0) {
    shots.push(toDataUrl(record.screenshot, 'image/png'));
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === 'screenshot') {
      continue;
    }
    collectShots(child, shots);
  }
}
function redactLongBase64Runs(text: string): string {
  return text.replace(LONG_BASE64_RUN_PATTERN, '[图片已折叠]');
}

function parseResultValue(result: unknown): unknown {
  if (typeof result !== 'string') {
    return result ?? undefined;
  }
  const trimmed = result.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return result;
    }
  }
  return result;
}
function textBlocksOf(value: unknown): string[] {
  if (!value || typeof value !== 'object') {
    return [];
  }
  const blocks = (value as { content?: unknown }).content;
  if (!Array.isArray(blocks)) {
    return [];
  }
  const texts: string[] = [];
  for (const block of blocks) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      texts.push((block as { text: string }).text);
    }
  }
  return texts;
}

export function extractBrowserShots(result: unknown): BrowserShotExtraction {
  if (result === undefined || result === null) {
    return { shots: [], text: undefined };
  }
  if (typeof result === 'string') {
    const trimmed = result.trim();
    if (trimmed.length === 0) {
      return { shots: [], text: undefined };
    }
    const parsed = parseResultValue(result);
    if (typeof parsed === 'string') {
      if (isPlausibleImageData(parsed) && BARE_IMAGE_MAGIC_PREFIXES.some((prefix) => parsed.startsWith(prefix))) {
        return { shots: [toDataUrl(parsed, 'image/png')], text: redactLongBase64Runs(parsed) };
      }
      return { shots: [], text: redactLongBase64Runs(parsed) };
    }
    return extractFromValue(parsed);
  }
  return extractFromValue(result);
}

function extractFromValue(value: unknown): BrowserShotExtraction {
  if (value === undefined || value === null) {
    return { shots: [], text: undefined };
  }
  const shots: string[] = [];
  collectShots(value, shots);
  const texts = textBlocksOf(value);
  if (texts.length > 0) {
    return { shots, text: texts.join('\n') };
  }
  if (typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).screenshot === 'string') {
    const { screenshot: _dropped, ...rest } = value as Record<string, unknown>;
    return { shots, text: JSON.stringify(rest) };
  }
  return { shots, text: redactLongBase64Runs(JSON.stringify(value)) };
}
export function computeBrowserStepContext(parts: BrowserStepPart[]): BrowserStepInfo[] {
  const firstShots = parts.map((part) =>
    (isBrowserToolName(part.toolName) ? extractBrowserShots(part.result).shots[0] : undefined),
  );
  let step = 0;
  return parts.map((part, index) => {
    if (!isBrowserToolName(part.toolName)) {
      return {};
    }
    step += 1;
    const info: BrowserStepInfo = { step };
    for (let j = index - 1; j >= 0; j -= 1) {
      if (firstShots[j] !== undefined) {
        info.beforeShot = firstShots[j];
        break;
      }
    }
    for (let j = index + 1; j < parts.length; j += 1) {
      if (firstShots[j] !== undefined) {
        info.afterShot = firstShots[j];
        break;
      }
    }
    return info;
  });
}
