"use client";

import {
  StreamdownTextPrimitive,
} from "@assistant-ui/react-streamdown";
import type { StreamdownProps } from "streamdown";
import { code } from "@streamdown/code";
import { memo } from "react";
import { cn } from "@/lib/utils";
import { CODEMUX_FILE_PREVIEW_REHYPE_PLUGINS, CODEMUX_MARKDOWN_REHYPE_PLUGINS, CodeMuxMarkdownLink } from "./markdown-link";

const defaultComponents = {
  h1: ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h1
      className={cn(
        "aui-md-h1 mt-5 mb-2 scroll-m-20 text-xl font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2
      className={cn(
        "aui-md-h2 mt-5 mb-2 scroll-m-20 text-lg font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3
      className={cn(
        "aui-md-h3 mt-4 mb-1.5 scroll-m-20 text-base font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h4
      className={cn(
        "aui-md-h4 mt-3.5 mb-1 scroll-m-20 text-base font-medium first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h5: ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h5
      className={cn(
        "aui-md-h5 mt-3 mb-1 text-sm font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h6: ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h6
      className={cn(
        "aui-md-h6 mt-3 mb-1 text-sm font-medium first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  a: ({ className, href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <CodeMuxMarkdownLink
      {...props}
      href={href}
      className={cn(
        "aui-md-a text-primary hover:text-primary/80 no-underline cursor-pointer",
        className,
      )}
    >
      {children}
    </CodeMuxMarkdownLink>
  ),
  table: ({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) => (
    <div className="my-4 overflow-x-auto rounded-md border border-border bg-background">
      <table
        className={cn("aui-md-table w-full divide-y divide-border text-sm", className)}
        {...props}
      />
    </div>
  ),
};

/**
 * 消息 Markdown 的统一渲染配置：流式期间（CodeMuxThread StreamingContent）与
 * 完成后（MarkdownText / StaticMarkdownText / PlanPreviewPanel）必须共用同一份
 * components / plugins / controls，否则流式结束切换组件时会出现样式跳变
 * （标题字号、表格按钮、代码高亮闪变）。注意必须保持模块级常量——
 * Streamdown 的 Block 级 memo 依赖 components 各 key 的函数引用稳定。
 */
export const CODEMUX_MARKDOWN_COMPONENTS = {
  ...defaultComponents,
  a: CodeMuxMarkdownLink,
};

export const CODEMUX_MARKDOWN_STREAMDOWN_PROPS: Omit<
  StreamdownProps,
  "children" | "mode"
> = {
  className: "aui-md",
  components: CODEMUX_MARKDOWN_COMPONENTS as never,
  plugins: { code },
  shikiTheme: ["github-light", "github-dark"],
  controls: { code: { copy: true, download: false }, table: false } as never,
  rehypePlugins: CODEMUX_MARKDOWN_REHYPE_PLUGINS,
  linkSafety: { enabled: false },
};

/**
 * 文件预览（FileEditorPanel / PlanPreviewPanel 等）专用的 Streamdown 配置：
 * 与消息渲染共用样式与组件，但 rehype 插件关闭相对路径链接化——
 * 预览文档里的相对路径保持普通文本，不做解析。
 */
export const CODEMUX_FILE_PREVIEW_STREAMDOWN_PROPS: Omit<
  StreamdownProps,
  "children" | "mode"
> = {
  ...CODEMUX_MARKDOWN_STREAMDOWN_PROPS,
  rehypePlugins: CODEMUX_FILE_PREVIEW_REHYPE_PLUGINS,
};

const MarkdownTextImpl = () => {
  return (
    <StreamdownTextPrimitive
      plugins={{ code }}
      shikiTheme={["github-light", "github-dark"]}
      className="aui-md"
      components={CODEMUX_MARKDOWN_COMPONENTS as never}
      rehypePlugins={CODEMUX_MARKDOWN_REHYPE_PLUGINS}
      controls={{ code: { copy: true, download: false }, table: false } as never}
      linkSafety={{ enabled: false }}
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);
