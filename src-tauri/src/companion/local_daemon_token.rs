use std::fs;
use std::path::{Path, PathBuf};

use uuid::Uuid;

const TOKEN_FILE_NAME: &str = "local-daemon-token";

fn token_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(TOKEN_FILE_NAME)
}

/// Ensure a Local Daemon Token exists in the app data directory.
/// Rotates the token when `rotate` is true (e.g. on daemon restart).
pub fn ensure_local_daemon_token(app_data_dir: &Path, rotate: bool) -> Result<String, String> {
    let path = token_path(app_data_dir);
    if !rotate {
        if let Ok(existing) = fs::read_to_string(&path) {
            let trimmed = existing.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }

    let token = Uuid::new_v4().to_string();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, &token).map_err(|error| error.to_string())?;
    Ok(token)
}

pub fn verify_local_daemon_token(app_data_dir: &Path, token: &str) -> bool {
    if token.trim().is_empty() {
        return false;
    }
    match fs::read_to_string(token_path(app_data_dir)) {
        Ok(stored) => stored.trim() == token.trim(),
        Err(_) => false,
    }
}

pub fn read_local_daemon_token(app_data_dir: &Path) -> Option<String> {
    fs::read_to_string(token_path(app_data_dir))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};
    use tempfile::TempDir;

    fn temp_app_data() -> PathBuf {
        static COUNTER: OnceLock<Mutex<u64>> = OnceLock::new();
        let counter = COUNTER.get_or_init(|| Mutex::new(0));
        let mut guard = counter.lock().unwrap();
        *guard += 1;
        let dir = std::env::temp_dir().join(format!("codemux-daemon-token-test-{}", *guard));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn creates_and_verifies_token() {
        let dir = temp_app_data();
        let token = ensure_local_daemon_token(&dir, false).unwrap();
        assert!(verify_local_daemon_token(&dir, &token));
        assert!(!verify_local_daemon_token(&dir, "wrong-token"));
    }

    #[test]
    fn rotate_replaces_token() {
        let dir = temp_app_data();
        let first = ensure_local_daemon_token(&dir, false).unwrap();
        let second = ensure_local_daemon_token(&dir, true).unwrap();
        assert_ne!(first, second);
        assert!(verify_local_daemon_token(&dir, &second));
        assert!(!verify_local_daemon_token(&dir, &first));
    }

    #[test]
    fn ensure_without_rotate_reuses_existing() {
        let dir = temp_app_data();
        let first = ensure_local_daemon_token(&dir, false).unwrap();
        let second = ensure_local_daemon_token(&dir, false).unwrap();
        assert_eq!(first, second);
    }
}
