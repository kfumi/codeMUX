/**
 * Provider SDK 的编译期最小契约。
 *
 * SDK 实现只存在于用户安装的托管 npm Runtime 中，sidecar 不应通过
 * node_modules 静态加载它们。这里仅保留 sidecar 编译所需的类型形状。
 */
declare module '@anthropic-ai/claude-agent-sdk' {
  export type Query = any;
  export type SDKUserMessage = any;
  /**
   * Query 实例上的标题生成器（SDK 类型声明未公开，但 0.3.30x 起运行时存在）。
   * `persist: true` 会由 CLI 侧把生成的标题写成 transcript 的 ai-title。
   */
  export interface QueryTitleGenerator {
    generateSessionTitle?(
      description: string,
      options?: { persist?: boolean },
    ): Promise<string | null | undefined>;
  }
  export interface WarmQuery {
    close(): void;
    query(...args: any[]): Query;
  }
  export const query: (...args: any[]) => Query;
  export const startup: (...args: any[]) => Promise<WarmQuery>;
  /**
   * 读取某个 SDK 会话的原生元数据（`SDKSessionInfo.summary` 即
   * custom title → ai-title → first prompt 归一后的可显示标题；`firstPrompt`
   * 用来识别「ai-title 还没生成，summary 只是首条消息兜底」）。
   * 注意：这是模块级导出，不是 `Query` 实例方法。
   */
  export const getSessionInfo:
    | ((sessionId: string, options?: { dir?: string }) => Promise<{
        summary?: string;
        customTitle?: string;
        firstPrompt?: string;
      } | undefined>)
    | undefined;
  /**
   * 非破坏 fork:按消息 UUID(含)切片复制出新会话。0.3.220+ 的托管 Runtime
   * 才有该导出;旧 Runtime 上为 undefined,调用方需兜底报错。
   */
  export const forkSession:
    | ((sessionId: string, options?: { upToMessageId?: string; title?: string }) => Promise<{ sessionId: string }>)
    | undefined;
}

declare module '@opencode-ai/sdk' {
  export type Config = any;
}

declare module '@opencode-ai/sdk/client' {
  export const createOpencodeClient: (...args: any[]) => any;
}

declare module '@opencode-ai/sdk/server' {
  export const createOpencodeServer: (...args: any[]) => Promise<any>;
}
