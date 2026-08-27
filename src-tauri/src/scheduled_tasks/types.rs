use serde::{Deserialize, Serialize};

use crate::config::types::AgentKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleKind {
    Hourly,
    Daily,
    Weekdays,
    Weekly,
    Monthly,
}

impl ScheduleKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hourly => "hourly",
            Self::Daily => "daily",
            Self::Weekdays => "weekdays",
            Self::Weekly => "weekly",
            Self::Monthly => "monthly",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "hourly" => Some(Self::Hourly),
            "daily" => Some(Self::Daily),
            "weekdays" => Some(Self::Weekdays),
            "weekly" => Some(Self::Weekly),
            "monthly" => Some(Self::Monthly),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunDelivery {
    NewSession,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskRunStatus {
    Running,
    Completed,
    Failed,
    AwaitingInput,
    Skipped,
}

impl TaskRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::AwaitingInput => "awaiting_input",
            Self::Skipped => "skipped",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "running" => Some(Self::Running),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            "awaiting_input" => Some(Self::AwaitingInput),
            "skipped" => Some(Self::Skipped),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    Overlap,
    ConcurrencyLimit,
    ProjectMissing,
}

impl SkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Overlap => "overlap",
            Self::ConcurrencyLimit => "concurrency_limit",
            Self::ProjectMissing => "project_missing",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "overlap" => Some(Self::Overlap),
            "concurrency_limit" => Some(Self::ConcurrencyLimit),
            "project_missing" => Some(Self::ProjectMissing),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    pub id: String,
    pub title: String,
    pub instruction: String,
    pub project_id: String,
    pub agent_kind: AgentKind,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub permission_config: String,
    pub plan_mode: String,
    pub schedule_kind: ScheduleKind,
    pub schedule_time: String,
    pub weekly_weekday: Option<i32>,
    pub monthly_day: Option<i32>,
    pub timezone: String,
    pub delivery: RunDelivery,
    pub enabled: bool,
    pub last_run_at: Option<String>,
    pub next_run_at: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub id: String,
    pub task_id: String,
    pub session_id: Option<String>,
    pub scheduled_for: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub status: TaskRunStatus,
    pub skip_reason: Option<SkipReason>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ScheduledTaskUpsert {
    pub title: String,
    pub instruction: String,
    pub project_id: String,
    pub agent_kind: AgentKind,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub permission_config: String,
    pub plan_mode: String,
    pub schedule_kind: ScheduleKind,
    pub schedule_time: String,
    pub weekly_weekday: Option<i32>,
    pub monthly_day: Option<i32>,
    pub timezone: String,
    pub enabled: bool,
}

#[derive(Debug, Clone)]
pub struct TaskRunPayload {
    pub task_id: String,
    pub task_title: String,
    pub instruction: String,
    pub project_id: String,
    pub agent_kind: AgentKind,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub permission_config: String,
    pub plan_mode: String,
}

#[derive(Debug, Clone)]
pub enum TaskRunnerResult {
    Started { session_id: String },
    Failed { error: String },
}

#[cfg(test)]
pub trait TaskRunner {
    fn run(&mut self, payload: TaskRunPayload) -> TaskRunnerResult;
}

pub const MAX_CONCURRENT_SCHEDULED_RUNS: usize = 2;
