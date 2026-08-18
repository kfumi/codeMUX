import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { open } from '@tauri-apps/plugin-shell';
import { defaultRehypePlugins } from 'streamdown';

import { cn } from '@/lib/utils';
import { fileApi } from '@/lib/tauri';
import { useProjectStore } from '@/stores/projectStore';
import { usePreviewStore, type FileTreeNodeData } from '@/stores/previewStore';
import { useSidePanelStore } from '@/stores/sidePanelStore';
import { TooltipHint } from '@/components/ui/tooltip';
import { FileTypeIcon } from './file-type-icon';

const LOCAL_FILE_LINK_ORIGIN = 'https://codemux.local-file';

export const CODEMUX_MARKDOWN_REHYPE_PLUGINS = [
  codemuxLocalFileLinkRehypePlugin,
  ...Object.values(defaultRehypePlugins),
];

type CodeMuxMarkdownLinkProps = AnchorHTMLAttributes<HTMLAnchorElement>;

export function CodeMuxMarkdownLink({
  className,
  href,
  children,
  ...props
}: CodeMuxMarkdownLinkProps) {
  const openPlanTab = useSidePanelStore((state) => state.openPlanTab);
  const fileLink = getLocalFileLinkDetails(href, children);
  const filePath = fileLink?.path ?? null;

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (!href) {
      return;
    }

    if (!filePath) {
      void open(href);
      return;
    }

    const basePath = resolveLocalMarkdownBasePath(filePath);
    void fileApi
      .readFile(filePath, basePath)
      .then((content) => {
        openPlanTab(filePath, content);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        openPlanTab(filePath, `无法读取文件：${message}`);
      });
  };

  const link = (
    <a
      {...props}
      href={href}
      className={cn(
        'aui-md-a inline-flex items-center gap-1 cursor-pointer text-primary no-underline hover:text-primary/80',
        className,
      )}
      style={{
        ...props.style,
        ...(fileLink ? { color: 'hsl(var(--codemux-link))' } : {}),
      }}
      onClick={handleClick}
    >
      {fileLink ? <FileTypeIcon filePath={fileLink.path} /> : null}
      {fileLink?.label ?? children}
    </a>
  );

  return fileLink ? <TooltipHint content={fileLink.tooltipPath}>{link}</TooltipHint> : link;
}

export function normalizeLocalMarkdownHref(href?: string): string | null {
  if (!href || href.startsWith('#')) {
    return null;
  }

  if (href.startsWith(`${LOCAL_FILE_LINK_ORIGIN}/?path=`)) {
    return stripLocalFileLineSuffix(decodeURIComponent(href.slice(`${LOCAL_FILE_LINK_ORIGIN}/?path=`.length)));
  }

  if (href.startsWith('file://')) {
    const withoutScheme = href.slice('file://'.length);
    return stripLocalFileLineSuffix(normalizeWindowsDrivePrefix(decodeURIComponent(withoutScheme)));
  }

  const decoded = safeDecodeURIComponent(href);
  if (isWindowsAbsolutePath(decoded) || decoded.startsWith('/')) {
    return stripLocalFileLineSuffix(normalizeWindowsDrivePrefix(decoded));
  }

  if (!/^[a-z][a-z\d+.-]*:/i.test(decoded)) {
    return stripLocalFileLineSuffix(decoded);
  }

  return null;
}

export function encodeLocalMarkdownHrefForSanitize(href: string): string {
  return `${LOCAL_FILE_LINK_ORIGIN}/?path=${encodeURIComponent(href)}`;
}

type LocalFileLinkDetails = {
  path: string;
  label: string;
  tooltipPath: string;
};

