# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CodeMUX is a Tauri 2 desktop app that provides a unified interface for multiple AI coding agents (Claude Code, OpenAI Codex, and more planned). It has three layers: a React/Vite frontend, a Rust backend, and a Node.js sidecar that wraps the agent SDKs.

## Common Commands

### Frontend (root)
```bash
npm ci                              # Install dependencies
npm run dev                         # Vite dev server on port 1420
npm run build                       # tsc type-check + Vite production build
npx vitest run                      # Run all TS/React tests
```

### Desktop App (full stack)
```bash
npm run tauri dev                   # Vite + Rust + sidecar in dev mode
npm run tauri build                 # Production desktop build (MSI/NSIS/DMG/deb)
```

### Sidecar (`src-tauri/sidecar/`)
```bash
cd src-tauri/sidecar && npm ci && npm run build   # Install + compile sidecar TypeScript
cd src-tauri/sidecar && npx vitest run             # Run sidecar tests
```

### Rust Backend (`src-tauri/`)
```bash
cd src-tauri && cargo check --all-targets --all-features        # Compilation check
cd src-tauri && cargo fmt --all -- --check                      # Formatting check
cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings  # Lint
```

### Single Test
```bash
npx vitest run src/stores/agentStore.test.ts       # Run a specific test file
npx vitest run -t "test name pattern"               # Run tests matching a name
```

## Architecture

### Three-Layer Communication Flow

```
React Frontend  ──Tauri IPC (invoke/Channel)──▶  Rust Backend  ──stdin/stdout JSON lines──▶  Node.js Sidecar
       ▲                                              │                                              │
       └──────── Channel<string> (streaming events) ──┘──────────────────────────────────────────────┘
```

- **Frontend → Rust:** `invoke()` calls, typed wrappers in `src/lib/tauri.ts` (`agentApi`, `sessionApi`, `configApi`, `fileApi`, `mcpApi`, `skillApi`, `projectApi`, `appApi`)
- **Rust → Sidecar:** JSON lines over stdin/stdout, sidecar manages agent SDK lifecycle
- **Streaming:** `Channel<string>` streams real-time agent events from Rust to frontend

### Key Frontend Patterns

- **State:** All state in Zustand stores (`src/stores/`). Each domain has its own store: `agentStore`, `sessionStore`, `settingsStore`, `projectStore`, `mcpStore`, `skillStore`, `previewStore`, `newSessionStore`.
- **Layout:** Three-panel — `Sidebar` (sessions) | main content (`AgentPanel` or `NewSessionPanel`) | `PreviewPanel` (files/diff). All lazy-loaded.
- **Agent UI:** `CodeMuxAssistantRuntime` bridges agent events to `@assistant-ui/react` library. The runtime adapter lives in `src/components/agent/assistant-ui/`.
- **Path alias:** `@/` maps to `./src/` — use this for all imports within `src/`.
- **Custom titlebar:** Tauri `decorations: false`, rendered by `TitleBar` component.

### Multi-Agent System

Agent backends are registered in `src/types/agentRegistry.ts`. Each agent kind (`claude_code`, `codex`, etc.) has:
- A Rust runtime in `src-tauri/src/agent_runtime/` (factory pattern)
- Capability flags in the registry (resume, tools, cost tracking, MCP support, etc.)
- An MCP adapter in `src-tauri/src/mcp/` for agent-specific config formats

### Data Storage

- **SQLite** (rusqlite, bundled) — sessions, messages, tool calls, MCP servers, skills
- **Config file** (`config.json`) — provider settings, app preferences
- **Dual-write:** MCP server configs go to both SQLite and `~/.claude.json` for Claude CLI compatibility
- **Skills:** Installed to `~/.claude/skills/` on disk, metadata tracked in SQLite

### UI Components

- Base components in `src/components/ui/` are from **shadcn/ui** (Radix UI + Tailwind + CSS variables)
- Add new shadcn components with: `npx shadcn@latest add <component>`
- Styling uses Tailwind CSS v4 with `class-variance-authority`, `clsx`, and `tailwind-merge`
- Prefer existing `src/components/ui/` components for UI implementation before creating custom controls or raw HTML elements. Use built-in variants and sizes, such as `Button` with `variant="ghost"`, whenever they fit the interaction.

## Coding Conventions

- **TypeScript:** Strict mode. `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch` all enabled.
- **Formatting:** 2-space indent for TS/JSON, 4-space for Rust, LF line endings, UTF-8 (see `.editorconfig`).
- **React:** Functional components only, hooks-based, no class components.
- **Naming:** `PascalCase` for components, `camelCase` for functions/variables, `snake_case` for Rust modules.
- **Imports:** Use `@/*` path alias for all `src/` imports.

## Testing

- Framework: **Vitest** + **@testing-library/react** + **jsdom**
- Test files: `*.test.ts` or `*.test.tsx`, colocated near the code they test
- Test files are excluded from `tsconfig.json` compilation
- Focus tests on stores, event parsing, sidecar transforms, and React component behavior

## Commit Convention

Conventional Commits format: `feat: ...`, `fix(agent): ...`, `docs(readme): ...`, `chore(deps): ...`

Common scopes: `agent`, `mcp`, `skills`, `ui`, `store`, `db`, `sidecar`, `config`

## assistant-ui

This project uses assistant-ui for chat interfaces.

Documentation: https://www.assistant-ui.com/llms-full.txt

Key patterns:
- Use AssistantRuntimeProvider at the app root
- Thread component for full chat interface
- AssistantModal for floating chat widget
- useChatRuntime hook with AI SDK transport
