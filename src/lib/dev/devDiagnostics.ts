/**
 * 常开诊断（生产构建里也会跑的遥测/日志）的统一 DEV 门控。
 *
 * ## 机制：构建期替换，不是运行时判断
 *
 * Vite 在 **transform/build 阶段**就把 `import.meta.env.DEV` 替换成字面量
 * （生产构建 `false`，dev server / vitest `true`）。所以
 *
 * ```ts
 * if (isDevDiagnosticsEnabled()) { recordRevealFrame(...); }
 * ```
 *
 * 在产物里会先变成 `if (false) { ... }`，随后被 Rollup 的 tree-shaking / DCE
 * 连同分支体一起移除。净效果：**打包态的 bundle 里根本没有这些诊断代码，
 * 既不执行也不携带** —— 这就是"生产不付代价"的实现方式，而不是靠每次调用做一次
 * 布尔判断。
 *
 * ## 为什么每条诊断都值得收
 *
 * 打包后的桌面应用里，凡是真正到达 `console.*` 的日志都会被主进程的
 * `console-message` 接走并追加到 `logs/renderer.log`（见 `apps/desktop/src/main.ts`
 * 的 `getRendererLog().record`），即一条 = 一次 IPC + 一次文件追加。
 * 注意 `src/lib/logger.ts` 还有一层客户端级别门槛：生产态 `minLevel = 'info'`，
 * 所以 **debug 级日志在打包态本来就不会走到 console**（省掉的是构造参数对象的开销），
 * 而 `info`/`warn`/`error` 级（如两条 `MODEL_TRACE`）是真的会落盘的。
 * 两类的共同点是：流式期间以每秒数十次的量级发生，生产里却没有任何读者。
 *
 * ## 为什么不能缓存成模块级常量
 *
 * 既没必要（构建期已经折成字面量），也会挡住测试：测试要用
 * `vi.stubEnv('DEV', false)` 覆盖取值后在同一个模块实例上观察行为差异，
 * 所以这里每次调用都实时读取 `import.meta.env.DEV`。
 */
export function isDevDiagnosticsEnabled(): boolean {
  return import.meta.env.DEV;
}
