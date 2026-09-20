//! Thin forwarding layer over the agent submodules.
//!
//! The original god module was split by kind × concern:
//! - [`super::session_lifecycle`]: sidecar/session lifecycle, runtime config
//! - [`super::claude_history`] / [`super::codex_history`] / [`super::opencode_history`]:
//!   per-agent native history loading, conversion and deletion
//! - [`super::rewind`]: turn rewind algorithm
//! - [`super::fork`]: session branching
//! - [`super::codex_proxy`]: codex compat proxy lifecycle
//! - [`super::attachments`]: image-recognition enrichment
//! - [`super::native_jsonl`]: shared JSONL parsing helpers
//!
//! This module re-exports the companion/core surface so existing
//! `crate::agent::commands::...` paths keep resolving unchanged. The old
//! shell command wrappers and their `__cmd__*` macro re-exports retired
//! together with the shell process.

// --- Session lifecycle -------------------------------------------------------

pub use super::session_lifecycle::{
    ensure_agent_session_for_companion, get_agent_session_info_for_companion,
    interrupt_agent_session_for_companion, send_permission_update_to_session, AgentState,
};

pub(crate) use super::session_lifecycle::{
    home_dir, load_latest_token_usage_for_session, reject_read_only_session,
    send_command_to_session,
};

// --- Claude history ----------------------------------------------------------

pub(crate) use super::claude_history::{
    find_claude_session_jsonl, load_claude_session_events_impl, should_include_claude_history_event,
};

// --- Codex history -----------------------------------------------------------

pub(crate) use super::codex_history::{
    convert_codex_history_values_to_events, find_codex_session_jsonl,
    load_codex_session_events_impl,
};

// --- OpenCode history --------------------------------------------------------

pub(crate) use super::opencode_history::{
    delete_opencode_native_session, load_opencode_session_events_impl,
};
