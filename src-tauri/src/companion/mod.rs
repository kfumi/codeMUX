pub mod actions;
pub mod config;
pub mod desktop_id;
pub mod events;
pub mod offer;
pub mod pairing;
pub mod server;
pub mod state;

pub use events::handle_sidecar_event_for_companion;
pub use server::{start_companion_server, stop_companion_server};
pub use state::CompanionState;
