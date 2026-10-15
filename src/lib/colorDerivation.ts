/**
 * 颜色派生引擎 —— 对齐 Codex/ChatGPT 桌面端的主题模型。
 *
 * ## 模型
 *
 * 用户只调 4 个**种子**：`surface`（基础表面）/ `ink`（主文字）/ `accent`（强调色）/
 * `contrast`（0–100 的整体浓淡旋钮）。其余几十个语义色全部由算法派生，
 * 不再手挑色值 —— 换一次强调色，悬停底、焦点环、选中态、强调背景会一起变。
 *
 * 另有一小组**语义种子**（成功/警告/危险/diff 增删），它们是有意固定的颜色
 * （与 Codex 的 `semanticColors` 同构），不参与强调色联动。
 *
 * ## 算法来源
 *
 * `jba`（浅色）/ `Nba`（深色）的公式逐条照抄自 Codex 桌面包
 * （见 `docs/research/2026-10-14-codex-desktop-ui-design-system.md`）。
 * 两套函数结构对称，差别只在混色目标：浅色往 white 混，深色往 black/ink 混。
 * `colorDerivation.test.ts` 里有一份逐行转写的参考实现做对拍。
 *
 * ## 为什么派生值是「不透明色」而不是 `rgba()`
 *
 * CodeMUX 的消费约定是 `hsl(var(--token) / .6)` —— 三元组 + 调用点再叠 alpha，
 * 全仓数百处依赖这个形状。本引擎保持该约定不变：把 Codex 的
 * `rgba(ink, .06 + c*.04)` **在派生时就合成到 surface 上**，输出等价的不透明色。
 * 渲染结果与浏览器现场合成一致，但消费层一个字符都不用改。
 */

export interface Rgb {
  red: number;
  green: number;
  blue: number;
}

/** 派生层的输入：4 个种子。 */
export interface ThemeSeeds {
  /** 基础表面色，hex。浅色 `#fcfcfc` / 深色 `#111111`。 */
  surface: string;
  /** 主文字色，hex。浅色 `#0d0d0d` / 深色 `#ededed`。 */
  ink: string;
  /** 强调色，hex。Codex 默认 `#3a83f7`。 */
  accent: string;
  /** 0–100 的浓淡旋钮，驱动所有 alpha 步进。浅色默认 45 / 深色 60。 */
  contrast: number;
}

/**
 * 有意固定的语义色种子 —— 不参与强调色联动。
 * 与 Codex 的 `semanticColors`（diffAdded / diffRemoved / skill）同构。
 */
export interface SemanticSeeds {
  success: string;
  warning: string;
  destructive: string;
  /** diff 新增行色 —— 用户可配（按明暗各一套）。 */
  diffAdded: string;
  /** diff 删除行色 —— 用户可配（按明暗各一套）。 */
  diffRemoved: string;
}

export const CODEX_LIGHT_SEEDS: ThemeSeeds = {
  surface: '#fcfcfc',
  ink: '#0d0d0d',
  accent: '#3a83f7',
  contrast: 45,
};

/**
 * 深色种子。`surface` 是 `#111111` 而不是纯黑 —— 这是 Codex 的结构性要求，不是审美：
 * 窗口面（顶栏 + 图标轨）在 Codex 里**比表面再深一档**（`surfaceUnder` = 表面往黑混 16%），
 * 表面若压在 `#000000`，那一档就无处可退，窗口面、侧栏、内容面会全部塌成同一个黑，
 * 整扇窗失去「面板浮在窗框上」的层次。Codex 自己的深色默认是 `#181818`，
 * 用户在 Codex 里用的也是 `#111111` —— 取后者，与参考实现逐位对齐。
 */
export const CODEX_DARK_SEEDS: ThemeSeeds = {
  surface: '#111111',
  ink: '#ededed',
  accent: '#3a83f7',
  contrast: 60,
};

/** 语义种子按明暗各一套，与 seeds 一样由 `deriveThemeTokens` 按 isDark 选择。 */
export const SEMANTIC_SEEDS: { light: SemanticSeeds; dark: SemanticSeeds } = {
  light: {
    success: '#0f7a3d',
    warning: '#a16207',
    destructive: '#ba2623',
    diffAdded: '#00a240',
    diffRemoved: '#ba2623',
  },
  dark: {
    success: '#40c977',
    warning: '#e0a32e',
    destructive: '#fa423e',
    diffAdded: '#40c977',
    diffRemoved: '#fa423e',
  },
};

