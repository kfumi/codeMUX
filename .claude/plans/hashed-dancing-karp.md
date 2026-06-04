# Codex 主题迁移计划

## Context

当前主题使用 amber（琥珀色，`38 92%`）作为 primary/accent 色，用户希望参考 OpenAI Codex 的视觉风格，将其替换为 Codex 的蓝色体系（`#339cff`）并优化整体色彩方案。Codex 风格特点：干净、极简、冷色调蓝为主。

## 改动范围

**仅需修改一个文件：`src/styles/globals.css`**

所有组件通过 `hsl(var(--primary))`、`hsl(var(--ring))` 等 CSS 变量引用颜色，无需改动任何 TSX 文件。

## Codex 主题色值映射

### Light Mode

| 变量 | 当前值 | 新值 | 说明 |
|------|--------|------|------|
| `--primary` | `38 92% 50%` (amber) | `210 100% 60%` (#339cff) | Codex 蓝 |
| `--ring` | `38 92% 50%` | `210 100% 60%` | 同 primary |
| `--sidebar-glow` | `38 92% 50%` | `210 100% 60%` | 同 primary |
| `--background` | `0 0% 100%` | `0 0% 100%` | 不变 |
| `--foreground` | `222.2 84% 4.9%` | `210 15% 11%` | Codex ink #1a1c1f |
| `--border` | `214.3 31.8% 91.4%` | `210 20% 90%` | 略微调整 |
| `--muted-foreground` | `215.4 16.3% 46.9%` | `210 12% 46%` | 略微调整 |
| 其他 | 不变 | 不变 | card/popover/secondary 等保持 |

### Dark Mode

| 变量 | 当前值 | 新值 | 说明 |
|------|--------|------|------|
| `--primary` | `38 92% 55%` (amber) | `210 100% 61%` (#339cff) | Codex 蓝 |
| `--ring` | `38 92% 55%` | `210 100% 61%` | 同 primary |
| `--sidebar-glow` | `38 92% 55%` | `210 100% 61%` | 同 primary |
| `--background` | `224 18% 6%` | `0 0% 9%` | Codex surface #181818 |
| `--card` | `224 18% 7%` | `0 0% 10%` | 稍亮于背景 |
| `--popover` | `224 18% 8%` | `0 0% 11%` | 再稍亮 |
| `--foreground` | `30 10% 90%` | `0 0% 100%` | Codex ink #ffffff |
| `--secondary` | `224 15% 14%` | `0 0% 14%` | 中性灰 |
| `--muted` | `224 15% 14%` | `0 0% 14%` | 中性灰 |
| `--muted-foreground` | `30 8% 55%` | `0 0% 55%` | 去掉暖色调 |
| `--border` | `224 12% 16%` | `0 0% 16%` | 中性灰 |
| `--sidebar-bg` | `224 18% 5.5%` | `0 0% 7%` | Codex 深色 |
| `--sidebar-fg` | `30 10% 80%` | `0 0% 80%` | 去暖 |
| `--sidebar-border` | `224 12% 11%` | `0 0% 11%` | 中性灰 |
| `--sidebar-muted` | `224 12% 9%` | `0 0% 9%` | 中性灰 |
| `--sidebar-accent` | `224 15% 13%` | `0 0% 13%` | 中性灰 |

### 硬编码色值（globals.css 内）

| 位置 | 当前值 | 新值 |
|------|--------|------|
| `.composer-glow::before` | `hsl(38 92% 55% / ...)` | `hsl(210 100% 61% / ...)` |
| `::selection` | `hsl(38 92% 55% / 0.25)` | `hsl(210 100% 61% / 0.25)` |

## 设计要点

1. **主色调替换**：amber → blue，所有 primary/ring/sidebar-glow 统一为 Codex 蓝
2. **Dark mode 去暖**：将所有 `224`（偏蓝灰）和 `30`（偏暖黄）色相的中性色统一为 `0`（纯灰），更接近 Codex 的冷峻中性风格
3. **对比度提升**：dark mode foreground 从 `90%` 提升到 `100%`（纯白），符合 Codex contrast: 60 的高对比设计
4. **Light mode 保守调整**：只改 primary 和 foreground，保持其余中性色不变

## 验证方式

1. `npm run dev` 启动应用
2. 切换 Light / Dark / System 主题，检查：
   - 侧边栏选中高亮、图标颜色
   - 按钮、链接、输入框 focus ring
   - Agent 面板 header、导航条激活态
   - 设置对话框、Dropdown 菜单
   - 代码高亮、Markdown 渲染
   - 编辑器 glow 效果
   - 文字选中颜色
