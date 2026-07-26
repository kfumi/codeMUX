# Domain docs

This repo uses a **single-context** layout for domain documentation.

## Layout

- `CONTEXT.md` (repo root) — the single, canonical context document for the whole project. Start here when onboarding.
- `docs/adr/` — Architecture Decision Records, one file per decision. Filename convention: `NNNN-short-title.md` (zero-padded sequence number, kebab-case title), e.g. `0001-use-tauri-2.md`.

There is no `CONTEXT-MAP.md` and no per-package `CONTEXT.md` files — this is not a monorepo.

## Consumer rules

When a skill needs domain context:

1. **Read `CONTEXT.md` first.** It is the entry point. If it doesn't exist yet, treat its absence as a gap and (when appropriate) suggest creating it rather than fabricating context.
2. **Consult `docs/adr/` for decisions.** ADRs record *why* a choice was made, not just *what* was chosen. Read the relevant ADR before proposing a change that contradicts an existing decision; if you must contradict it, propose a new ADR that supersedes the old one.
3. **Don't invent ADRs.** If `docs/adr/` is empty or a decision isn't recorded, say so. Don't fabricate decisions that weren't made.

## Authoring guidance

- `CONTEXT.md` should be kept short and current — a map, not a history. Pointers to ADRs and other docs are more valuable than duplicated prose.
- ADRs are append-only: never edit a published ADR in place. To change a decision, write a new ADR that marks the old one as superseded.
