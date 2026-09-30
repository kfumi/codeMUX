import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { defaultRehypePlugins } from 'streamdown';
import type { StreamdownProps } from 'streamdown';

import { shellFacade } from '@/lib/facades/shell-facade';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/projectStore';
import { usePreviewStore, type FileTreeNodeData } from '@/stores/previewStore';
import { useSidePanelStore } from '@/stores/sidePanelStore';
import { TooltipHint } from '@/components/ui/tooltip';
import { FileTypeIcon } from './file-type-icon';

const LOCAL_FILE_LINK_ORIGIN = 'https://codemux.local-file';

export type CodemuxLocalFileLinkPluginOptions = {
  /** 相对路径解析为绝对路径并链接化（仅消息渲染开启；文件预览保持只链接绝对路径） */
  linkRelativeFilePaths?: boolean;
};

// 注意：数组里必须放插件工厂本身（unified 会调用它获取 transformer），
// 选项通过 [plugin, options] 元组传入；Streamdown 的处理器缓存键取
// `函数名:JSON(options)`，元组形式也避免两条管线匿名插件互相串缓存
export function codemuxLocalFileLinkRehypePlugin(options: CodemuxLocalFileLinkPluginOptions = {}) {
  return (tree: unknown) => {
    rewriteLocalFileLinks(tree);
    rewritePlainFilePaths(tree, options);
  };
}

type CodemuxRehypePluginList = NonNullable<StreamdownProps['rehypePlugins']>;

// 消息渲染管线：相对路径也解析链接
export const CODEMUX_MARKDOWN_REHYPE_PLUGINS: CodemuxRehypePluginList = [
  [codemuxLocalFileLinkRehypePlugin, { linkRelativeFilePaths: true }],
  ...Object.values(defaultRehypePlugins),
];

// 文件预览管线（FileEditorPanel / PlanPreviewPanel）：维持旧行为，只链接绝对路径
export const CODEMUX_FILE_PREVIEW_REHYPE_PLUGINS: CodemuxRehypePluginList = [
  [codemuxLocalFileLinkRehypePlugin, { linkRelativeFilePaths: false }],
  ...Object.values(defaultRehypePlugins),
];

type CodeMuxMarkdownLinkProps = AnchorHTMLAttributes<HTMLAnchorElement>;

