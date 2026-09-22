/**
 * Shiki 高亮的预热。
 *
 * **为什么需要**：`@streamdown/code` 的高亮器是按「语言 + 双主题」懒建的**模块级**单例
 * （内部走 `createHighlighter({ langs: [语言], themes })`），语言文法是在**首次高亮该语言**时
 * 才 `import()` 并编译。实测（`docs/research/2026-09-21-pi-desktop-performance-cross-reference.md`
 * 5.12 / 5.13 节）这次初始化会在流式开始后 **0.6–1.0 秒**造成两段共 **380–420ms** 的主线程阻塞——
 * 也就是"第一次遇到代码块"的那一刻。把这次初始化挪到应用空闲期之后，流式窗口内的阻塞为 **0**，
 * 单次最长提交从 **12.5ms 降到 10.9ms**（回到 16ms 帧预算以内）。
 *
 * **为什么在空闲时而不是"流式开始时"预热**：调用方拿不到"即将出现的代码块语言"，所以只能在
 * 应用空闲时把高频语言先热掉。预热是一次性 CPU 工作，放在空闲期对用户不可见。
 *
 * **为什么直接调 `highlight()` 而不是离屏渲染一个代码块**：离屏渲染会把 Markdown 解析与 React
 * 渲染也算进去（实测那条预热长任务因此从 142–145ms 涨到 172–185ms）。直接调用插件公开的
 * `highlight()` 只做"高亮器创建 + 首次分词"，而且和渲染路径命中**同一个**模块级缓存——
 * `markdown-text.tsx` 传给 `Streamdown` 的就是这个 `code` 单例，主题也取自插件自己的
 * `getThemes()`（**必须**这样：`Streamdown` 用的是 `plugins.code.getThemes()`，不是 `shikiTheme`
 * 属性，主题不一致会让缓存键对不上、预热变成空转）。
 *
 * **反面做法**（实测更差，不要走）：流式期间一律不高亮、结束后一次性补上。
 * 那会在流式结束后炸出一次 **520ms 左右**的阻塞，正好是用户要看结果的时候。
 */
import type { HighlightOptions } from '@streamdown/code';
import { logger } from './logger';

/**
 * 预热语料：只要能让文法真正跑起来即可，不追求真实，但**不能只有一行**——
 * 正则引擎是按实际输入惰性编译规则的，语料太短等于只热了一小部分规则
 * （实测：3 行语料预热后流式窗口内仍有约 185ms 阻塞，换成代表性语料后降到 0）。
 */
const WARMUP_SNIPPETS: Record<string, string> = {
  typescript: [
    'export interface WarmupOptions<T extends object> {',
    '  readonly name: string;',
    '  payload: T | null;',
    '  retries?: number;',
    '}',
    '',
    'type WarmupResult<T> = { ok: true; value: T } | { ok: false; error: Error };',
    '',
    'export async function warmup<T extends object>(',
    '  options: WarmupOptions<T>,',
    '): Promise<WarmupResult<T>> {',
    '  const { name, payload, retries = 3 } = options;',
    '  const pattern = /^[a-z]+(?:-[a-z]+)*$/;',
    '  if (!pattern.test(name)) {',
    '    return { ok: false, error: new Error(`bad name: ${name}`) };',
    '  }',
    '  for (let attempt = 0; attempt < retries; attempt += 1) {',
    '    try {',
    '      const value = await Promise.resolve(payload as T);',
    '      return { ok: true, value };',
    '    } catch (error) {',
    '      if (attempt === retries - 1) {',
    '        return { ok: false, error: error as Error };',
    '      }',
    '    }',
    '  }',
    "  return { ok: false, error: new Error('unreachable') };",
    '}',
  ].join('\n'),
  tsx: [
    "import { useState } from 'react';",
    '',
    'export function Counter({ initial = 0 }: { initial?: number }) {',
    '  const [value, setValue] = useState(initial);',
    '  return (',
    '    <button type="button" onClick={() => setValue((current) => current + 1)}>',
    '      clicked {value} times',
    '    </button>',
    '  );',
    '}',
  ].join('\n'),
  bash: [
    'set -euo pipefail',
    'root="${1:-/tmp}"',
    'for file in "$root"/*.log; do',
    '  gzip -c "$file" > "$file.gz"',
    'done',
    'echo "packed $(ls -1 "$root"/*.gz | wc -l) files"',
  ].join('\n'),
  json: [
    '{',
    '  "name": "warmup",',
    '  "private": true,',
    '  "scripts": { "build": "tsc -p ." },',
    '  "dependencies": { "react": "^18.0.0" }',
    '}',
  ].join('\n'),
};

