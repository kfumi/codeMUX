/**
 * 构建产物契约：样式表里的两条关键规则，其声明集合必须在 `src/styles/globals.css` 与
 * `dist/assets/*.css` 之间一致。
 *
 * 被裁决的规则：
 *   1. `[data-long-thread] [data-message-row]`：长会话的离屏行跳过规则（探针的 with-skip 前提）；
 *   2. `[data-thread-measuring] [data-message-row]`（同一 prelude 里还要列出
 *      `[data-streamdown="code-block"]`）：跳转期间的测量逃生口（落点精确性的前提，
 *      见工单 02 —— 只中和行级规则够不到 streamdown 给代码块打的内联跳过）。
 *
 * 理由：这类探针最危险的失效方式是「跑的是旧产物，于是错误地宣告没问题」。样式表一旦改了而
 * 产物没重建，探针量到的就不是源码里的规则——必须在跑之前失败，而不是静默给出一个看起来正常
 * 的结论。第二条规则同理：缺了它，探针量到的是「没修」的落点，却会照着新规则的预期去解读。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 被裁决的规则选择器（源码与产物都用这一条）。 */
export const LONG_THREAD_SELECTOR = '[data-long-thread] [data-message-row]';
/** 跳转测量作用域里的行级选择器；同一条规则还必须列出代码块那一层。 */
export const MEASURING_SCOPE_SELECTOR = '[data-thread-measuring] [data-message-row]';
/**
 * 第二层跳过渲染的标记。产物会把属性选择器的引号压掉（`[data-streamdown=code-block]`），
 * 所以两种写法都算命中；用文本匹配而不是固定选择器，才能同时覆盖源码与产物。
 */
const CODE_BLOCK_MARKER_PATTERN = /\[data-streamdown=(?:"code-block"|code-block)\]/;

function normalizeDeclarations(body) {
  const map = new Map();
  for (const rawDeclaration of body.split(';')) {
    const declaration = rawDeclaration.trim();
    if (declaration.length === 0) {
      continue;
    }
    const separator = declaration.indexOf(':');
    if (separator < 0) {
      map.set(declaration.toLowerCase(), '');
      continue;
    }
    const property = declaration.slice(0, separator).trim().toLowerCase();
    // 产物会压掉 `!important` 前的空格（源码 `visible !important` → 产物 `visible!important`），
    // 归一化到同一种写法，否则这条比较会被压缩器的空白习惯误判成漂移。
    const value = declaration
      .slice(separator + 1)
      .replace(/\s*!\s*important/gi, '!important')
      .replace(/\s+/g, ' ')
      .trim();
    map.set(property, value);
  }
  return map;
}

/** 选择器前面只能是规则边界（文件开头、`}`、`;` 或注释结尾），不能是别的选择器的一部分。 */
function isRulePreludeStart(cssText, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(cssText[cursor])) {
    cursor -= 1;
  }
  if (cursor < 0) {
    return true;
  }
  if (cssText[cursor] === '}' || cssText[cursor] === ';') {
    return true;
  }
  return cssText.slice(cursor - 1, cursor + 1) === '*/';
}

/**
 * 找出 CSS 里所有 prelude 恰好是该选择器的规则体（产物是压缩过的单行，不能按行匹配）。
 *
 * 不能先整体剥注释：globals.css 里有 `@source ".../dist/*.js"` 这种含 `/*` 的字符串，
 * 天真的剥注释会把它当成注释起点，一路吞到真正的注释结尾，把规则本身吞掉。
 * 因此这里直接按选择器定位，并校验它确实处在一条规则的开头。
 */
