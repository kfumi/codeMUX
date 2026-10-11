'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ImgHTMLAttributes,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/utils';
import { TooltipHint } from '@/components/ui/tooltip';
import {
  LOCAL_IMAGE_ORIGIN,
  normalizeLocalImageMarkdownSrc,
  resolveLocalMarkdownBasePath,
} from './markdown-link';

/**
 * 文件预览里的 Markdown 图片：文档内的相对地址（如 `public/demo/home.png`）必须相对
 * **文档所在目录**解析，再读磁盘字节渲染。渲染进程的页面 origin（Vite dev server 或
 * daemon 托管的 dist-web）与文档目录无关，直接用 `<img src="相对路径">` 只会 404。
 *
 * 数据由既有 Companion 接口 `/files/image-preview`（`daemonFacade.previewImageFile`）
 * 读取并返回 data URL：它只接受绝对路径，且限制 8 MiB 与受支持的栅格格式。
 */
export type MarkdownImageDocument = {
  /** 当前预览文档的路径（相对或绝对）。 */
  documentPath: string;
  /** 文档路径为相对路径时的基准目录（通常是项目根）。 */
  basePath?: string;
};

const MarkdownImageDocumentContext = createContext<MarkdownImageDocument | null>(null);

export function MarkdownImageDocumentProvider({
  documentPath,
  projectPath,
  children,
}: {
  documentPath: string;
  projectPath?: string;
  children: ReactNode;
}) {
  const basePath = useMemo(() => {
    if (projectPath) {
      return projectPath;
    }
    return documentPath.trim() ? resolveLocalMarkdownBasePath(documentPath) : undefined;
  }, [documentPath, projectPath]);

  const value = useMemo<MarkdownImageDocument>(
    () => ({ documentPath, basePath }),
    [basePath, documentPath],
  );

  return (
    <MarkdownImageDocumentContext.Provider value={value}>
      {children}
    </MarkdownImageDocumentContext.Provider>
  );
}

/** 还原 rehype 插件改写过的图片地址；未改写过的本地地址也一并识别（幂等）。 */
export function decodeLocalImageSrc(src?: string): string | null {
  if (!src) {
    return null;
  }

  const prefix = `${LOCAL_IMAGE_ORIGIN}/?path=`;
  if (src.startsWith(prefix)) {
    return safeDecodeURIComponent(src.slice(prefix.length));
  }

  return normalizeLocalImageMarkdownSrc(src);
}

/** 把图片地址解析成绝对路径；非本地地址（http/data/blob）返回 null，交给浏览器加载。 */
export function resolveMarkdownImageAbsolutePath(
  src: string | undefined,
  document: MarkdownImageDocument | null,
): string | null {
  const path = decodeLocalImageSrc(src);
  if (!path) {
    return null;
  }

  // 本地文件路径不存在查询串/片段：`logo-dark.png#gh-dark-mode-only` 这类
  // GitHub 明暗两套图片的写法要去掉后缀再读盘，否则会把后缀当成文件名。
  const localPath = stripLocalImageSuffix(path);

  if (isAbsoluteLocalPath(localPath)) {
    return toPosixPath(localPath);
  }

  const baseDir = resolveMarkdownImageBaseDir(document);
  if (!baseDir) {
    return null;
  }

  return joinLocalPath(baseDir, localPath);
}

function stripLocalImageSuffix(path: string): string {
  const hashIndex = path.indexOf('#');
  const queryIndex = path.indexOf('?');
  const cutIndex = [hashIndex, queryIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  return cutIndex === undefined ? path : path.slice(0, cutIndex);
}

function resolveMarkdownImageBaseDir(document: MarkdownImageDocument | null): string | null {
  if (!document) {
    return null;
  }

  const documentPath = document.documentPath?.trim() ?? '';
  if (!documentPath) {
    return document.basePath ? toPosixPath(document.basePath).replace(/\/+$/, '') : null;
  }

  const absoluteDocumentPath = isAbsoluteLocalPath(documentPath)
    ? toPosixPath(documentPath)
    : document.basePath
      ? joinLocalPath(document.basePath, documentPath)
      : null;

  if (!absoluteDocumentPath) {
    return null;
  }

  const separatorIndex = absoluteDocumentPath.lastIndexOf('/');
  if (separatorIndex < 0) {
    return absoluteDocumentPath;
  }

  // POSIX 根目录下的文档（`/README.md`）其目录就是 `/`。
  return separatorIndex === 0 ? '/' : absoluteDocumentPath.slice(0, separatorIndex);
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function isAbsoluteLocalPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path)
    || /^\/[A-Za-z]:[\\/]/.test(path)
    || path.startsWith('/')
    || path.startsWith('\\\\');
}

