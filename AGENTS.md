# Repository Guidelines

## Project Structure & Module Organization

CodeMUX is a local-first desktop app: an Electron shell (supervisor), a standalone Rust daemon (`codemux-daemon`), one React/Vite unified frontend, a Node/TypeScript agent sidecar, and a local CLI. The daemon is the authority (SQLite, sessions, agents, sidecar, MCP, skills, scheduled tasks); the shell only owns windows, tray, notifications, updates, and the Browser Host. Clients (desktop renderer, PC browser, mobile browser, CLI) talk to the daemon exclusively via the loopback Companion REST/WS protocol (`docs/adr/0011-daemon-authority-local-token.md`, `docs/adr/0012-daemon-process-electron-shell.md`).

- `src/` contains frontend (renderer) components, stores, utilities, types, hooks, styles, and tests.
- `apps/desktop/` contains the Electron shell (`src/`: main, preload, supervisor, browser host, updater; `scripts/`: dev and packaging helpers; `build/icons/`: installer & tray icons).
- `crates/daemon/` is the Rust **daemon crate** (the Tauri shell has been removed; the directory was renamed from `src-tauri/` in 2026-09): `src/bin/codemux-daemon.rs` entry, `src/daemon/` assembly, `src/companion/` HTTP/WS server, `src/agent/` session lifecycle and history, `src/agent_runtime/` Claude/Codex/OpenCode/pi runtimes, plus config, db, mcp, skills, model_providers, scheduled_tasks.
- `apps/sidecar/` contains the Node/TypeScript agent sidecar (moved out of the daemon crate — it is an independent package).
- There is no separate mobile frontend: `src/` is the single frontend for all three hosts (Electron shell, PC browser, mobile browser). `npm run build:web` emits `dist-web/`, which the desktop app ships and the daemon serves to browser clients.
- `apps/cli/` contains the local CLI daemon client.
- `public/` holds static web assets; `apps/desktop/build/icons/` holds installer and tray icons.
- `docs/` is the single home for all project documentation (see next section).

## Documentation Layout

All project documents live under `docs/`. Whatever agent you are (pi, trae, zcode, claude, codex, opencode), write documents to the authoritative paths below — **these override any global skill defaults** (e.g. the global `brainstorming`/`writing-plans` skills default to `docs/superpowers/`, which is retired).

| Directory | Purpose | Naming |
|---|---|---|
| `docs/adr/` | Architecture decision records | `NNNN-slug.md`, sequential (highest existing +1) |
| `docs/specs/` | Design docs / requirement specs (what & why) | `YYYY-MM-DD-<slug>.md` |
| `docs/plans/` | Implementation plans (how, step by step) | `YYYY-MM-DD-<slug>.md` |
| `docs/tickets/` | Work tickets, grouped per feature | `tickets/<feature-slug>/<NN>-<slug>.md`, NN from 01 |
| `docs/research/` | Research notes, root-cause investigations | `YYYY-MM-DD-<slug>.md` |
| `docs/guides/` | Long-lived usage / operations guides | `<topic>-guide.md`, kebab-case |

- `<slug>` is English kebab-case; the Chinese title goes in the document H1.
- Use the same `<slug>` for a feature's spec / plan / tickets.
- Authoritative write-paths: brainstorming → `docs/specs/`; writing-plans → `docs/plans/`; to-tickets & wayfinder tickets → `docs/tickets/<feature-slug>/`; wayfinder maps → `docs/plans/YYYY-MM-DD-<effort>-map.md`; research → `docs/research/`.
- Retired paths — never write or reference them again: `docs/superpowers/`, `.scratch/`, `.pi/plan/`, `.zcode/plans/`, `.trae/specs/`, `.trae/documents/`.
- When adding or moving a document, update the index in `docs/README.md` in the same change.

## Build, Test, and Development Commands