export function collectRuleDeclarations(cssText, selector = LONG_THREAD_SELECTOR) {
  const blocks = [];
  let from = 0;

  for (;;) {
    const index = cssText.indexOf(selector, from);
    if (index < 0) {
      return blocks;
    }
    from = index + selector.length;

    if (!isRulePreludeStart(cssText, index)) {
      continue;
    }

    const afterSelector = /^\s*\{/.exec(cssText.slice(index + selector.length));
    if (!afterSelector) {
      continue;
    }
    const bodyStart = index + selector.length + afterSelector[0].length;
    const bodyEnd = cssText.indexOf('}', bodyStart);
    if (bodyEnd < 0) {
      continue;
    }
    blocks.push(normalizeDeclarations(cssText.slice(bodyStart, bodyEnd)));
  }
}

/**
 * 与 `collectRuleDeclarations` 同类，但允许 prelude 里继续列别的选择器（CSS 规则列表）。
 *
 * 为什么不能复用上面那条：跳转测量作用域的规则是「行级选择器 + 代码块选择器」写在一起的一条
 * 规则列表，严格版要求选择器后面紧跟 `{`，会直接漏掉它（那正是漏检最危险的形态）。
 * 为了不放松已有的检查，严格版原样保留，这里只是另加一条宽松口径。
 */
function collectRuleListDeclarations(cssText, selector) {
  const blocks = [];
  let from = 0;

  for (;;) {
    const index = cssText.indexOf(selector, from);
    if (index < 0) {
      return blocks;
    }
    from = index + selector.length;

    if (!isRulePreludeStart(cssText, index)) {
      continue;
    }

    const openBrace = cssText.indexOf('{', from);
    if (openBrace < 0) {
      continue;
    }
    // 选择器与 `{` 之间只能继续是「, 选择器」：出现别的规则边界就说明命中的是别的规则的一部分。
    const preludeTail = cssText.slice(from, openBrace);
    if (!/^\s*(,\s*[^,{};]+\s*)*$/.test(preludeTail)) {
      continue;
    }
    const bodyEnd = cssText.indexOf('}', openBrace);
    if (bodyEnd < 0) {
      continue;
    }
    blocks.push({
      prelude: cssText.slice(index, openBrace),
      declarations: normalizeDeclarations(cssText.slice(openBrace + 1, bodyEnd)),
    });
  }
}

/**
 * 跳转测量作用域的产物同步校验（工单 02 落点精确性）。
 *
 * 判据两条：
 *   1. 源码里这条规则存在，且同一 prelude 同时列出代码块那一层选择器 —— 只中和
 *      `[data-message-row]` 够不到 streamdown 给代码块打的内联跳过，而那一层是真的根因；
 *   2. 产物里这条规则的声明集合与源码一致（产物落后时探针必须失败，而不是给出「已修」的假象）。
 *
 * 返回 `{ ok, reason?, declarations?, built? }`：失败原因交给调用方拼进整体结果。
 */
function checkMeasuringScopeRule(sourceCss, cssFiles, rootDir) {
  const sourceBlocks = collectRuleListDeclarations(sourceCss, MEASURING_SCOPE_SELECTOR);
  if (sourceBlocks.length === 0) {
    return {
      ok: false,
      reason: `源码样式表里找不到 ${MEASURING_SCOPE_SELECTOR} 规则——跳转落点精确性的前提没有了。`,
    };
  }
  if (!CODE_BLOCK_MARKER_PATTERN.test(sourceBlocks[0].prelude)) {
    return {
      ok: false,
      reason: `${MEASURING_SCOPE_SELECTOR} 所在的规则里没有代码块选择器`
        + '（`[data-streamdown="code-block"]`）：第二层跳过渲染没被中和，落点仍会偏。',
    };
  }

  const builtBlocks = [];
  for (const cssFile of cssFiles) {
    for (const block of collectRuleListDeclarations(fs.readFileSync(cssFile, 'utf8'), MEASURING_SCOPE_SELECTOR)) {
      builtBlocks.push({ cssFile, ...block });
    }
  }
  if (builtBlocks.length === 0) {
    return {
      ok: false,
      reason: `构建产物里没有 ${MEASURING_SCOPE_SELECTOR} 规则`
        + `（检查了 ${cssFiles.length} 个 CSS 文件）。请运行 npm run build 后重试。`,
    };
  }
  if (!builtBlocks.some((block) => CODE_BLOCK_MARKER_PATTERN.test(block.prelude))) {
    return {
      ok: false,
      reason: `构建产物里 ${MEASURING_SCOPE_SELECTOR} 所在的规则没有代码块选择器`
        + '（`[data-streamdown="code-block"]`）。请运行 npm run build 后重试。',
    };
  }

  const sourceDeclarations = sourceBlocks[0].declarations;
  const problems = [];
  for (const { cssFile, declarations } of builtBlocks) {
    for (const problem of describeDifference(sourceDeclarations, declarations)) {
      problems.push(`${path.relative(rootDir, cssFile)} → ${problem}`);
    }
  }
  if (problems.length > 0) {
    return {
      ok: false,
      reason: [
        `${MEASURING_SCOPE_SELECTOR} 的声明在源码与构建产物之间漂移，探针拒绝在旧产物上给结论。`,
        '请运行 npm run build 后重试。',
        ...problems.map((problem) => `  - ${problem}`),
      ].join('\n'),
    };
  }

  return {
    ok: true,
    selector: MEASURING_SCOPE_SELECTOR,
    declarations: declarationsToObject(sourceDeclarations),
    built: builtBlocks.map(({ cssFile, declarations }) => ({
      cssFile: path.relative(rootDir, cssFile),
      declarations: declarationsToObject(declarations),
    })),
  };
}

function declarationsToObject(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function describeDifference(source, built) {
  const keys = new Set([...source.keys(), ...built.keys()]);
  const problems = [];
  for (const key of keys) {
    const sourceValue = source.get(key);
    const builtValue = built.get(key);
    if (sourceValue === builtValue) {
      continue;
    }
    problems.push(`${key}: 源码=${sourceValue ?? '<缺失>'} 产物=${builtValue ?? '<缺失>'}`);
  }
  return problems;
}

/**
 * 校验产物与源码同步。返回结果对象而不是抛错，让运行器可以带上自己的提示语。
 */
export function assertLongThreadStylesheetInSync(rootDir) {
  const sourcePath = path.join(rootDir, 'src', 'styles', 'globals.css');
  const assetsDir = path.join(rootDir, 'dist', 'assets');

  if (!fs.existsSync(sourcePath)) {
    return { ok: false, reason: `找不到源码样式表：${sourcePath}` };
  }
  if (!fs.existsSync(assetsDir)) {
    return {
      ok: false,
      reason: `找不到构建产物目录：${assetsDir}。请先运行 npm run build。`,
    };
  }

  const cssFiles = fs.readdirSync(assetsDir)
    .filter((name) => name.endsWith('.css'))
    .map((name) => path.join(assetsDir, name));

  if (cssFiles.length === 0) {
    return { ok: false, reason: 'dist/assets 下没有 CSS 产物。请先运行 npm run build。', sourcePath };
  }

  const sourceBlocks = collectRuleDeclarations(fs.readFileSync(sourcePath, 'utf8'));
  if (sourceBlocks.length === 0) {
    return {
      ok: false,
      reason: `源码样式表里找不到 ${LONG_THREAD_SELECTOR} 规则——探针的前提没有了：${sourcePath}`,
      sourcePath,
    };
  }

  const builtMatches = [];
  for (const cssFile of cssFiles) {
    for (const block of collectRuleDeclarations(fs.readFileSync(cssFile, 'utf8'))) {
      builtMatches.push({ cssFile, block });
    }
  }

  if (builtMatches.length === 0) {
    return {
      ok: false,
      reason: `构建产物里没有 ${LONG_THREAD_SELECTOR} 规则（检查了 ${cssFiles.length} 个 CSS 文件）。请运行 npm run build 后重试。`,
      sourcePath,
      cssFiles,
    };
  }

  const sourceDeclarations = sourceBlocks[0];
  const problems = [];
  for (const { cssFile, block } of builtMatches) {
    for (const problem of describeDifference(sourceDeclarations, block)) {
      problems.push(`${path.relative(rootDir, cssFile)} → ${problem}`);
    }
  }

  const builtDeclarations = builtMatches.map(({ cssFile, block }) => ({
    cssFile: path.relative(rootDir, cssFile),
    declarations: declarationsToObject(block),
  }));

  if (problems.length > 0) {
    return {
      ok: false,
      reason: [
        `${LONG_THREAD_SELECTOR} 的声明在源码与构建产物之间漂移，探针拒绝在旧产物上给结论。`,
        '请运行 npm run build 后重试。',
        ...problems.map((problem) => `  - ${problem}`),
      ].join('\n'),
      sourcePath,
      cssFiles,
      sourceDeclarations: declarationsToObject(sourceDeclarations),
      builtDeclarations,
    };
  }

  // 第二条规则（跳转测量作用域）：与上面那条同源同口径，既不放松也不替代它。
  // 读取源码文本复用上面的读法，失败原因直接透出（探针必须带着原因拒绝给结论）。
  const measuringScope = checkMeasuringScopeRule(
    fs.readFileSync(sourcePath, 'utf8'),
    cssFiles,
    rootDir,
  );
  if (!measuringScope.ok) {
    return {
      ok: false,
      reason: measuringScope.reason,
      sourcePath,
      cssFiles,
      sourceDeclarations: declarationsToObject(sourceDeclarations),
      builtDeclarations,
    };
  }

  return {
    ok: true,
    sourcePath,
    cssFiles,
    sourceDeclarations: declarationsToObject(sourceDeclarations),
    builtDeclarations,
    measuringScope,
  };
}