const WHITE: Rgb = { red: 255, green: 255, blue: 255 };
const BLACK: Rgb = { red: 0, green: 0, blue: 0 };

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 对比度旋钮归一化到 0..1，供所有 alpha 公式使用。 */
export function normalizeContrast(contrast: number): number {
  if (!Number.isFinite(contrast)) return 0;
  return clamp01(contrast / 100);
}

/** 逐通道线性混色 —— Codex 的 `eY`。 */
export function mixRgb(base: Rgb, target: Rgb, amount: number): Rgb {
  const a = clamp01(amount);
  const channel = (from: number, to: number) => Math.round(from + (to - from) * a);
  return {
    red: channel(base.red, target.red),
    green: channel(base.green, target.green),
    blue: channel(base.blue, target.blue),
  };
}

/**
 * Codex 把 alpha 写进 CSS 字符串时统一保留三位小数（`zba`），浏览器再按这个
 * **已截断**的值去合成。派生期若用全精度 alpha，会在 8bit 取整的边界上和浏览器
 * 差 1/255 —— 所以这里先把 alpha 截到三位，保持与 Codex 的实际渲染逐位一致。
 */
function roundAlpha(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}

/**
 * 把一层带透明度的颜色合成到底色上 —— 浏览器现场做的事，在派生期先做掉。
 * 这是「Codex 的 `rgba(ink, a)`」与「CodeMUX 的不透明 HSL 三元组」之间的桥。
 */
export function overlayRgb(base: Rgb, top: Rgb, alpha: number): Rgb {
  const a = roundAlpha(alpha);
  const channel = (b: number, t: number) => Math.round(t * a + b * (1 - a));
  return {
    red: channel(base.red, top.red),
    green: channel(base.green, top.green),
    blue: channel(base.blue, top.blue),
  };
}