- `npm ci` installs root dependencies.
- `cd apps/sidecar && npm ci` installs sidecar dependencies.
- `npm run dev` starts the Vite renderer on port 1420.
- `npm run dev:desktop` runs the desktop app in development mode: waits for Vite to be ready, then launches the Electron shell; the daemon is spawned by the shell's supervisor. Exit cleans up all child processes.
- `npm run dev:electron` launches only the Electron shell (renderer must already be up on 1420).
- `npm run build` type-checks `src/` and builds the Vite app.
- `npm run build:daemon` (and `build:daemon:release`) builds the `codemux-daemon` binary.
- `npm run build:electron-installer` builds the renderer + shell and packs the NSIS installer into `apps/desktop/release/` (see `docs/guides/desktop-release-guide.md`).
- `npm run build:web` builds the unified frontend into `dist-web/`; the daemon serves that directory to browser clients and the installer bundles it.
- `cd apps/sidecar && npm run build` compiles sidecar TypeScript. The desktop app loads `sidecar/dist/` at runtime. `npm run dev:desktop` does not build unconditionally: it compares the newest `apps/sidecar/src/**` mtime against `dist/index.js` and runs `build:sidecar` only when the source is newer (~60 ms when fresh, 3–5 s when it has to build); `npm run build:electron-installer` always builds it. When you launch Electron another way (`npm run dev:electron` against an already-running daemon), run `npm run build:sidecar` yourself or the app silently runs stale code.
- `cd apps/desktop && npm run typecheck` type-checks the shell's main/preload TypeScript.
- `cd crates/daemon && cargo fmt --all -- --check` verifies Rust formatting.
- `cd crates/daemon && cargo clippy --all-targets --all-features -- -D warnings` runs Rust lints.
- `cd crates/daemon && cargo check --all-targets --all-features` checks Rust compilation.
- `npx vitest run` runs root TypeScript/React tests; run the same command in `apps/sidecar/` for sidecar tests.

### Rust daemon changes — always rebuild

After any change under `crates/daemon/` (Rust source or `Cargo.toml`), run `npm run build:daemon` as the finishing step of the change — do not leave it to the user.

- The dev shell spawns the daemon from `crates/daemon/target/debug/codemux-daemon(.exe)` (see `resolveDaemonExe` in `apps/desktop/src/main.ts`); the running daemon is never hot-reloaded, so a stale binary silently serves old behavior in `dev:desktop`.
- After rebuilding, the daemon must be restarted to pick up the new binary: restart `npm run dev:desktop`, or stop the daemon and let the shell's supervisor respawn it.
- If release behavior matters (packaging, installer), verify with `npm run build:daemon:release`.

### Sidecar packaging

Sidecar uses plain `tsc`; the installer ships **only** `sidecar/dist/`, not `node_modules` (see `apps/desktop/electron-builder.yml`).

- Do **not** add runtime packages to `apps/sidecar/package.json` `dependencies` — dev works, release fails with `ERR_MODULE_NOT_FOUND`.
- Reuse frontend logic by inlining in sidecar; do not import from `src/`. Provider SDKs load from managed Runtime (`%LOCALAPPDATA%/CodeMUX/runtimes/`), not sidecar deps.
- Need a real npm dep? Bundle it (e.g. esbuild) and update packaging config — or verify with a release build; `dev:desktop` won't catch this.

## Coding Style & Naming Conventions

Follow `.editorconfig`: spaces, LF endings, UTF-8, final newline, 2-space indentation for TypeScript/JSON/TOML/YAML, and 4-space indentation for Rust. Use strict TypeScript and the `@/*` import alias. Prefer functional React components, hooks, Zustand state, and Tailwind/CSS variables. Use `PascalCase` for components, `camelCase` for functions and variables, and `snake_case` for Rust modules.

For UI work, prefer existing components in `src/components/ui/` (shadcn/ui built on Radix UI) before creating custom controls or raw HTML elements. Use their variants and sizes, such as `Button` with `variant="ghost"`, whenever they fit the interaction.

### UI Theming & Typography

The app's appearance is user-configurable at runtime (theme, accent color, UI font family, UI/code font sizes, corner radius, content width) via `src/stores/appearanceStore.ts`, which writes CSS variables defined in `src/styles/globals.css`. Components must consume these tokens so new UI follows the user's appearance settings instead of fighting them. Tooltips should use the shared `TooltipHint` component rather than ad hoc `title` attributes or one-off tooltip implementations.

**Colors — always semantic tokens, never hard-coded palette values:**

- Use the mapped Tailwind utilities: `bg-background`, `text-foreground`, `text-muted-foreground`, `bg-card`, `bg-primary`, `text-primary-foreground`, `bg-secondary`, `text-destructive`, `text-success`, `text-warning`, `border-border`, etc.
- Do NOT use hard-coded palette colors (`text-slate-500`, `bg-blue-600`, raw `#hex` or `hsl(...)` values) in component styles. They break dark mode and the user's accent-color setting.
- Exception: content that is inherently colored (syntax highlighting, diff added/removed lines, accent swatches) may use fixed colors if they are intentional and work in both light and dark modes.
- For layered surfaces use the existing classes (`surface-panel`, `surface-panel-muted`, `surface-interactive`) or `hsl(var(--surface-1|2|3))` — do not invent new grays.

**Text contrast — two tiers, no ad-hoc alpha:**

