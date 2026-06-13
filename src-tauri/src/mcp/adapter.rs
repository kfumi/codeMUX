pub type McpAdapterResult<T> = Result<T, String>;

pub trait McpAdapter: Sync {
    /// Whether this tool is installed and we should sync to it
    fn should_sync(&self) -> bool;
    /// Sync a single server to the tool's native config
    fn sync_single_server(&self, id: &str, server_spec: &serde_json::Value) -> McpAdapterResult<()>;
    /// Remove a server from the tool's native config
    fn remove_server(&self, id: &str) -> McpAdapterResult<()>;
    /// Import servers from the tool's native config
    fn import_from_tool(&self) -> McpAdapterResult<Vec<(String, serde_json::Value)>>;
}
