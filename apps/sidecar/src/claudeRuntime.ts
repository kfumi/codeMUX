/**
 * Claude runtime re-export.
 *
 * The Claude SessionRuntime lives in index.ts for now because it is tightly
 * coupled with the sidecar startup, session-map persistence, and stdin/stdout
 * plumbing.  This module exists so the factory pattern in the plan has a
 * symmetric import target; it will be extracted once the Codex runtime reaches
 * parity and the shared interface is stable.
 */
export { SessionRuntime as ClaudeSessionRuntime } from './index.js';