function getLocalFileLinkDetails(href: string | undefined, children: ReactNode): LocalFileLinkDetails | null {
  const path = normalizeLocalMarkdownHref(href);
  if (!path) {
    return null;
  }

  const rawPath = getRawLocalMarkdownPath(href) ?? path;
  const location = getFileLinkLocation(rawPath) ?? getFileLinkLocation(getReactText(children));
  const lineSuffix = location?.canonicalSuffix ?? '';
  const basePath = resolveLocalMarkdownBasePath(path);
  const tooltipPath = isAbsoluteLocalPath(path)
    ? `${path}${lineSuffix}`
    : `${basePath ? `${basePath.replace(/[\\/]+$/, '')}/` : ''}${path.replace(/^[/\\]+/, '')}${lineSuffix}`;

  return {
    path,
    label: `${getFileName(path)}${lineSuffix}`,
    tooltipPath,
  };
}

function getRawLocalMarkdownPath(href?: string): string | null {
  if (!href) {
    return null;
  }

  if (href.startsWith(`${LOCAL_FILE_LINK_ORIGIN}/?path=`)) {
    return safeDecodeURIComponent(href.slice(`${LOCAL_FILE_LINK_ORIGIN}/?path=`.length));
  }

  if (href.startsWith('file://')) {
    return normalizeWindowsDrivePrefix(safeDecodeURIComponent(href.slice('file://'.length)));
  }

  return safeDecodeURIComponent(href);
}

type FileLinkLocation = {
  line: number;
  column?: number;
  suffix: string;
  canonicalSuffix: string;
};

function getFileLinkLocation(value: string): FileLinkLocation | null {
  const match = /(?::(\d+)(?::(\d+))?(?:-(\d+)(?:\.(\d+))?)?|#L?(\d+)(?:-L?(\d+))?|\(line\s+(\d+)\)|\((\d+)(?:,\s*(\d+))?\)|\s+on\s+line\s+(\d+))$/i.exec(value.trim());
  if (!match) {
    return null;
  }

  const line = Number(match[1] ?? match[5] ?? match[7] ?? match[8] ?? match[10]);
  const column = match[2] ? Number(match[2]) : match[9] ? Number(match[9]) : undefined;
  const endLine = match[3] ? Number(match[3]) : match[6] ? Number(match[6]) : undefined;
  const endColumn = match[4] ? Number(match[4]) : undefined;
  if (!Number.isFinite(line)) {
    return null;
  }

  const canonicalSuffix = `:${line}`
    + (column != null ? `:${column}` : '')
    + (endLine != null ? `-${endLine}${endColumn != null ? `.${endColumn}` : ''}` : '');

  return {
    line,
    ...(column != null ? { column } : {}),
    suffix: match[0],
    canonicalSuffix,
  };
}

function getFileName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').pop() || path;
}

function getReactText(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(getReactText).join('');
  }

  return '';
}

export function codemuxLocalFileLinkRehypePlugin() {
  return (tree: unknown) => {
    rewriteLocalFileLinks(tree);
    rewritePlainFilePaths(tree);
  };
}

export function resolveLocalMarkdownBasePath(filePath: string): string | undefined {
  const { projects, activeProjectId } = useProjectStore.getState();
  const normalizedFilePath = normalizePathForCompare(filePath);
  const matchingProject = projects
    .filter((project) => {
      const normalizedProjectPath = normalizePathForCompare(project.path).replace(/\/$/, '');
      return normalizedFilePath === normalizedProjectPath || normalizedFilePath.startsWith(`${normalizedProjectPath}/`);
    })
    .sort((left, right) => right.path.length - left.path.length)[0];

  if (matchingProject) {
    return matchingProject.path;
  }

  if (!isAbsoluteLocalPath(filePath)) {
    return projects.find((project) => project.id === activeProjectId)?.path;
  }

  return undefined;
}

