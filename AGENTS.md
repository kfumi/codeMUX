# Repository Guidelines

## Project Structure & Module Organization

codeMUX is a Tauri 2 desktop app: React/Vite frontend, Rust backend, and TypeScript sidecar.

- `src/` contains frontend components, stores, utilities, types, hooks, styles, and tests.
- `src-tauri/src/` contains Rust commands, config, database, MCP, skills, and agent runtimes.
- `src-tauri/sidecar/` contains the Node/TypeScript agent sidecar.
- `public/` and `src-tauri/icons/` hold static web and app assets.
- `docs/` contains architecture specs and plans.

## Build, Test, and Development Commands

- `npm ci` installs root dependencies.
- `cd src-tauri/sidecar && npm ci` installs sidecar dependencies.
- `npm run dev` starts the Vite frontend on port 1420.
- `npm run tauri dev` runs the desktop app in development mode.
- `npm run build` type-checks `src/` and builds the Vite app.
- `cd src-tauri/sidecar && npm run build` compiles sidecar TypeScript.
- `cd src-tauri && cargo fmt --all -- --check` verifies Rust formatting.
- `cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings` runs Rust lints.
- `cd src-tauri && cargo check --all-targets --all-features` checks Rust compilation.
- `npx vitest run` runs root TypeScript/React tests; run the same command in `src-tauri/sidecar/` for sidecar tests.

## Coding Style & Naming Conventions

Follow `.editorconfig`: spaces, LF endings, UTF-8, final newline, 2-space indentation for TypeScript/JSON/TOML/YAML, and 4-space indentation for Rust. Use strict TypeScript and the `@/*` import alias. Prefer functional React components, hooks, Zustand state, and Tailwind/CSS variables. Use `PascalCase` for components, `camelCase` for functions and variables, and `snake_case` for Rust modules.

For UI work, prefer existing components in `src/components/ui/` (shadcn/ui built on Radix UI) before creating custom controls or raw HTML elements. Use their variants and sizes, such as `Button` with `variant="ghost"`, whenever they fit the interaction.

## Testing Guidelines

Tests use Vitest and Testing Library. Name tests `*.test.ts` or `*.test.tsx` and colocate them near covered code. Add focused tests for stores, parsing, sidecar transforms, Rust-adjacent TypeScript behavior, and React behavior. Keep tests deterministic; avoid local paths unless path handling is under test.

## Commit & Pull Request Guidelines

Use Conventional Commits, matching project history: `feat: ...`, `fix(agent): ...`, `docs(readme): ...`, `chore(deps): ...`. Common scopes include `agent`, `mcp`, `skills`, `ui`, `store`, `db`, `sidecar`, and `config`.

Pull requests should include a summary, linked issues when applicable, change type, test results, and screenshots for UI changes. Before opening a PR, confirm the relevant build, Vitest, Rust formatting, clippy, and manual `npm run tauri dev` checks.

## Security & Configuration Tips

Do not commit local credentials, API keys, generated logs, or machine-specific configuration. Keep provider, MCP, and agent settings changes documented when they affect runtime behavior.

## assistant-ui

This project uses assistant-ui for chat interfaces.

Documentation: https://www.assistant-ui.com/llms-full.txt

Key patterns:
- Use AssistantRuntimeProvider at the app root
- Thread component for full chat interface
- AssistantModal for floating chat widget
- useChatRuntime hook with AI SDK transport
