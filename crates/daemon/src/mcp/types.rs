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
    /// 列表展示用的读投影:内置 server 由 daemon 现算「当前开关下模型看得见的工具名」
    /// (`builtin_mcp::visible_tool_names`),用户自建 server 留空(它的工具名来自探测,
    /// 走 `ProbeResult.tools`)。不落库、不可写 —— 写入路径只按 id/name/server/apps 落列。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
}
