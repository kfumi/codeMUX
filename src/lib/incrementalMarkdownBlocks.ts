/**
 * 增量 Markdown 分块：把"每次提交都对**累积全文**重新分块"降成"只重解析尾部那一块"。
 *
 * **为什么需要**：实测（研究文档 5.12 / 5.14 节）一次 14s 流式里 Markdown 渲染的提交耗时合计约
 * **662ms**（占挂钟 4.9%，单次最长 13.7ms，已贴着 16ms 帧预算），而 `reveal-plain`（不用 Markdown
 * 渲染）只有 19.3ms。上游 `Streamdown` 每次提交都会先 `remend` 再对**整段文本**重新分块——它的块级
 * memo 只能挡住"已完成块不重跑 unified 管线"，挡不住这次全文分块。换掉分块器实测能砍掉其中约 135ms
 * （提交耗时 694.5ms → 564.2ms）。
 *
 * **怎么用**：`Streamdown` 有官方注入点 `parseMarkdownIntoBlocksFn`，把本函数传进去即可。
 * 它是**有状态**的，必须每个渲染实例一份（生产里用 `useMemo` 在流式组件内建一份）。
 *
 * **哪些情况下会放弃复用**（都会退回整篇重解析，结果与参考实现一致，只是没省到）：
 *
 * 1. **上游有一条非局部规则**：全文任意位置出现脚注样式（`[^x]` 或 `[^x]:`）时，整段文本被当成
 *    **一块**。上游是用两个**无锚点**正则做早退的，所以代码块里 `[^0-9]`、`[^\s]` 这类取反字符类
 *    同样命中。前缀局部的冻结表达不了这种"看全文才决定"的规则，所以只要文本里出现 `[^` 就整篇
 *    重解析——这是上游规则的**保守超集**：误判只损失性能，不会算错。
 * 2. 前缀对不上（例如 `remend` 改写了尾部之外的文本）。
 * 3. 上一次只有一块（整块都在变，没有可冻结的东西）。
 *
 * **仍然依赖的不变量**：参考实现的块 raw 文本拼接严格等于输入（tiling），所以"尾部"正好从
 * 上一块（最后一块）的起点开始。这条不变量没有写进上游的类型里；如果将来上游改默认分块器破坏了它，
 * 表现会是"尾部偏移、文本重复或丢失"，而**不是**自动退回。改动前先跑
 * `src/lib/incrementalMarkdownBlocks.test.ts` 里与真实参考实现的逐步对比。
 */

/** 与 `Streamdown` 的 `parseMarkdownIntoBlocks` 同形：整段文本 → 块字符串数组。 */
export type MarkdownBlockParser = (markdown: string) => string[];

/** 上游非局部早退规则的保守超集（见文件头注释第 1 条）。 */
const GLOBAL_RULE_MARKER = '[^';

/**
 * 包住一个参考实现，返回带缓存的增量版本。
 *
 * @param parse 参考实现（生产里传 `Streamdown` 默认用的 `parseMarkdownIntoBlocks`）
 */
export function createIncrementalBlockParser(parse: MarkdownBlockParser): MarkdownBlockParser {
  /** 上一次解析出的块。除最后一块外的拼接是"已经封顶"的前缀。 */
  let previousBlocks: string[] = [];

  const parseWhole = (markdown: string): string[] => {
    const blocks = parse(markdown);
    previousBlocks = blocks;
    return blocks;
  };

  return (markdown: string): string[] => {
    if (markdown.includes(GLOBAL_RULE_MARKER) || previousBlocks.length <= 1) {
      return parseWhole(markdown);
    }

    // 冻结除最后一块以外的全部块；它们拼接出来的字符串必须仍是新输入的前缀。
    const frozen = previousBlocks.slice(0, -1);
    const frozenSource = frozen.join('');
    if (frozenSource.length === 0 || !markdown.startsWith(frozenSource)) {
      return parseWhole(markdown);
    }

    const blocks = frozen.concat(parse(markdown.slice(frozenSource.length)));
    previousBlocks = blocks;
    return blocks;
  };
}
