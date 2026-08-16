use uuid::Uuid;

use crate::config::types::CompanionConfig;

pub fn get_or_create_desktop_id(config: &mut CompanionConfig) -> String {
    if let Some(id) = config.desktop_id.as_ref().map(|value| value.trim().to_string()) {
        if !id.is_empty() {
            return id;
        }
    }
    let id = format!("cmx_desktop_{}", Uuid::new_v4().simple());
    config.desktop_id = Some(id.clone());
    id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reuses_existing_desktop_id() {
        let mut config = CompanionConfig {
            desktop_id: Some("cmx_desktop_existing".to_string()),
            ..CompanionConfig::default()
        };
        assert_eq!(get_or_create_desktop_id(&mut config), "cmx_desktop_existing");
    }

    #[test]
    fn generates_desktop_id_when_missing() {
        let mut config = CompanionConfig::default();
        let id = get_or_create_desktop_id(&mut config);
        assert!(id.starts_with("cmx_desktop_"));
        assert_eq!(config.desktop_id.as_deref(), Some(id.as_str()));
    }
}
