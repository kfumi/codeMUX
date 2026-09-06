pub mod actions;
pub mod config;
pub mod context;
pub mod desktop_id;
pub mod e2ee;
pub mod events;
pub mod local_daemon_token;
pub mod offer;
pub mod pairing;
pub mod pairing_code;
pub mod relay;
pub mod routes_extended;
pub mod server;
pub mod state;

pub use events::handle_sidecar_event_for_companion;
pub use server::{start_companion_server, start_daemon_server, stop_companion_server, stop_daemon_server};
pub use state::CompanionState;
