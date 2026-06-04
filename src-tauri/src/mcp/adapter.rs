use super::types::McpServer;

pub trait McpAdapter {
    /// 将统一格式转为目标工具配置 JSON
    fn to_config(&self, servers: &[McpServer]) -> Result<serde_json::Value, String>;
    /// 从目标工具配置导入
    fn import_from_config(&self, config: &serde_json::Value) -> Result<Vec<McpServer>, String>;
    /// 同步启用的 servers 到目标工具配置文件
    fn sync_to_config_file(&self, servers: &[McpServer]) -> Result<(), String>;
}
