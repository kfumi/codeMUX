use serde::{Deserialize, Serialize};

use crate::config::types::AgentKind;

/// 工作任务生命周期状态机（10 态）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkTaskStatus {
    Todo,
    Queued,
    Preparing,
    Running,
    AwaitingInput,
    Review,
    Merging,
    Done,
    Failed,
    Canceled,
}

impl WorkTaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::Queued => "queued",
            Self::Preparing => "preparing",
            Self::Running => "running",
            Self::AwaitingInput => "awaiting_input",
            Self::Review => "review",
            Self::Merging => "merging",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "todo" => Some(Self::Todo),
            "queued" => Some(Self::Queued),
            "preparing" => Some(Self::Preparing),
            "running" => Some(Self::Running),
            "awaiting_input" => Some(Self::AwaitingInput),
            "review" => Some(Self::Review),
            "merging" => Some(Self::Merging),
            "done" => Some(Self::Done),
            "failed" => Some(Self::Failed),
            "canceled" => Some(Self::Canceled),
            _ => None,
        }
    }

    /// 全部状态词汇表（测试/文档用，按声明顺序）。
    pub fn all() -> [Self; 10] {
        [
            Self::Todo,
            Self::Queued,
            Self::Preparing,
            Self::Running,
            Self::AwaitingInput,
            Self::Review,
            Self::Merging,
            Self::Done,
            Self::Failed,
            Self::Canceled,
        ]
    }
}

/// 终态失败原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureReason {
    AgentError,
    SetupError,
    Interrupted,
}

impl FailureReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AgentError => "agent_error",
            Self::SetupError => "setup_error",
            Self::Interrupted => "interrupted",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "agent_error" => Some(Self::AgentError),
            "setup_error" => Some(Self::SetupError),
            "interrupted" => Some(Self::Interrupted),
            _ => None,
        }
    }
}

/// 完成方式：已合并或未合并直接完成。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionKind {
    Merged,
    CompletedWithoutMerge,
}

impl CompletionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Merged => "merged",
            Self::CompletedWithoutMerge => "completed_without_merge",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "merged" => Some(Self::Merged),
            "completed_without_merge" => Some(Self::CompletedWithoutMerge),
            _ => None,
        }
    }
}

/// `work_tasks` 行的内存表示；wire 序列化为 camelCase。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTask {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub instruction: String,
    pub agent_kind: AgentKind,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub use_worktree: bool,
    pub base_branch: Option<String>,
    pub worktree_path: Option<String>,
    pub work_branch: Option<String>,
    pub status: WorkTaskStatus,
    pub failure_reason: Option<FailureReason>,
    pub last_error: Option<String>,
    pub run_seq: i64,
    pub sort_order: i64,
    pub session_id: Option<String>,
    pub result_summary: Option<String>,
    pub files_changed: Option<i64>,
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub merge_commit: Option<String>,
    pub completion_kind: Option<CompletionKind>,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub settled_at: Option<String>,
    pub finished_at: Option<String>,
    pub base_sha: Option<String>,
}

/// 创建任务的输入（camelCase 反序列化，service 层校验后落到 db 层）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTaskInput {
    pub title: String,
    pub instruction: String,
    pub project_id: String,
    pub agent_kind: AgentKind,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    #[serde(default = "default_true")]
    pub use_worktree: bool,
    pub base_branch: Option<String>,
}

fn default_true() -> bool {
    true
}

/// PATCH 部分更新：
/// - 字段缺失（或 Rust 侧 `None`）= 不修改；
/// - JSON 里字段为 `null` = 清空（serde_some 让 `null` 反序列化为 `Some(None)`，
///   否则 serde 会把 null 折叠成外层 `None`，清空语义不可达）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTaskPatch {
    pub title: Option<String>,
    pub instruction: Option<String>,
    pub agent_kind: Option<AgentKind>,
    #[serde(default, deserialize_with = "deserialize_some")]
    pub provider_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_some")]
    pub model: Option<Option<String>>,
    pub use_worktree: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_some")]
    pub base_branch: Option<Option<String>>,
}

/// JSON `null` → `Some(None)`（清空）；字段值 → `Some(Some(v))`（覆盖）。
/// 配合 `#[serde(default)]`：字段缺失走 `Default`，保持外层 `None`（不动）。
fn deserialize_some<'de, T, D>(deserializer: D) -> Result<Option<T>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    serde::Deserialize::deserialize(deserializer).map(Some)
}

/// `work_task_events` 行。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTaskEvent {
    pub id: i64,
    pub task_id: String,
    pub kind: String,
    pub detail: Option<String>,
    pub created_at: String,
}
