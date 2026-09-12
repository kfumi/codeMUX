# Repository Guidelines

## Project Structure & Module Organization

CodeMUX is a local-first desktop app: an Electron shell (supervisor), a standalone Rust daemon (`codemux-daemon`), a React/Vite renderer, a Node/TypeScript agent sidecar, a mobile companion PWA, and a local CLI. The daemon is the authority (SQLite, sessions, agents, sidecar, MCP, skills, scheduled tasks); the shell only owns windows, tray, notifications, updates, and the Browser Host. Clients (renderer, mobile, CLI) talk to the daemon exclusively via the loopback Companion REST/WS protocol (`docs/adr/0011-daemon-authority-local-token.md`, `docs/adr/0012-daemon-process-electron-shell.md`).

- `src/` contains frontend (renderer) components, stores, utilities, types, hooks, styles, and tests.
- `desktop-electron/` contains the Electron shell (`src/`: main, preload, supervisor, browser host, updater; `scripts/`: dev and packaging helpers).
- `src-tauri/` is the Rust **daemon crate** (directory name kept for history; the Tauri shell has been removed): `src/bin/codemux-daemon.rs` entry, `src/daemon/` assembly, `src/companion/` HTTP/WS server, `src/agent/` session lifecycle and history, `src/agent_runtime/` Claude/Codex/OpenCode/pi runtimes, plus config, db, mcp, skills, model_providers, scheduled_tasks.
- `src-tauri/sidecar/` contains the Node/TypeScript agent sidecar.
- `src-mobile/` contains the mobile companion web app (its own Vite build and tests); it is embedded into the desktop app via `npm run build:mobile`.
- `src-cli/` contains the local CLI daemon client.
- `public/` and `src-tauri/icons/` hold static web and app assets.
- `docs/` contains architecture specs, ADRs, and plans.

## Build, Test, and Development Commands

- `npm ci` installs root dependencies.
- `cd src-tauri/sidecar && npm ci` installs sidecar dependencies.
- `npm run dev` starts the Vite renderer on port 1420.
- `npm run dev:desktop` runs the desktop app in development mode: waits for Vite to be ready, then launches the Electron shell; the daemon is spawned by the shell's supervisor. Exit cleans up all child processes.
- `npm run dev:electron` launches only the Electron shell (renderer must already be up on 1420).
- `npm run build` type-checks `src/` and builds the Vite app.
- `npm run build:daemon` (and `build:daemon:release`) builds the `codemux-daemon` binary.
- `npm run build:electron-installer` builds the renderer + shell and packs the NSIS installer into `desktop-electron/release/` (see `docs/desktop-release-guide.md`).
- `npm run build:mobile` builds `src-mobile/` (installs deps, runs `tsc && vite build`) and copies the output to `dist-mobile/`, which the desktop app loads.
- `cd src-tauri/sidecar && npm run build` compiles sidecar TypeScript. The desktop app loads `sidecar/dist/` at runtime; dev and release flows rebuild it automatically via `npm run build:sidecar`. After editing sidecar source without going through those commands, rebuild manually or the app runs stale code.
- `cd desktop-electron && npm run typecheck` type-checks the shell's main/preload TypeScript.
- `cd src-tauri && cargo fmt --all -- --check` verifies Rust formatting.
- `cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings` runs Rust lints.
- `cd src-tauri && cargo check --all-targets --all-features` checks Rust compilation.
- `npx vitest run` runs root TypeScript/React tests; run the same command in `src-tauri/sidecar/` for sidecar tests and in `src-mobile/` for mobile tests.

### Rust daemon changes — always rebuild

After any change under `src-tauri/` (Rust source or `Cargo.toml`), run `npm run build:daemon` as the finishing step of the change — do not leave it to the user.

- The dev shell spawns the daemon from `src-tauri/target/debug/codemux-daemon(.exe)` (see `resolveDaemonExe` in `desktop-electron/src/main.ts`); the running daemon is never hot-reloaded, so a stale binary silently serves old behavior in `dev:desktop`.
- After rebuilding, the daemon must be restarted to pick up the new binary: restart `npm run dev:desktop`, or stop the daemon and let the shell's supervisor respawn it.
- If release behavior matters (packaging, installer), verify with `npm run build:daemon:release`.

### Sidecar packaging

Sidecar uses plain `tsc`; the installer ships **only** `sidecar/dist/`, not `node_modules` (see `desktop-electron/electron-builder.yml`).

- Do **not** add runtime packages to `src-tauri/sidecar/package.json` `dependencies` — dev works, release fails with `ERR_MODULE_NOT_FOUND`.
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
- Run the full suite before committing or opening a PR: `npx vitest run` at the repo root and `npx vitest run` in `src-tauri/sidecar/`. A full-suite pass is the finishing gate, not the per-iteration default.
- If you modify code under `src-mobile/`, run its tests (`npx vitest run` in `src-mobile/`) and then run `npm run build:mobile`. The desktop app loads `dist-mobile/`, which is only refreshed by that build — mobile changes do not take effect otherwise.

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