export function hexToRgb(hex: string): Rgb {
  const normalized = hex.trim().replace(/^#/, '');
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : normalized;
  return {
    red: Number.parseInt(full.slice(0, 2), 16),
    green: Number.parseInt(full.slice(2, 4), 16),
    blue: Number.parseInt(full.slice(4, 6), 16),
  };
}

export function rgbToHex({ red, green, blue }: Rgb): string {
  const channel = (v: number) =>
    Math.min(255, Math.max(0, Math.round(v)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

export function rgbToHslTriplet(rgb: Rgb): string {
  const r = rgb.red / 255;
  const g = rgb.green / 255;
  const b = rgb.blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const round = (v: number) => Math.round(v * 100) / 100;
  return `${round(h)} ${round(s * 100)}% ${round(l * 100)}%`;
}

/** 自带 alpha 的 rgba() 字符串 —— 只给幕布用（它压在任意内容之上，不能预合成）。 */
export function cssRgba(rgb: Rgb, alpha: number): string {
  return `rgba(${rgb.red}, ${rgb.green}, ${rgb.blue}, ${roundAlpha(alpha)})`;
}

/** 派生结果 —— 内部沿用 Codex 的命名，只在映射成 CSS 变量名时才落到 CodeMUX 词汇。 */
export interface DerivedPalette {
  accentBackground: string;
  accentBackgroundActive: string;
  accentBackgroundHover: string;
  border: string;
  borderFocus: string;
  borderHeavy: string;
  borderLight: string;
  buttonPrimaryBackground: string;
  /** 窗口面 —— 顶栏与图标轨共用的那块底，Codex 的 `surfaceUnder`。 */
  chromeBackground: string;
  /** 窗口面上的悬停/选中档(导航栏的图标按钮)。 */
  chromeBackgroundHover: string;
  /**
   * 输入区顶部那条上下文条的底（发送框上方的一排：项目 / 工作树 / 分支）——
   * Codex 的 `--color-background-composer-action-bar`，公式是
   * `light ? surfaceUnder : elevatedSecondaryOpaque`：浅色取**窗口面**那一档
   * （往 ink 混 4%，Codex 实测 241），深色取抬高二档（实测 33）。
   */
  composerActionBarBackground: string;
  controlBackground: string;
  controlBackgroundOpaque: string;
  elevatedPrimary: string;
  elevatedPrimaryOpaque: string;
  elevatedSecondary: string;
  elevatedSecondaryOpaque: string;
  hoverSurface: string;
  iconAccent: string;
  iconPrimary: string;
  iconSecondary: string;
  iconTertiary: string;
  simpleScrim: string;
  /** 凹面 —— 比表面低一档的「画布」，Codex 的 `--color-surface-canvas`。 */
  surfaceCanvas: string;
  textAccent: string;
  textForeground: string;
  textForegroundSecondary: string;
  textForegroundTertiary: string;
}

/**
 * 窗口面（顶栏 + 左侧图标轨连成的那块底）—— Codex 的 `surfaceUnder`
 * （`Fba` = `Yba[variant] + (contrast - Kba[variant]) * Xba[variant]`）：
 * 浅色往 ink 混 4%，深色往黑混 16%，两套都是「比表面**再深**一档」。
 *
 * 这一档的意义是让侧栏与内容面「浮」在窗框之上：实测 Codex 深色（surface `#111111`）
 * 是 窗框 14 / 侧栏 16 / 内容 17，浅色是 窗框 245 / 侧栏 252 / 内容 253 —— 都是
 * 「窗框最深、面板更亮」。Codex 的窗口面本来还有 Mica 半透明背板这一层，
 * 我们把它归并进同一个公式：两套主题下它都是一个实心色，与面板的相对关系一致。
 */
function surfaceUnder(surface: Rgb, ink: Rgb, c: number, isDark: boolean): Rgb {
  return isDark
    ? mixRgb(surface, BLACK, 0.16 + (c - 0.6) * 0.0015)
    : mixRgb(surface, ink, 0.04 + (c - 0.45) * 0.0012);
}

/**
 * 凹面（画布）—— Codex 的 `--color-surface-canvas`：
 * `color-mix(in srgb, var(--color-surface) 98%, var(--black))`，即表面往黑走 2%。
 *
 * 用途是**给浮起的卡片当底**：Codex 的右侧面板主体就是它（浅色实测 250），
 * 面板里的卡片与标签页回到表面档（255），于是「卡片浮在面板上」读得出来。
 * 深色下 98% 只差不到 1 级（17 → 16.66，8bit 取整后仍是 17），与 Codex 深色一致 ——
 * 那一侧的分层靠描边与抬高档，不靠凹面。
 */
function surfaceCanvas(surface: Rgb): Rgb {
  return mixRgb(surface, BLACK, 0.02);
}

/**
 * 逐条照抄 Codex 的 `jba`（浅色）/ `Nba`（深色）。
 *
 * 与原函数的两处有意偏差：
 *  1. `textForeground` 少了「pinned dark 时改用 gray-fixed-150」的分支 —— 那是 Codex
 *     特有的「深色下强制亮色会话」功能，CodeMUX 没有对应概念。
 *  2. 输出统一成 hex 而不是 `rgba()` / `rgb()` 字符串：透明度在 `deriveThemeTokens`
 *     里按各自的底色合成掉，好让消费层继续用 `hsl(var(--x) / a)`。
 *
 * 另有一处**新增**（Codex 把它放在另一套变量里）：`chromeBackground` /
 * `chromeBackgroundHover` —— 窗口面，取上面那个 `surfaceUnder` 及其悬停档。
 * 少这一档的后果是实测出来的——顶栏、图标轨、侧栏、内容面会全部落在同一个值上，
 * 整扇窗看着是平的。
 */
export function derivePalette(seeds: ThemeSeeds, isDark: boolean): DerivedPalette {
  const surface = hexToRgb(seeds.surface);
  const ink = hexToRgb(seeds.ink);
  const accent = hexToRgb(seeds.accent);
  const c = normalizeContrast(seeds.contrast);

  if (isDark) {
    const accentLift = mixRgb(accent, WHITE, 0.3 + c * 0.15);
    const primaryFill = mixRgb(surface, WHITE, 0.38 + c * 0.12);
    const chrome = surfaceUnder(surface, ink, c, true);
    return {
      accentBackground: rgbToHex(mixRgb(BLACK, accent, 0.2 + c * 0.08)),
      accentBackgroundActive: rgbToHex(mixRgb(BLACK, accent, 0.22 + c * 0.12)),
      accentBackgroundHover: rgbToHex(mixRgb(BLACK, accent, 0.21 + c * 0.1)),
      border: rgbToHex(overlayRgb(surface, ink, 0.06 + c * 0.04)),
      borderFocus: rgbToHex(overlayRgb(surface, accentLift, 0.7 + c * 0.1)),
      borderHeavy: rgbToHex(overlayRgb(surface, ink, 0.12 + c * 0.06)),
      borderLight: rgbToHex(overlayRgb(surface, ink, 0.03 + c * 0.02)),
      buttonPrimaryBackground: rgbToHex(primaryFill),
      chromeBackground: rgbToHex(chrome),
      chromeBackgroundHover: rgbToHex(overlayRgb(chrome, ink, 0.05 + c * 0.03)),
      // Codex 深色下这条上下文条用的是 `elevatedSecondaryOpaque`，不是窗口面：
      // 深色的层次是「底 17 / 上下文条 32 / 输入框 45」，它夹在中间才读得出两级。
      composerActionBarBackground: rgbToHex(mixRgb(surface, ink, 0.04 + c * 0.05)),
      controlBackground: rgbToHex(overlayRgb(surface, mixRgb(surface, ink, 0.06 + c * 0.05), 0.96)),
      controlBackgroundOpaque: rgbToHex(mixRgb(surface, ink, 0.06 + c * 0.05)),
      elevatedPrimary: rgbToHex(overlayRgb(surface, mixRgb(surface, ink, 0.08 + c * 0.08), 0.96)),
      elevatedPrimaryOpaque: rgbToHex(mixRgb(surface, ink, 0.08 + c * 0.08)),
      elevatedSecondary: rgbToHex(overlayRgb(surface, ink, 0.02 + c * 0.02)),
      elevatedSecondaryOpaque: rgbToHex(mixRgb(surface, ink, 0.04 + c * 0.05)),
      hoverSurface: rgbToHex(mixRgb(surface, ink, 0.06 + c * 0.04)),
      iconAccent: rgbToHex(accentLift),
      iconPrimary: rgbToHex(overlayRgb(surface, ink, 0.82 + c * 0.14)),
      iconSecondary: rgbToHex(overlayRgb(surface, ink, 0.65 + c * 0.1)),
      iconTertiary: rgbToHex(overlayRgb(surface, ink, 0.45 + c * 0.1)),
      simpleScrim: rgbToHex(overlayRgb(surface, ink, 0.08 + c * 0.04)),
      surfaceCanvas: rgbToHex(surfaceCanvas(surface)),
      textAccent: rgbToHex(accentLift),
      textForeground: rgbToHex(ink),
      textForegroundSecondary: rgbToHex(overlayRgb(surface, ink, 0.65 + c * 0.1)),
      textForegroundTertiary: rgbToHex(overlayRgb(surface, ink, 0.42 + c * 0.13)),
    };
  }

  const chrome = surfaceUnder(surface, ink, c, false);

  return {
    accentBackground: rgbToHex(mixRgb(surface, accent, 0.11 + c * 0.04)),
    accentBackgroundActive: rgbToHex(mixRgb(surface, accent, 0.13 + c * 0.05)),
    accentBackgroundHover: rgbToHex(mixRgb(surface, accent, 0.12 + c * 0.045)),
    border: rgbToHex(overlayRgb(surface, ink, 0.06 + c * 0.04)),
    borderFocus: rgbToHex(accent),
    borderHeavy: rgbToHex(overlayRgb(surface, ink, 0.09 + c * 0.06)),
    borderLight: rgbToHex(overlayRgb(surface, ink, 0.04 + c * 0.02)),
    buttonPrimaryBackground: rgbToHex(ink),
    chromeBackground: rgbToHex(chrome),
    chromeBackgroundHover: rgbToHex(overlayRgb(chrome, ink, 0.08 + c * 0.04)),
    // 浅色下 Codex 这条上下文条取的是**窗口面**（`surfaceUnder`，往 ink 混 4%）：
    // 实测 241，比输入框（255）退两档、比输入框周围的页面（246–249）还低一档 ——
    // 读作「凹进页面里的一条」。之前按 `elevatedSecondaryOpaque`（98.82% = 252）
    // 取色，正好与页面底色撞在一起，整条因此在浅色下隐形。
    composerActionBarBackground: rgbToHex(chrome),
    controlBackground: rgbToHex(overlayRgb(surface, mixRgb(surface, WHITE, 0.09 + c * 0.04), 0.96)),
    controlBackgroundOpaque: rgbToHex(mixRgb(surface, WHITE, 0.09 + c * 0.04)),
    elevatedPrimary: rgbToHex(overlayRgb(surface, mixRgb(surface, WHITE, 0.16 + c * 0.12), 0.96)),
    elevatedPrimaryOpaque: rgbToHex(mixRgb(surface, WHITE, 0.16 + c * 0.12)),
    elevatedSecondary: rgbToHex(overlayRgb(surface, mixRgb(surface, WHITE, 0.08 + c * 0.08), 0.96)),
    elevatedSecondaryOpaque: rgbToHex(mixRgb(surface, WHITE, 0.08 + c * 0.08)),
    hoverSurface: rgbToHex(mixRgb(surface, ink, 0.04 + c * 0.02)),
    iconAccent: rgbToHex(accent),
    iconPrimary: rgbToHex(ink),
    iconSecondary: rgbToHex(overlayRgb(surface, ink, 0.65 + c * 0.1)),
    iconTertiary: rgbToHex(overlayRgb(surface, ink, 0.45 + c * 0.1)),
    simpleScrim: rgbToHex(overlayRgb(surface, BLACK, 0.08 + c * 0.04)),
    surfaceCanvas: rgbToHex(surfaceCanvas(surface)),
    textAccent: rgbToHex(accent),
    textForeground: rgbToHex(ink),
    textForegroundSecondary: rgbToHex(overlayRgb(surface, ink, 0.65 + c * 0.1)),
    textForegroundTertiary: rgbToHex(overlayRgb(surface, ink, 0.45 + c * 0.1)),
  };
}

/**
 * 派生键 → CSS 变量名。`Opaque` 孪生键落在 `--x-opaque` 上：
 * 半透明的那份给「浮在面板之上、背后有内容」的场合，不透明的那份给实心面板。
 *
 * 这里只列**真正被消费的**键；`-opaque` 孪生档与个别「尚未接线」的键在
 * `deriveThemeTokens` 里显式补上，避免它们成为「派生出来但没人用」的暗桩。
 */
const DERIVED_CSS_VARIABLES: Partial<Record<keyof DerivedPalette, string>> = {
  accentBackground: '--accent-bg',
  border: '--border',
  borderFocus: '--ring',
  borderHeavy: '--surface-edge',
  chromeBackground: '--chrome-bg',
  chromeBackgroundHover: '--chrome-bg-hover',
  composerActionBarBackground: '--composer-action-bar-bg',
  surfaceCanvas: '--surface-canvas',
  controlBackground: '--muted',
  elevatedPrimary: '--card',
  elevatedSecondary: '--secondary',
  hoverSurface: '--surface-3',
  iconAccent: '--sidebar-accent',
  textAccent: '--codemux-link',
  textForeground: '--foreground',
  textForegroundSecondary: '--muted-foreground',
  textForegroundTertiary: '--foreground-tertiary',
};

/**
 * 把派生结果落成 CodeMUX 的 CSS 变量表：变量名不变，值全部是 HSL 三元组。
 *
 * 消费约定 `hsl(var(--token) / .6)` 因此原样继续工作 —— 全仓数百处引用零改动。
 *
 * 语义色(diff / 状态)不进派生公式，直接取固定种子：它们是「这套设计语言的常量」，
 * 不是跟随强调色或对比度变化的旋钮。之前留过一个用户覆盖口子让外观页能改 diff
 * 增删色，那个入口已经移除，这里也就不再有覆盖参数。
 */
export function deriveThemeTokens(seeds: ThemeSeeds, isDark: boolean): Record<string, string> {
  const palette = derivePalette(seeds, isDark);
  const tokens: Record<string, string> = {};

  for (const [key, cssVar] of Object.entries(DERIVED_CSS_VARIABLES) as [
    keyof DerivedPalette,
    string | undefined,
  ][]) {
    if (cssVar) tokens[cssVar] = rgbToHslTriplet(hexToRgb(palette[key]));
  }

  const surface = hexToRgb(seeds.surface);
  const ink = hexToRgb(seeds.ink);
  const accent = hexToRgb(seeds.accent);
  const semantic = isDark ? SEMANTIC_SEEDS.dark : SEMANTIC_SEEDS.light;
  const set = (name: string, rgb: Rgb) => {
    tokens[name] = rgbToHslTriplet(rgb);
  };

  set('--background', surface);
  set('--card-foreground', ink);
  set('--popover', hexToRgb(palette.elevatedPrimary));
  set('--popover-foreground', ink);
  set('--primary', accent);
  set('--secondary-foreground', ink);
  set('--accent', hexToRgb(palette.accentBackground));
  set('--accent-foreground', ink);
  set('--destructive', hexToRgb(semantic.destructive));
  set('--destructive-foreground', surface);
  set('--success', hexToRgb(semantic.success));
  set('--warning', hexToRgb(semantic.warning));
  // diff 增删与状态色分开：状态色是「MCP 连上了 / 任务完成了」这类语义，
  // diff 色是「这一行代码是新增/删除」。分开才能让用户只改 diff 的观感。
  set('--diff-added', hexToRgb(semantic.diffAdded));
  set('--diff-removed', hexToRgb(semantic.diffRemoved));
  set('--input', hexToRgb(palette.border));
  set('--glow', accent);

  // 阴影色永远是黑：alpha 由调用点叠加（Codex 的浮起靠描边 + 超大 spread 低透明度，
  // 不靠浓重的黑色投影 —— 见 elevation 体系）。
  set('--surface-shadow', BLACK);
  set('--surface-shadow-strong', BLACK);
  set('--layout-divider', hexToRgb(palette.border));

  set('--surface-1', hexToRgb(palette.elevatedPrimaryOpaque));
  set('--surface-2', hexToRgb(palette.elevatedSecondaryOpaque));
  // `-opaque` 孪生档也要有静态兜底，否则 JS 跑起来之前它们是无效值。
  set('--card-opaque', hexToRgb(palette.elevatedPrimaryOpaque));
  set('--muted-opaque', hexToRgb(palette.controlBackgroundOpaque));
  set('--secondary-opaque', hexToRgb(palette.elevatedSecondaryOpaque));
  set('--border-light', hexToRgb(palette.borderLight));
  set('--icon-secondary', hexToRgb(palette.iconSecondary));
  set('--icon-tertiary', hexToRgb(palette.iconTertiary));
  set('--accent-bg-hover', hexToRgb(palette.accentBackgroundHover));
  set('--accent-bg-active', hexToRgb(palette.accentBackgroundActive));

  // 指令 chip 跟着强调色走（原先是一组写死的蓝色，不随主题）。
  set('--codemux-directive-accent', hexToRgb(palette.textAccent));
  set('--codemux-directive-bg', hexToRgb(palette.accentBackground));
  set('--codemux-directive-border', hexToRgb(palette.border));

  // 幕布压在任意内容之上，预合成到 surface 会失真，所以它是唯一自带 alpha 的变量：
  // 使用时直接写 `background: var(--scrim)`，**不要**再套 `hsl(...) / a`。
  // 颜色随主题翻面（浅色压黑、深色压白），与 Codex 的 simpleScrim 一致 —— 直接取
  // 派生结果里那个 rgba 字符串，不在这里重算一遍公式。
  tokens['--scrim'] = cssRgba(
    isDark ? ink : BLACK,
    0.08 + normalizeContrast(seeds.contrast) * 0.04,
  );

  set('--sidebar-bg', surface);
  set('--sidebar-fg', ink);
  set('--sidebar-border', hexToRgb(palette.border));
  // 侧栏的「选中 / 悬停」面用 ink 方向的加色（hoverSurface），**不是**
  // elevatedSecondary —— 浅色下后者与 surface 混到同一个 8bit 值，选中态会
  // 完全看不见。这是实测发现的：Codex 的 hover 公式（ink 的 .04+c*.02）在
  // 近白表面上才留得住差异。
  set('--sidebar-muted', hexToRgb(palette.hoverSurface));
  set('--sidebar-glow', accent);
  set('--surface-glow', accent);
  set('--settings-sidebar-bg', surface);
  set('--shell-bg', surface);

  // 主按钮：浅色是墨底反白字（Codex 的 buttonPrimaryBackground = ink）；
  // 深色下 Codex 的主按钮是「浅灰描边」样式，而 CodeMUX 的 `bg-primary` 是实心强调色
  // 按钮，所以前景取 surface 的反相（白），而不是照抄 Codex 的 `tY(r)` 浅灰 ——
  // 后者压在强调色上只有约 2.5:1，远低于正文所需的 4.5:1。
  set('--primary-foreground', isDark ? WHITE : surface);

  return tokens;
}