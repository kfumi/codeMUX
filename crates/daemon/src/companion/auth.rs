//! Token authorization decisions for the Companion / Daemon HTTP API.
//!
//! Extracted from `server.rs` so loopback + Local Daemon Token rules are unit-testable
//! without spinning up a full Axum stack.

use std::path::Path;

use crate::companion::local_daemon_token;
use crate::db::operations;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalDaemonTokenDecision {
    /// Valid Local Daemon Token from a loopback peer — accept as local daemon device.
    AcceptLoopback,
    /// Valid Local Daemon Token from a non-loopback peer — always reject.
    RejectNonLoopback,
    /// LAN / relay exposure is disabled and the peer is not loopback — reject before pairing.
    RejectCompanionDisabled,
    /// Token is not a Local Daemon Token — fall through to pairing verification.
    NotLocalToken,
}

/// Decide how to handle a bearer token that may be the Local Daemon Token.
pub fn classify_local_daemon_token(
    app_data_dir: &Path,
    token: &str,
    from_loopback: bool,
    lan_exposed: bool,
) -> LocalDaemonTokenDecision {
    if from_loopback {
        if local_daemon_token::verify_local_daemon_token(app_data_dir, token) {
            return LocalDaemonTokenDecision::AcceptLoopback;
        }
        return LocalDaemonTokenDecision::NotLocalToken;
    }

    if !lan_exposed {
        return LocalDaemonTokenDecision::RejectCompanionDisabled;
    }

    if local_daemon_token::verify_local_daemon_token(app_data_dir, token) {
        return LocalDaemonTokenDecision::RejectNonLoopback;
    }

    LocalDaemonTokenDecision::NotLocalToken
}

pub fn local_daemon_device() -> operations::PairedDevice {
    operations::PairedDevice {
        id: "local-daemon".to_string(),
        name: "Local Daemon".to_string(),
        paired_at: String::new(),
        last_seen_at: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn temp_dir() -> TempDir {
        TempDir::new().expect("temp dir")
    }

    #[test]
    fn loopback_local_token_is_accepted() {
        let dir = temp_dir();
        let token = local_daemon_token::ensure_local_daemon_token(dir.path(), false).unwrap();
        let decision = classify_local_daemon_token(dir.path(), &token, true, false);
        assert_eq!(decision, LocalDaemonTokenDecision::AcceptLoopback);
    }

    #[test]
    fn non_loopback_local_token_is_rejected_when_lan_exposed() {
        let dir = temp_dir();
        let token = local_daemon_token::ensure_local_daemon_token(dir.path(), false).unwrap();
        let decision = classify_local_daemon_token(dir.path(), &token, false, true);
        assert_eq!(decision, LocalDaemonTokenDecision::RejectNonLoopback);
    }

    #[test]
    fn non_loopback_request_rejected_when_companion_disabled() {
        let dir = temp_dir();
        let token = local_daemon_token::ensure_local_daemon_token(dir.path(), false).unwrap();
        let decision = classify_local_daemon_token(dir.path(), &token, false, false);
        assert_eq!(decision, LocalDaemonTokenDecision::RejectCompanionDisabled);
    }

    #[test]
    fn wrong_token_on_loopback_falls_through_to_pairing() {
        let dir = temp_dir();
        let _ = local_daemon_token::ensure_local_daemon_token(dir.path(), false).unwrap();
        let decision = classify_local_daemon_token(dir.path(), "not-the-local-token", true, false);
        assert_eq!(decision, LocalDaemonTokenDecision::NotLocalToken);
    }

    #[test]
    fn pairing_token_on_loopback_is_not_local_daemon_token() {
        let dir = temp_dir();
        let decision = classify_local_daemon_token(dir.path(), "pairing-style-token", true, true);
        assert_eq!(decision, LocalDaemonTokenDecision::NotLocalToken);
    }
}