export function CodeMuxMarkdownLink({
  className,
  href,
  children,
  ...props
}: CodeMuxMarkdownLinkProps) {
  const openFileTab = useSidePanelStore((state) => state.openFileTab);
  const fileLink = getLocalFileLinkDetails(href, children);
  const filePath = fileLink?.path ?? null;

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (!href) {
      return;
    }

    if (!filePath) {
      // 外链走壳桥 openExternal(main 侧 shell.openExternal,仅 http/https)。
      void shellFacade.openExternal(href).catch(() => {});
      return;
    }

    const basePath = resolveLocalMarkdownBasePath(filePath);
    void openFileTab(basePath, filePath);
  };

  const link = (
    <a
      {...props}
      href={href}
      // 行内基线对齐的关键：这里不能用 `inline-flex`。`inline-flex` 的基线取自
      // **第一个** flex item，而文件图标是替换元素（基线被合成为下外边距边），
      // 于是整块链接的基线被拉到图标底部、比正文文字基线高，视觉上整个文件名偏上。
      // 改成 `inline-block` 后基线回到最后一行文字的基线，与正文严格对齐。
      className={cn(
        'aui-md-a inline-block cursor-pointer text-primary no-underline hover:text-primary/80',
        className,
      )}
      style={{
        ...props.style,
        ...(fileLink ? { color: 'hsl(var(--codemux-link))' } : {}),
      }}
      onClick={handleClick}
    >
      {/*
        图标必须显式 `inline-block`：Tailwind Preflight 有 `svg { display: block }`，
        在 `inline-flex` 下它是 flex item（block 化无害），换成 `inline-block` 锚点后
        会变成块级子元素、被挤到独立一行。`align-middle` 让它按 x 高度中线居中。
      */}
      {fileLink ? (
        <FileTypeIcon filePath={fileLink.path} className="mr-1 inline-block align-middle" />
      ) : null}
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

  // 会话工作目录可能不是注册项目（如 agent 的 working_path 指向项目外目录），
  // 命中时仍用它作为预览基准，保证文档内相对资源可解析
  const sessionProjectPath = usePreviewStore.getState().projectPath;
  if (sessionProjectPath) {
    const normalizedSessionPath = normalizePathForCompare(sessionProjectPath).replace(/\/$/, '');
    if (normalizedFilePath.startsWith(`${normalizedSessionPath}/`)) {
      return sessionProjectPath;
    }
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

// 相对路径备选项的段字符类排除路径分隔符（原 ASCII 版只允许 [A-Za-z0-9._~-]），
// 并允许中文等非 ASCII 字符，如 `lnwlcs\docs\research\企宽竣工调研.md`
const PLAIN_FILE_REFERENCE_RE =
  /(?:[A-Za-z]:[\\/][^\s<>"'`!&*()\[\]{}|，。；：！？、:;]+|\/[^\s<>"'`!&*()\[\]{}|，。；！？、:;]+|(?:\.{1,2}[\\/])?[^\s<>"'`!&*()\[\]{}|，。；：！？、:;\\/]+(?:[\\/][^\s<>"'`!&*()\[\]{}|，。；：！？、:;\\/]+)+|[A-Za-z0-9._~-]+\.[A-Za-z][A-Za-z0-9_-]*)/g;

const FILE_REFERENCE_SUFFIX_RE =
  /^(?::\d+(?::\d+)?(?:-\d+(?:\.\d+)?)?|#L?\d+(?:-L?\d+)?|\s+\(line\s+\d+\)|\s+\(\d+(?:,\s*\d+)?\)|\s+on\s+line\s+\d+)/i;

export function extractLinkableFileReferences(
  text: string,
  options: CodemuxLocalFileLinkPluginOptions = { linkRelativeFilePaths: true },
): PlainFileReference[] {
  const seen = new Set<string>();
  const results: PlainFileReference[] = [];

  const addReference = (reference: PlainFileReference) => {
    const resolved = resolveLinkablePlainFileReference(reference, options);
    if (!resolved) {
      return;
    }

    const key = normalizePathForCompare(stripLocalFileLineSuffix(resolved.path));
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    results.push(resolved);
  };

  for (const reference of parsePlainFileReferences(text)) {
    addReference(reference);
  }

  for (const match of text.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
    const href = match[2]?.trim();
    if (!href) {
      continue;
    }

    const path = normalizeLocalMarkdownHref(href);
    if (!path) {
      continue;
    }

    addReference({
      start: 0,
      end: 0,
      label: match[1] || getFileName(path),
      path,
    });
  }

  return results;
}

export function parsePlainFileReferences(text: string): PlainFileReference[] {
  const references: PlainFileReference[] = [];

  for (const match of text.matchAll(PLAIN_FILE_REFERENCE_RE)) {
    const start = match.index ?? 0;
    const suffix = FILE_REFERENCE_SUFFIX_RE.exec(text.slice(start + match[0].length))?.[0] ?? '';
    const raw = `${match[0]}${suffix}`;
    const parsed = parsePlainFileReference(raw, text, start);
    if (!parsed) {
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

/**
 * 判定并解析一个纯文本文件引用是否可链接化：
 * - 绝对路径沿用原逻辑（文件树已知则必须命中，否则回退到注册项目包含判断）；
 * - 相对路径仅在 `options.linkRelativeFilePaths` 开启时处理（消息管线开启、
 *   文件预览管线关闭），且严格以已加载的文件树为准：整条相对路径在树里
 *   后缀匹配命中才链接，匹配不到（或树未加载）就不链接——宁漏勿错，
 *   不做路径拼接兜底，避免拼出项目根下并不存在的错误链接。
 * 返回携带解析后绝对路径的引用（保留原文 label 与行号后缀），不可链接时返回 null。
 */
function resolveLinkablePlainFileReference(
  reference: PlainFileReference,
  options: CodemuxLocalFileLinkPluginOptions,
): PlainFileReference | null {
  const path = stripLocalFileLineSuffix(reference.path);
  if (!isLikelyLocalFilePath(path)) {
    return null;
  }

  if (isAbsoluteLocalPath(path)) {
    const hasFileTree = usePreviewStore.getState().treeRoot !== null;
    return (hasFileTree ? isKnownProjectFilePath(path) : isPathInsideRegisteredProject(path))
      ? reference
      : null;
  }

  if (!options.linkRelativeFilePaths) {
    return null;
  }

  const resolvedPath = resolveRelativePlainFileReference(path);
  if (!resolvedPath) {
    return null;
  }

  return { ...reference, path: `${resolvedPath}${reference.path.slice(path.length)}` };
}

function resolveRelativePlainFileReference(relativePath: string): string | null {
  const { treeRoot } = usePreviewStore.getState();
  if (!treeRoot) {
    return null;
  }

  return matchTreePathForRelativePath(treeRoot, relativePath);
}

function matchTreePathForRelativePath(treeRoot: FileTreeNodeData[], relativePath: string): string | null {
  const normalizedCandidate = normalizeRelativePathSegments(relativePath);
  if (!normalizedCandidate) {
    return null;
  }

  const candidate = normalizePathForCompare(normalizedCandidate);
  const matches = flattenFileTreePaths(treeRoot).filter((path) =>
    normalizePathForCompare(path).replace(/\/+$/, '').endsWith(`/${candidate}`),
  );

  const { projectPath } = usePreviewStore.getState();
  const preferredBase = projectPath ?? getActiveProjectPath();
  const normalizedPreferredBase = preferredBase ? normalizePathForCompare(preferredBase).replace(/\/+$/, '') : null;
  const preferred = normalizedPreferredBase
    ? matches.find((path) => normalizePathForCompare(path).startsWith(`${normalizedPreferredBase}/`))
    : undefined;

  return preferred ?? matches[0] ?? null;
}

function normalizeRelativePathSegments(value: string): string {
  const segments: string[] = [];
  for (const segment of value.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

function getActiveProjectPath(): string | null {
  const { projects, activeProjectId } = useProjectStore.getState();
  return projects.find((project) => project.id === activeProjectId)?.path ?? null;
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

function rewritePlainFilePaths(node: unknown, options: CodemuxLocalFileLinkPluginOptions = {}): void {
  if (!isRecord(node) || !Array.isArray(node.children)) {
    return;
  }

  if (node.tagName === 'a' || node.tagName === 'pre') {
    return;
  }

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    if (child.type === 'text' && typeof child.value === 'string') {
      const references = parsePlainFileReferences(child.value)
        .map((reference) => resolveLinkablePlainFileReference(reference, options))
        .filter((reference): reference is PlainFileReference => reference !== null);
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

    rewritePlainFilePaths(child, options);
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
