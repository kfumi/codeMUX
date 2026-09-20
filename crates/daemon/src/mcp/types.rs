use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpApps {
    #[serde(default)]
    pub claude: bool,
    #[serde(default)]
    pub codex: bool,
    #[serde(default)]
    pub gemini: bool,
    #[serde(default)]
    pub opencode: bool,
    #[serde(default)]
    pub pi: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpServer {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub server: serde_json::Value,
    pub apps: McpApps,
    /// 内置 server(daemon 动态提供,不在 DB 中):列表展示为内置,拒绝改删。
    #[serde(default)]
    pub builtin: bool,
}
