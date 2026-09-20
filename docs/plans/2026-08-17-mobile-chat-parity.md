# Mobile Chat Desktop Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Mobile Companion's completed-turn duration and process grouping match the desktop chat.

**Architecture:** Keep the companion event stream as the source of truth. Extract completed-turn duration from `turn_finished` events into a user-message-keyed map, then pass that map into the existing display-row projection. Model desktop's nested process grouping explicitly: a reasoning-only outer group renders as `思考`; an outer group containing tools renders as `探索` with contiguous reasoning runs rendered as one nested `思考` row.

**Tech Stack:** React 18, TypeScript, Vitest, Vite, lucide-react, Tailwind CSS.

---

### Task 1: Lock down duration and grouping behavior with tests

**Files:**
- Modify: `src-mobile/src/lib/messageLayout.test.ts`
- Create: `src-mobile/src/lib/turnDuration.test.ts`

- [ ] Add a `thinking` row expectation for a reasoning-only process segment.
- [ ] Add a duration expectation for a compact toggle keyed by the user message ID.
- [ ] Add duration extraction tests for `turn_finished.duration_ms` and timestamp fallback.
- [ ] Run the focused mobile tests and confirm they fail because the new row type, option, and duration helper do not exist.

### Task 2: Add turn-duration projection and display

**Files:**
- Create: `src-mobile/src/lib/turnDuration.ts`
- Modify: `src-mobile/src/lib/messageLayout.ts`
- Modify: `src-mobile/src/components/ChatView.tsx`
- Modify: `src-mobile/src/components/chat/CompactProcessToggle.tsx`

- [ ] Implement `buildTurnDurationMap` using positive `duration_ms` first and valid event timestamp differences as fallback.
- [ ] Implement the same compact elapsed format as desktop (`12s`, `1m1s`, etc.).
- [ ] Store a revision-triggered duration map in `ChatView` whenever raw history or live events change.
- [ ] Pass duration data into `buildDisplayRows` and render it beside `已处理`.
- [ ] Run the focused duration tests and confirm they pass.

### Task 3: Match desktop's nested process grouping

**Files:**
- Create: `src-mobile/src/components/chat/ThinkingGroupRow.tsx`
- Modify: `src-mobile/src/lib/messageLayout.ts`
- Modify: `src-mobile/src/components/ChatView.tsx`
- Modify: `src-mobile/src/components/chat/ExploreGroupRow.tsx`

- [ ] Add a `thinking` display-row type for reasoning-only groups.
- [ ] Coalesce each contiguous reasoning run into one `ThinkingGroupRow`.
- [ ] Keep tool-containing runs under the outer `ExploreGroupRow`, while rendering their reasoning runs as nested thinking rows.
- [ ] Keep mutation tools and interactive questions outside exploration groups.
- [ ] Run message-layout tests and verify the row order matches the desktop grouping contract.

### Task 4: Verify the mobile package

**Files:**
- Verify: `src-mobile/src/lib/turnDuration.ts`
- Verify: `src-mobile/src/lib/messageLayout.ts`
- Verify: `src-mobile/src/components/ChatView.tsx`
- Verify: `src-mobile/src/components/chat/CompactProcessToggle.tsx`
- Verify: `src-mobile/src/components/chat/ExploreGroupRow.tsx`
- Verify: `src-mobile/src/components/chat/ThinkingGroupRow.tsx`

- [ ] Run `npx vitest run` from `src-mobile`.
- [ ] Run `npm run build` from `src-mobile`.
- [ ] Run IDE linter diagnostics for all edited source files and fix introduced errors.