function rewriteLocalFileLinks(node: unknown): void {
  if (!isRecord(node)) {
    return;
  }

  if (node.type === 'element' && node.tagName === 'a' && isRecord(node.properties)) {
    const href = node.properties.href;
    if (typeof href === 'string' && normalizeLocalMarkdownHref(href)) {
      node.properties.href = encodeLocalMarkdownHrefForSanitize(href);
    }
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      rewriteLocalFileLinks(child);
    }
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeWindowsDrivePrefix(value: string): string {
  return value.replace(/^\/([A-Za-z]:[\\/])/, '$1');
}

function stripLocalFileLineSuffix(value: string): string {
  const location = getFileLinkLocation(value);
  return location ? value.slice(0, -location.suffix.length) : value;
}

export type PlainFileReference = {
  start: number;
  end: number;
  label: string;
  path: string;
};

const PLAIN_FILE_REFERENCE_RE =
  /(?:[A-Za-z]:[\\/][^\s<>"'`!&*()\[\]{}|，。；：！？、:;]+|\/[^\s<>"'`!&*()\[\]{}|，。；！？、:;]+|(?:\.{1,2}[\\/])?[A-Za-z0-9._~-]+(?:[\\/][A-Za-z0-9._~-]+)+|[A-Za-z0-9._~-]+\.[A-Za-z][A-Za-z0-9_-]*)/g;

const FILE_REFERENCE_SUFFIX_RE =
  /^(?::\d+(?::\d+)?(?:-\d+(?:\.\d+)?)?|#L?\d+(?:-L?\d+)?|\s+\(line\s+\d+\)|\s+\(\d+(?:,\s*\d+)?\)|\s+on\s+line\s+\d+)/i;

export function parsePlainFileReferences(text: string): PlainFileReference[] {
  const references: PlainFileReference[] = [];

  for (const match of text.matchAll(PLAIN_FILE_REFERENCE_RE)) {
    const start = match.index ?? 0;
    const suffix = FILE_REFERENCE_SUFFIX_RE.exec(text.slice(start + match[0].length))?.[0] ?? '';
    const raw = `${match[0]}${suffix}`;
    const parsed = parsePlainFileReference(raw, text, start);
    if (!parsed || !isAbsoluteLocalPath(stripLocalFileLineSuffix(parsed.path))) {
      continue;
    }

    references.push({
      start,
      end: start + parsed.label.length,
      label: parsed.label,
      path: parsed.path,
    });
  }

  return references;
}

function parsePlainFileReference(
  raw: string,
  source: string,
  start: number,
): { label: string; path: string } | null {
  const location = splitFileReferenceLocation(raw);
  const pathCandidate = trimFileReferencePunctuation(location.path);
  const previousText = source.slice(Math.max(0, start - 3), start);

  if (
    !pathCandidate
    || previousText.endsWith('://')
    || /^[a-z][a-z\d+.-]*:\/\//i.test(pathCandidate)
    || !isLikelyLocalFilePath(pathCandidate)
  ) {
    return null;
  }

  if (location.line != null) {
    return {
      label: trimFileReferencePunctuation(raw),
      path: `${pathCandidate}${location.canonicalSuffix ?? `:${location.line}`}`,
    };
  }

  return {
    label: trimFileReferencePunctuation(raw),
    path: pathCandidate,
  };
}

function splitFileReferenceLocation(value: string): {
  path: string;
  line?: number;
  column?: number;
  canonicalSuffix?: string;
} {
  const location = getFileLinkLocation(value);
  if (!location) {
    return { path: value };
  }

  return {
    path: value.slice(0, -location.suffix.length),
    line: location.line,
    ...(location.column != null ? { column: location.column } : {}),
    canonicalSuffix: location.canonicalSuffix,
  };
}

function trimFileReferencePunctuation(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/[.,:;!?，。；：！？、]+$/, '').replace(/[)\]}]+$/, (suffix) => {
    const openingCount = (trimmed.match(/[(\[]/g) ?? []).length;
    const closingCount = (trimmed.match(/[)\]]/g) ?? []).length;
    return closingCount > openingCount ? suffix.slice(0, -1) : suffix;
  });
}

function isLikelyLocalFilePath(value: string): boolean {
  const pathWithoutLine = stripLocalFileLineSuffix(value);
  if (isAbsoluteLocalPath(pathWithoutLine) || pathWithoutLine.startsWith('./') || pathWithoutLine.startsWith('../')) {
    return looksLikeFileName(pathWithoutLine);
  }

  const normalized = pathWithoutLine.replace(/\\/g, '/');
  if (normalized.includes('/') && normalized.split('/').some((part) => part.length > 0)) {
    return looksLikeFileName(normalized);
  }

  return looksLikeFileName(normalized);
}

