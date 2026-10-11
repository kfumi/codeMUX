export type ToolResultImage = {
  src: string;
  name?: string;
};

export type ToolResultMedia = {
  images: ToolResultImage[];
  text?: string;
};

const MAX_RESULT_IMAGES = 8;

/** Extract inline image blocks and their sibling text from an agent tool result. */
export function extractToolResultMedia(result: unknown): ToolResultMedia {
  const images: ToolResultImage[] = [];
  const textParts: string[] = [];
  const seenValues = new Set<object>();
  const seenImages = new Set<string>();

  const visit = (value: unknown): void => {
    const parsed = parseEmbeddedJson(value);
    if (parsed !== value) {
      visit(parsed);
      return;
    }

    if (typeof value === 'string') {
      const directImage = normalizeImageSource(value, undefined);
      if (directImage) addImage({ src: directImage });
      return;
    }

    if (Array.isArray(value)) {
      if (seenValues.has(value)) return;
      seenValues.add(value);
      for (const entry of value) visit(entry);
      return;
    }

    if (!isRecord(value) || seenValues.has(value)) return;
    seenValues.add(value);

    const image = imageFromRecord(value);
    if (image) {
      addImage(image);
      return;
    }

    if (value.type === 'text' && typeof value.text === 'string' && value.text.trim().length > 0) {
      textParts.push(value.text);
      return;
    }

    if (Array.isArray(value.content)) {
      visit(value.content);
      return;
    }

    if (value.content !== undefined) {
      visit(value.content);
      return;
    }

    // MCP / SDK adapters may wrap the actual output one level below these keys.
    for (const key of ['result', 'output', 'images']) {
      if (value[key] !== undefined) visit(value[key]);
    }
  };

  const addImage = (image: ToolResultImage) => {
    if (images.length >= MAX_RESULT_IMAGES || seenImages.has(image.src)) return;
    seenImages.add(image.src);
    images.push(image);
  };

  visit(result);

  return {
    images,
    ...(textParts.length > 0 ? { text: textParts.join('\n') } : {}),
  };
}

function imageFromRecord(record: Record<string, unknown>): ToolResultImage | undefined {
  const source = isRecord(record.source) ? record.source : undefined;
  const imageUrl = isRecord(record.image_url) ? record.image_url.url : record.image_url;
  const candidates = [
    record.dataUrl,
    record.data_url,
    record.src,
    record.url,
    imageUrl,
    record.image,
    record.data,
    record.base64,
    source?.url,
    source?.dataUrl,
    source?.data_url,
    source?.image,
    source?.data,
    source?.base64,
  ];
  const mimeType = firstString(
    record.mimeType,
    record.mime_type,
    record.media_type,
    record.mime,
    source?.mimeType,
    source?.mime_type,
    source?.media_type,
    source?.mime,
  );
  const name = firstString(record.filename, record.name, record.alt, source?.filename, source?.name);

  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    const src = normalizeImageSource(candidate, mimeType);
    if (src) return { src, ...(name ? { name } : {}) };
  }

  return undefined;
}

function normalizeImageSource(value: string, mimeType: string | undefined): string | undefined {
  const trimmed = value.trim();
  const dataUrlMatch = trimmed.match(/^data:(image\/[a-z0-9.+-]+);(?:base64,|,)/i);
  if (dataUrlMatch) return trimmed;

  const normalizedMime = mimeType?.trim().toLowerCase();
  if (!normalizedMime || !/^image\/[a-z0-9.+-]+$/.test(normalizedMime)) return undefined;

  const base64 = trimmed.replace(/\s+/g, '');
  if (base64.length === 0 || !/^[a-z0-9+/=_-]+$/i.test(base64)) return undefined;
  return `data:${normalizedMime};base64,${base64}`;
}

function parseEmbeddedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