/** 未知语言的兜底语料：同样不能只有一行，否则"白热"（办了事却几乎没编译任何规则）。 */
const FALLBACK_SNIPPET = 'const warmed = 1;\nconsole.log(warmed);\n';

/**
 * 默认预热集合：高频语言，**故意保持很短**——每种语言都是一次文法编译 + 常驻内存。
 * 要加语言就往 `WARMUP_SNIPPETS` 里加一条。
 */
export const DEFAULT_WARM_LANGUAGES: readonly string[] = Object.keys(WARMUP_SNIPPETS);

/**
 * 已经**尝试**过预热的语言。
 *
 * 语义是"尝试过"而不是"成功"，因为重试没有意义：上游把 `createHighlighter` 的 promise 在
 * await **之前**就写进了模块级缓存，且失败时不清缓存——同一次页面生命期内该语言不会再有
 * 第二次机会（详见下面 `catch` 里的说明）。
 */
const attemptedLanguages = new Set<string>();

/** 真空闲最多退让这么多次，之后放弃预热。 */
const MAX_IDLE_RETRIES = 8;

/**
 * 只在**真空闲**时执行。
 *
 * `didTimeout` 为真且剩余预算为 0，说明这个回调是被 `timeout` 强制投递的——主线程当时并不空闲，
 * 此时做一次文法编译会制造 ~300ms 的阻塞，正是本模块要消除的东西。所以这种回调一律**退让**
 * （重新排队，最多 `MAX_IDLE_RETRIES` 次），退让完还拿不到真空闲就放弃：预热是优化，不是
 * 正确性要求，宁可永不预热也不要在忙碌或交互时插这一下。
 *
 * 另一个已知形态：隐藏窗口不投递空闲回调，所以后台/托盘启动的形态会在窗口恢复后才预热。
 */
function scheduleIdle(callback: () => void, attempt = 0): void {
  if (typeof requestIdleCallback !== 'function') {
    setTimeout(callback, 0);
    return;
  }

  requestIdleCallback(
    (deadline) => {
      if (deadline.didTimeout && deadline.timeRemaining() <= 0) {
        if (attempt < MAX_IDLE_RETRIES) {
          scheduleIdle(callback, attempt + 1);
        }
        return;
      }
      callback();
    },
    { timeout: 2_000 },
  );
}

/**
 * 逐个语言预热：一次空闲回调只手热一种，避免一个空闲时段被整串文法编译占满。
 */
function warmNext(queue: readonly string[]): void {
  const [language, ...rest] = queue;
  if (language === undefined) {
    return;
  }

  scheduleIdle(() => {
    void import('@streamdown/code')
      .then(({ code }) => {
        try {
          // 未命中缓存时返回 null、结果走回调；这里不关心结果，只要它把高亮器建起来。
          code.highlight(
            {
              code: WARMUP_SNIPPETS[language] ?? FALLBACK_SNIPPET,
              // 插件签名收的是 shiki 的 `BundledLanguage` 联合类型，调用方没必要知道它；
              // 这里按插件自己的契约收窄（插件内部会把别名 `ts` 归一化到同一个高亮器缓存键）。
              language: language as HighlightOptions['language'],
              themes: code.getThemes(),
            },
            () => {},
          );
        } catch (error) {
          // 这里**不重试**：上游在 await 之前就把高亮器 promise 写进了模块级缓存，失败也不清缓存，
          // 所以同一次页面生命期内该语言不会再有机会——重试是无效工作。留下日志是为了避免
          // "预热静默失败"变成无法定位的现象（那种情况下该语言的代码块会一直不高亮）。
          logger.warn('Code highlight warmup failed', { language }, error);
        }
      })
      .catch((error) => {
        // 模块加载失败同理：不能让预热把启动路径带崩，也不能静默。
        logger.warn('Code highlight warmup could not load @streamdown/code', { language }, error);
      })
      .finally(() => {
        if (rest.length > 0) {
          warmNext(rest);
        }
      });
  });
}

/**
 * 在应用空闲时预热高亮器。`main.tsx` 调用一次即可；重复调用是安全的。
 */
export function primeCodeHighlighting(
  languages: readonly string[] = DEFAULT_WARM_LANGUAGES,
): void {
  if (typeof window === 'undefined') {
    return;
  }

  const pending = languages.filter((language) => !attemptedLanguages.has(language));
  if (pending.length === 0) {
    return;
  }
  // 先记账再调度：避免同一批语言被重复排进空闲队列（重试本身也没有意义，见上面的说明）。
  for (const language of pending) {
    attemptedLanguages.add(language);
  }
  warmNext(pending);
}

/** 仅供测试：清空账本，让下一条用例从"没预热过"开始。 */
export function resetCodeHighlightWarmupForTests(): void {
  attemptedLanguages.clear();
}
