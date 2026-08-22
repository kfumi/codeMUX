/**
 * Provider SDK 的编译期最小契约。
 *
 * SDK 实现只存在于用户安装的托管 npm Runtime 中，sidecar 不应通过
 * node_modules 静态加载它们。这里仅保留 sidecar 编译所需的类型形状。
 */
declare module '@anthropic-ai/claude-agent-sdk' {
  export type Query = any;
  export type SDKUserMessage = any;
  export interface WarmQuery {
    close(): void;
    query(...args: any[]): Query;
  }
  export const query: (...args: any[]) => Query;
  export const startup: (...args: any[]) => Promise<WarmQuery>;
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