- 文字颜色只有两档:主文字用 `text-foreground`(标题、标签、值、表格/日志正文),次级文字用 `text-muted-foreground`(说明、提示、时间戳、元信息、空状态)。层次靠字号(`text-ui-*`)与字重表达,不靠透明度。
- 不要在文字上写 `text-foreground/45`、`text-muted-foreground/70` 这类透明度后缀。实测(浅色主题白底):`text-foreground/45` = 2.87:1、`/38` = 2.36:1、`/24` = 1.67:1、`text-muted-foreground/70` = 2.96:1,全部低于 WCAG AA 正文所需的 4.5:1;改成两档后为 17.2:1 / 5.5:1(暗色主题 17.8:1 / 8.0:1)。
- 透明度只用于**表面层次**:背景(`bg-foreground/4`)、描边、分隔线、滚动条。语义色(`text-destructive`、`text-success`、`text-warning`、`text-primary`)按语义直接使用,不要叠加透明度。
- 例外(可以更浅):禁用态(`disabled:opacity-*`)、输入框占位符、纯装饰性图标(空状态大图标除外,它承载信息)。

**Font family:**

- New UI must inherit the global font family from `var(--font-ui)` (Tailwind `font-sans` is mapped to it); do not hard-code a font family unless the content is intentionally code.

**Font sizes — always the dynamic scale, never absolute values:**

- Use the dynamic typography utilities (`text-ui-micro`, `text-ui-caption`, `text-ui-meta`, `text-ui-compact`, `text-ui-body`, `text-ui-title`, `text-ui-heading-sm/md/lg`) so text follows the user's global interface font-size setting.
- Avoid hard-coded text sizes such as `text-[11px]` or inline `font-size` in UI components. The Tailwind `text-xs` through `text-3xl` utilities are also mapped to the global UI scale and may be used where their semantic size fits.
- For code, paths, and numeric diff statistics that intentionally use the code style, use `font-mono text-code` so they follow the global code-font-size setting.

**Corner radius:**

- Use Tailwind `rounded-sm|md|lg|xl|2xl`, which derive from the user's radius preference via `--radius`. Do not hard-code `border-radius` or `rounded-[Npx]` values.

**When a token is missing:**

- If a new semantic token is genuinely needed, add it to `@theme` plus `:root` and `.dark` in `src/styles/globals.css` and consume the generated utility — do not inline per-component values.

## Testing Guidelines

Tests use Vitest and Testing Library. Name tests `*.test.ts` or `*.test.tsx` and colocate them near covered code. Add focused tests for stores, parsing, sidecar transforms, Rust-adjacent TypeScript behavior, and React behavior. Keep tests deterministic; avoid local paths unless path handling is under test. Whenever you modify code, add or update the colocated tests that cover it.

**Test selection — run affected tests during iteration, full suite at the gate:**

- After each code change, run the *affected* tests rather than the full suite (147 test files; a full run takes minutes). The affected set is the colocated test of each changed file plus the tests of any module that (transitively) imports the changed module. Pass vitest file filters, e.g. `npx vitest run src/lib/modelProviders`, or use `npx vitest` watch mode, which reruns only tests related to saved changes.
- Do not rely solely on a changed file's own test: cross-module regressions (e.g. changing a store breaks component tests elsewhere) are caught only by including dependent tests or the full suite.
- Run the full suite before committing or opening a PR: `npx vitest run` at the repo root and `npx vitest run` in `apps/sidecar/`. A full-suite pass is the finishing gate, not the per-iteration default.
- The browser/mobile hosts load `dist-web/`, which is only refreshed by `npm run build:web`. Browser-visible renderer changes do not take effect in the daemon-served page until you rebuild it.

## Commit & Pull Request Guidelines

Use Conventional Commits, matching project history: `feat: ...`, `fix(agent): ...`, `docs(readme): ...`, `chore(deps): ...`. Common scopes include `agent`, `mcp`, `skills`, `ui`, `store`, `db`, `sidecar`, and `config`.

Pull requests should include a summary, linked issues when applicable, change type, test results, and screenshots for UI changes. Before opening a PR, confirm the relevant build, Vitest, Rust formatting, clippy, and manual `npm run dev:desktop` checks.

## Security & Configuration Tips

Do not commit local credentials, API keys, generated logs, or machine-specific configuration. Keep provider, MCP, and agent settings changes documented when they affect runtime behavior. Auth between shell/CLI/mobile and the daemon uses the Local Daemon Token (loopback) and Pairing Tokens (paired devices) — never log or commit them.

## assistant-ui

This project uses assistant-ui for chat interfaces.

Documentation: https://www.assistant-ui.com/llms-full.txt

Key patterns:
- Use AssistantRuntimeProvider at the app root
- Thread component for full chat interface
- AssistantModal for floating chat widget
- useChatRuntime hook with AI SDK transport