function looksLikeFileName(value: string): boolean {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  const basename = normalized.split('/').pop() ?? normalized;
  if (/^(?:Dockerfile|Makefile|README(?:\.[A-Za-z0-9_-]+)?)$/i.test(basename)) {
    return true;
  }

  const extension = /\.([A-Za-z0-9_-]+)$/.exec(basename)?.[1];
  return Boolean(extension && !/^\d+$/.test(extension));
}

function shouldLinkPlainFileReference(reference: PlainFileReference): boolean {
  const path = stripLocalFileLineSuffix(reference.path);
  if (!isAbsoluteLocalPath(path) || !isLikelyLocalFilePath(path)) {
    return false;
  }

  const hasFileTree = usePreviewStore.getState().treeRoot !== null;
  return hasFileTree ? isKnownProjectFilePath(path) : isPathInsideRegisteredProject(path);
}

function isPathInsideRegisteredProject(filePath: string): boolean {
  const normalizedFilePath = normalizePathForCompare(filePath).replace(/\/+$/, '');
  return useProjectStore.getState().projects.some((project) => {
    const normalizedProjectPath = normalizePathForCompare(project.path).replace(/\/+$/, '');
    return normalizedFilePath === normalizedProjectPath || normalizedFilePath.startsWith(`${normalizedProjectPath}/`);
  });
}

function isKnownProjectFilePath(filePath: string): boolean {
  const treeRoot = usePreviewStore.getState().treeRoot;
  if (!treeRoot) {
    return false;
  }

  const normalizedCandidate = normalizePathForCompare(filePath).replace(/\/+$/, '');
  return flattenFileTreePaths(treeRoot).some((path) => {
    const normalizedPath = normalizePathForCompare(path).replace(/\/+$/, '');
    return normalizedPath === normalizedCandidate || normalizedPath.endsWith(`/${normalizedCandidate}`);
  });
}

function flattenFileTreePaths(nodes: FileTreeNodeData[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.isDir ? [] : [node.path]),
    ...(node.children ? flattenFileTreePaths(node.children) : []),
  ]);
}

function rewritePlainFilePaths(node: unknown): void {
  if (!isRecord(node) || !Array.isArray(node.children)) {
    return;
  }

  if (node.tagName === 'a' || node.tagName === 'pre') {
    return;
  }

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    if (child.type === 'text' && typeof child.value === 'string') {
      const references = parsePlainFileReferences(child.value).filter(shouldLinkPlainFileReference);
      if (references.length === 0) {
        continue;
      }

      const replacement: MarkdownNode[] = [];
      let cursor = 0;
      for (const reference of references) {
        if (reference.start > cursor) {
          replacement.push({ type: 'text', value: child.value.slice(cursor, reference.start) });
        }
        replacement.push({
          type: 'element',
          tagName: 'a',
          properties: {
            href: encodeLocalMarkdownHrefForSanitize(reference.path),
          },
          children: [{ type: 'text', value: reference.label }],
        });
        cursor = reference.end;
      }
      if (cursor < child.value.length) {
        replacement.push({ type: 'text', value: child.value.slice(cursor) });
      }

      node.children.splice(index, 1, ...replacement);
      index += replacement.length - 1;
      continue;
    }

    rewritePlainFilePaths(child);
  }
}

type MarkdownNode = {
  type?: unknown;
  tagName?: unknown;
  value?: unknown;
  properties?: Record<string, unknown>;
  children?: MarkdownNode[];
};

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\/[A-Za-z]:[\\/]/.test(value);
}

function isAbsoluteLocalPath(value: string): boolean {
  return isWindowsAbsolutePath(value) || value.startsWith('/');
}

function normalizePathForCompare(value: string): string {
  return normalizeWindowsDrivePrefix(value).replace(/\\/g, '/').toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
