import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface AgentInputImage {
  name: string;
  mediaType: string;
  dataUrl: string;
  size?: number;
}

export interface AgentInputPayload {
  text: string;
  images?: AgentInputImage[];
}

type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

type CodexInputEntry =
  | { type: 'text'; text: string }
  | { type: 'local_image'; path: string };

export function normalizeAgentInputPayload(prompt: string, payload?: AgentInputPayload): AgentInputPayload {
  return {
    text: payload?.text ?? prompt,
    images: Array.isArray(payload?.images) ? payload.images : [],
  };
}

export function buildClaudeUserMessageContent(payload: AgentInputPayload, includeImages = true): ClaudeContentBlock[] {
  const content: ClaudeContentBlock[] = [];
  const text = payload.text.trim();
  if (text) {
    content.push({ type: 'text', text });
  }

  if (includeImages) {
    for (const image of payload.images ?? []) {
      const parsed = parseImageDataUrl(image.dataUrl, image.mediaType);
      if (!parsed) continue;
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: parsed.mediaType,
          data: parsed.base64,
        },
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: payload.text });
  }

  return content;
}

export function buildCodexInputEntries(payload: AgentInputPayload, imagePaths: string[], includeImages = true): CodexInputEntry[] {
  const entries: CodexInputEntry[] = [];
  const text = payload.text.trim();
  if (text) {
    entries.push({ type: 'text', text });
  }

  if (includeImages) {
    for (const imagePath of imagePaths) {
      entries.push({ type: 'local_image', path: imagePath });
    }
  }

  if (entries.length === 0) {
    entries.push({ type: 'text', text: payload.text });
  }

  return entries;
}

export async function writePayloadImagesToTempFiles(payload: AgentInputPayload): Promise<string[]> {
  const images = payload.images ?? [];
  if (images.length === 0) return [];

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codemux-images-'));
  const paths: string[] = [];
  for (const image of images) {
    const parsed = parseImageDataUrl(image.dataUrl, image.mediaType);
    if (!parsed) continue;
    const ext = extensionForMediaType(parsed.mediaType);
    const filePath = path.join(dir, `${randomUUID()}-${sanitizeFileName(image.name || 'image')}${ext}`);
    await fs.writeFile(filePath, Buffer.from(parsed.base64, 'base64'));
    paths.push(filePath);
  }
  return paths;
}

export async function cleanupTempImageFiles(imagePaths: string[]): Promise<void> {
  const dirs = new Set<string>();
  await Promise.all(imagePaths.map(async (imagePath) => {
    dirs.add(path.dirname(imagePath));
    await fs.unlink(imagePath).catch(() => {});
  }));
  await Promise.all(Array.from(dirs).map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
}

export function isImageUnsupportedError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes('image') &&
    (
      message.includes('not support') ||
      message.includes('unsupported') ||
      message.includes('invalid content') ||
      message.includes('content type') ||
      message.includes('multimodal') ||
      message.includes('vision')
    )
  );
}

function parseImageDataUrl(dataUrl: string, fallbackMediaType: string): { mediaType: string; base64: string } | null {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mediaType: match[1] || fallbackMediaType || 'image/png',
    base64: match[2] || '',
  };
}

function extensionForMediaType(mediaType: string): string {
  switch (mediaType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'image/png':
    default:
      return '.png';
  }
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/\.+$/g, '').slice(0, 80);
  return cleaned || 'image';
}
