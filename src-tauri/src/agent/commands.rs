//! Thin forwarding layer over the agent submodules.
//!
//! The original god module was split by kind × concern:
//! - [`super::session_lifecycle`]: sidecar/session lifecycle, runtime config, core commands
//! - [`super::claude_history`] / [`super::codex_history`] / [`super::opencode_history`]:
//!   per-agent native history loading, conversion and deletion
//! - [`super::rewind`]: turn rewind algorithm and command
//! - [`super::fork`]: session branching commands
//! - [`super::codex_proxy`]: codex compat proxy lifecycle commands
//! - [`super::attachments`]: image-recognition enrichment command
//! - [`super::native_jsonl`]: shared JSONL parsing helpers
//!
//! This module re-exports the public surface so existing
//! `crate::agent::commands::...` paths (including the `generate_handler!`
//! registration in `lib.rs`) keep resolving unchanged. The `__cmd__*` and
//! `__tauri_command_name_*` re-exports forward the hidden macros that
//! `#[tauri::command]` generates next to each command function; without them
//! `generate_handler![agent::commands::foo]` cannot resolve the wrapper macro
//! through this module.

// --- Session lifecycle commands ---------------------------------------------

pub use super::session_lifecycle::{
    __cmd__ensure_agent_session, __cmd__get_agent_session_info, __cmd__interrupt_agent_session,
    __cmd__load_agent_latest_token_usage, __cmd__reset_agent_session,
    __cmd__respond_to_agent_permission, __cmd__send_agent_input, __cmd__send_tool_response,
    __cmd__shutdown_agent, __cmd__start_agent_session, __tauri_command_name_ensure_agent_session,
    __tauri_command_name_get_agent_session_info, __tauri_command_name_interrupt_agent_session,
    __tauri_command_name_load_agent_latest_token_usage, __tauri_command_name_reset_agent_session,
    __tauri_command_name_respond_to_agent_permission, __tauri_command_name_send_agent_input,
    __tauri_command_name_send_tool_response, __tauri_command_name_shutdown_agent,
    __tauri_command_name_start_agent_session, ensure_agent_session, get_agent_session_info,
    interrupt_agent_session, load_agent_latest_token_usage, reset_agent_session,
    respond_to_agent_permission, send_agent_input, send_tool_response, shutdown_agent,
    start_agent_session, AgentState,
};

pub use super::session_lifecycle::{
    ensure_agent_session_for_companion, interrupt_agent_session_for_companion,
    send_permission_update_to_session,
};

pub(crate) use super::session_lifecycle::{
    home_dir, load_latest_token_usage_for_session, reject_read_only_session,
    send_command_to_session,
};

// --- Claude history ----------------------------------------------------------

pub use super::claude_history::{
    __cmd__delete_claude_session_files, __cmd__load_claude_session_events,
    __tauri_command_name_delete_claude_session_files,
    __tauri_command_name_load_claude_session_events, delete_claude_session_files,
    load_claude_session_events,
};

pub(crate) use super::claude_history::{
    find_claude_session_jsonl, should_include_claude_history_event,
};

// --- Codex history -----------------------------------------------------------

pub use super::codex_history::{
    __cmd__delete_codex_session_files, __cmd__load_codex_session_events,
    __tauri_command_name_delete_codex_session_files,
    __tauri_command_name_load_codex_session_events, delete_codex_session_files,
    load_codex_session_events,
};

pub(crate) use super::codex_history::{
    convert_codex_history_values_to_events, find_codex_session_jsonl,
};

// --- OpenCode history --------------------------------------------------------

pub use super::opencode_history::{
    __cmd__delete_opencode_session, __cmd__load_opencode_session_events,
    __tauri_command_name_delete_opencode_session,
    __tauri_command_name_load_opencode_session_events, delete_opencode_session,
    load_opencode_session_events,
};

pub(crate) use super::opencode_history::delete_opencode_native_session;

// --- Rewind -------------------------------------------------------------------

pub use super::rewind::{
    __cmd__rewind_agent_session, __tauri_command_name_rewind_agent_session, rewind_agent_session,
};

// --- Fork ----------------------------------------------------------------------

pub use super::fork::{
    __cmd__fork_claude_session, __cmd__fork_codex_session, __cmd__fork_opencode_session,
    __cmd__fork_pi_session, __tauri_command_name_fork_claude_session,
    __tauri_command_name_fork_codex_session, __tauri_command_name_fork_opencode_session,
    __tauri_command_name_fork_pi_session, fork_claude_session, fork_codex_session,
    fork_opencode_session, fork_pi_session,
};

// --- Codex proxy -----------------------------------------------------------------

pub use super::codex_proxy::{
    __cmd__get_codex_proxy_port, __cmd__start_codex_proxy, __cmd__stop_codex_proxy,
    __tauri_command_name_get_codex_proxy_port, __tauri_command_name_start_codex_proxy,
    __tauri_command_name_stop_codex_proxy, get_codex_proxy_port, start_codex_proxy,
    stop_codex_proxy,
};

// --- Attachments -------------------------------------------------------------------

pub use super::attachments::{
    __cmd__enrich_attachments, __tauri_command_name_enrich_attachments, enrich_attachments,
};