function joinLocalPath(base: string, relative: string): string {
  const normalizedBase = toPosixPath(base);
  // 保留根前缀（`D:/`、`/`），只对根之后的段做 `.`/`..` 折叠，这样 `../x.png`
  // 能真正爬出文档所在目录。
  const root = /^(\/|[A-Za-z]:\/)/.exec(normalizedBase)?.[1] ?? '';
  const segments = normalizedBase
    .slice(root.length)
    .split('/')
    .filter((segment) => segment && segment !== '.');

  for (const segment of toPosixPath(relative).split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return `${root}${segments.join('/')}`;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const IMAGE_DATA_URL_CACHE_LIMIT = 64;
const imageDataUrlCache = new Map<string, string>();
const imageDataUrlPending = new Map<string, Promise<string>>();

/** 测试用：清空图片 data URL 缓存。 */
export function clearMarkdownImageCache(): void {
  imageDataUrlCache.clear();
  imageDataUrlPending.clear();
}

function rememberMarkdownImageDataUrl(path: string, dataUrl: string): void {
  if (imageDataUrlCache.size >= IMAGE_DATA_URL_CACHE_LIMIT) {
    const oldest = imageDataUrlCache.keys().next();
    if (!oldest.done) {
      imageDataUrlCache.delete(oldest.value);
    }
  }
  imageDataUrlCache.set(path, dataUrl);
}

function loadMarkdownImageDataUrl(absolutePath: string): Promise<string> {
  const cached = imageDataUrlCache.get(absolutePath);
  if (cached) {
    // 命中后重新插入：Map 保序，这样淘汰顺序按「最近使用」而不是「最早写入」。
    imageDataUrlCache.delete(absolutePath);
    imageDataUrlCache.set(absolutePath, cached);
    return Promise.resolve(cached);
  }

  const pending = imageDataUrlPending.get(absolutePath);
  if (pending) {
    return pending;
  }

  // 动态引入 facade：图片预览是次要路径，不把它拉进首屏依赖图（与工具卡片一致）。
  const request = import('@/lib/facades/daemon-facade')
    .then(({ daemonFacade }) => daemonFacade.previewImageFile(absolutePath))
    .then((dataUrl) => {
      rememberMarkdownImageDataUrl(absolutePath, dataUrl);
      return dataUrl;
    })
    .finally(() => {
      imageDataUrlPending.delete(absolutePath);
    });

  imageDataUrlPending.set(absolutePath, request);
  return request;
}

const UNRESOLVED_IMAGE_REASON = '无法确定图片所在目录：文档路径是相对路径且没有可用的项目基准。';

export function CodeMuxMarkdownImage({
  src,
  alt,
  className,
  // Streamdown 通过 passNode 传入 hast 节点，不能落到 DOM 上（否则每张图都有一条
  // React 未知属性告警）；Streamdown 自带的 img 也是先把它摘掉。
  node: _node,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) {
  const document = useContext(MarkdownImageDocumentContext);
  const localPath = useMemo(() => decodeLocalImageSrc(src), [src]);
  const absolutePath = useMemo(
    () => resolveMarkdownImageAbsolutePath(src, document),
    [document, src],
  );
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(() =>
    src && !localPath && !absolutePath ? src : null,
  );
  const [failed, setFailed] = useState(false);
  // 失败原因（daemon 的报错原文，例如「无法打开图片文件」）挂到占位符的提示上，
  // 否则文档里写错路径时只看到一句「图片无法预览」，没法定位。
  const [failureReason, setFailureReason] = useState<string | null>(null);

  useEffect(() => {
    if (!src) {
      setResolvedSrc(null);
      setFailed(false);
      setFailureReason(null);
      return;
    }

    if (!absolutePath) {
      // 非本地地址（http/data/blob）交给浏览器加载；本地地址解析不出绝对路径时保持
      // 空值，由下面渲染成占位符——绝不把假 origin 交给 <img>（那会是一次 DNS 请求）。
      setResolvedSrc(localPath ? null : src);
      setFailed(false);
      setFailureReason(localPath ? UNRESOLVED_IMAGE_REASON : null);
      return;
    }

    let active = true;
    setFailed(false);
    setFailureReason(null);
    setResolvedSrc(null);
    loadMarkdownImageDataUrl(absolutePath)
      .then((dataUrl) => {
        if (active) {
          setResolvedSrc(dataUrl);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setFailureReason(cause instanceof Error ? cause.message : String(cause));
          setFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, [absolutePath, localPath, src]);

  // sanitize 会剥掉 data:/未知协议的 src；与 Streamdown 默认 img 一致：不渲染。
  if (!src) {
    return null;
  }

  if (failed || (localPath && !absolutePath)) {
    return (
      <TooltipHint content={failureReason ?? UNRESOLVED_IMAGE_REASON}>
        <span data-testid="markdown-image-error" className="text-ui-caption text-muted-foreground">
          {alt ? `[图片无法预览：${alt}]` : '[图片无法预览]'}
        </span>
      </TooltipHint>
    );
  }

  if (!resolvedSrc) {
    return (
      <span data-testid="markdown-image-loading" className="text-ui-caption text-muted-foreground">
        {alt || '图片加载中…'}
      </span>
    );
  }

  return <img alt={alt} className={cn('max-w-full rounded-md', className)} src={resolvedSrc} {...props} />;
}
