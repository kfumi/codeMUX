/**
 * 构建产物契约：`[data-long-thread] [data-message-row]` 的声明集合必须在
 * `src/styles/globals.css` 与 `dist/assets/*.css` 之间一致。
 *
 * 理由：这类探针最危险的失效方式是「跑的是旧产物，于是错误地宣告没问题」。
 * 样式表一旦改了而产物没重建，探针量到的就不是源码里的规则——必须在跑之前失败，
 * 而不是静默给出一个看起来正常的结论。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 被裁决的规则选择器（源码与产物都用这一条）。 */
export const LONG_THREAD_SELECTOR = '[data-long-thread] [data-message-row]';

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
    const value = declaration.slice(separator + 1).replace(/\s+/g, ' ').trim();
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

  return {
    ok: true,
    sourcePath,
    cssFiles,
    sourceDeclarations: declarationsToObject(sourceDeclarations),
    builtDeclarations,
  };
}
