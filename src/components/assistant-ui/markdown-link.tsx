import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { open } from '@tauri-apps/plugin-shell';
import { defaultRehypePlugins } from 'streamdown';

import { cn } from '@/lib/utils';
import { fileApi } from '@/lib/tauri';
import { useProjectStore } from '@/stores/projectStore';
import { useSidePanelStore } from '@/stores/sidePanelStore';

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
  const filePath = normalizeLocalMarkdownHref(href);

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

  return (
    <a
      {...props}
      href={href}
      className={cn(
        'aui-md-a cursor-pointer text-primary underline underline-offset-2 hover:text-primary/80',
        className,
      )}
      onClick={handleClick}
    >
      {children}
    </a>
  );
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

export function codemuxLocalFileLinkRehypePlugin() {
  return (tree: unknown) => {
    rewriteLocalFileLinks(tree);
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
  return value.replace(/:(\d+)(?::\d+)?$/, '');
}

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
