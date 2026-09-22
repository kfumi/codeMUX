/**
 * 行数预算门禁（借鉴 PI-Desktop 的 `scripts/check-architecture.mjs`）。
 *
 * **为什么**：这个仓库里已经出现 2000+ 行的 `CodeMuxThread.tsx` 与 3900+ 行的 `agentStore.ts`，
 * 而"文件涨到多大"从来没有任何门禁拦过——只能靠人偶尔说一句"是不是该拆了"。
 * 行数不是目的，但它是**可机械检查**的复杂度代理：一个文件越大，改它的风险与审查成本越高。
 *
 * **为什么用冻结基线而不是一刀切**：一上来就给现有巨文件设死线等于要求先做一次大重构，
 * 那种门禁最后一定会被绕过。这里改成：
 * - 基线**外**的文件（新文件为主）按预算卡死；
 * - 基线**内**的文件允许保持现状，但**一行都不许再涨**——想加东西就必须先拆。
 *
 * 用法：
 *   node scripts/check-file-size-budget.mjs                  # 检查（CI / pre-commit 可用）
 *   node scripts/check-file-size-budget.mjs --update-baseline # 重写基线（只在有意收紧/新增豁免时跑）
 *   npm run check:size
 *
 * 注意：本文件**故意不带 shebang**。它被 `check-file-size-budget.test.mjs` 直接
 * import，而 Vitest 的转换不接受 shebang（会报 SyntaxError: Invalid or unexpected
 * token）；统一经 `node scripts/...` 调用，无需 shebang。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
export const BASELINE_PATH = path.join(HERE, 'file-size-baseline.json');

/** 每个扩展名的默认预算（行）。新文件必须落在这个线内。 */
export const DEFAULT_BUDGETS = {
  '.ts': 800,
  '.tsx': 800,
  '.rs': 1000,
};

/** 扫这些目录（仓库相对路径）。只扫源码，不扫产物与依赖。 */
export const SCAN_ROOTS = [
  'src',
  'scripts',
  'apps/desktop/src',
  'apps/sidecar/src',
  'crates/daemon/src',
];

export const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-web',
  'target',
  'release',
  '.git',
  'coverage',
  'build',
]);

/** 该文件是否参与预算检查。 */
export function shouldCheckFile(relPath) {
  const budget = DEFAULT_BUDGETS[path.extname(relPath)];
  if (budget === undefined) return false;
  const segments = relPath.split(/[\\/]/);
  if (segments.some((segment) => IGNORED_DIRS.has(segment))) return false;
  // 测试文件常常是同目录里最大的那个，但它们不承担"模块边界"的角色，不设行数门禁。
  if (/\.test\.[tj]sx?$/.test(relPath)) return false;
  return true;
}

export function countLines(text) {
  if (text.length === 0) return 0;
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  // 末尾换行不算多一行。
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/**
 * 判定（纯函数，便于用例覆盖）。
 *
 * @param {{ files: Array<{ path: string, lines: number }>, baseline: Record<string, number>, budgets?: Record<string, number> }} input
 * @returns {{ violations: Array<{ path: string, lines: number, budget: number, kind: 'over-budget'|'baseline-growth' }>, entries: number }}
 */
export function evaluateSizeBudget({ files, baseline, budgets = DEFAULT_BUDGETS }) {
  const violations = [];

  for (const file of files) {
    const frozen = baseline[file.path];
    if (frozen !== undefined) {
      // 基线内：允许保持现状，但不许增长。
      if (file.lines > frozen) {
        violations.push({
          path: file.path,
          lines: file.lines,
          budget: frozen,
          kind: 'baseline-growth',
        });
      }
      continue;
    }

    const budget = budgets[path.extname(file.path)];
    if (budget !== undefined && file.lines > budget) {
      violations.push({ path: file.path, lines: file.lines, budget, kind: 'over-budget' });
    }
  }

  return { violations, entries: files.length };
}

/** 扫仓库，返回参与检查的文件与行数。 */
export function collectFiles(root = REPO_ROOT, roots = SCAN_ROOTS) {
  const files = [];

  const walk = (absDir) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (!shouldCheckFile(rel)) continue;
      files.push({ path: rel, lines: countLines(readFileSync(abs, 'utf8')) });
    }
  };

  for (const dir of roots) walk(path.join(root, dir));
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function loadBaseline(baselinePath = BASELINE_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
    return parsed.files ?? {};
  } catch {
    return {};
  }
}

/** 基线 = 当前所有超过默认预算的文件（冻结现状）。 */
export function buildBaseline(files, budgets = DEFAULT_BUDGETS) {
  const frozen = {};
  for (const file of files) {
    const budget = budgets[path.extname(file.path)];
    if (budget !== undefined && file.lines > budget) frozen[file.path] = file.lines;
  }
  return Object.fromEntries(Object.entries(frozen).sort(([a], [b]) => a.localeCompare(b)));
}

function writeBaseline(files) {
  const baseline = buildBaseline(files);
  const payload = {
    _comment:
      '冻结基线：这些文件当前超过默认预算，允许保持现状但**不允许再增长**（涨一行就失败）。'
      + '新增/收紧用 `node scripts/check-file-size-budget.mjs --update-baseline`。',
    files: baseline,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return Object.keys(baseline).length;
}

function formatViolation(violation) {
  const over = violation.lines - violation.budget;
  const advice = violation.kind === 'baseline-growth'
    ? `已在冻结基线内（${violation.budget} 行），现在 ${violation.lines} 行，涨了 ${over} 行：请先拆分再继续加。`
    : `超过预算 ${violation.budget} 行（现在 ${violation.lines} 行，多 ${over} 行）。`;
  return `- ${violation.path}：${advice}`;
}

function main(argv) {
  const updateBaseline = argv.includes('--update-baseline');
  const files = collectFiles();

  if (updateBaseline) {
    const count = writeBaseline(files);
    process.stdout.write(`[check:size] 已重写冻结基线：${count} 个文件\n`);
    return 0;
  }

  const baseline = loadBaseline();
  const { violations, entries } = evaluateSizeBudget({ files, baseline });

  if (violations.length > 0) {
    process.stderr.write(
      `[check:size] ${violations.length} 处行数预算违规（共检查 ${entries} 个文件）：\n`
      + `${violations.map(formatViolation).join('\n')}\n`
      + '提示：拆成更小的模块，或在**有意**放宽时跑 `--update-baseline`（评审里要说明理由）。\n',
    );
    return 1;
  }

  process.stdout.write(
    `[check:size] 通过：${entries} 个文件都在预算内（基线冻结 ${Object.keys(baseline).length} 个）。\n`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
