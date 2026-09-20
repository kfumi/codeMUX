/**
 * `ws` 的最小类型声明(工单 08):apps/desktop 只允许新增唯一运行时依赖 `ws`,
 * 不引入 @types/ws。这里仅声明 browser-automation.ts 实际用到的面。
 *
 * Electron main(main.ts/browser-automation.ts)按 apps/desktop/tsconfig
 * 编译为 CommonJS;vitest(根配置)经 vi.mock('ws') 注入测试替身。
 */
declare module 'ws' {
  export default class WebSocket {
    constructor(url: string, options?: Record<string, unknown>);
    /** 0 Connecting / 1 Open / 2 Closing / 3 Closed。 */
    readyState: number;
    on(event: 'open', listener: () => void): this;
    on(event: 'message', listener: (data: unknown) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    removeAllListeners(): void;
    terminate(): void;
  }
}
