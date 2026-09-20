use std::path::PathBuf;

use crate::runtime::seam::FileSystemRuntimeRoots;
use crate::skills::adapter::{
    remove_skill_impl, sync_skill_impl, SkillAdapter, SkillAdapterResult,
};

/// pi 托管配置目录（ADR 0005：经 `PI_CODING_AGENT_DIR` 重定向，与用户 `~/.pi`
/// 硬隔离）。必须与 agent spawn 侧的计算保持一致（session_lifecycle 的
/// `runtime_resolver.root().parent()/pi-agent`）：生产环境 resolver 使用
/// `FileSystemRuntimeRoots::default_root()`，此处直接复用同一来源。
/// pi 的全局 skills 目录为 `<agentDir>/skills/`（0.73.1 skills.js 实测），
/// pi spawn 时自动发现该目录，无需任何启动参数。
fn pi_agent_dir() -> PathBuf {
    let root = FileSystemRuntimeRoots::default_root();
    let base = root
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or(root);
    base.join("pi-agent")
}

fn pi_skills_dir() -> PathBuf {
    pi_agent_dir().join("skills")
}

pub struct PiSkillAdapter;

impl SkillAdapter for PiSkillAdapter {
    // 托管目录属于 CodeMUX 自身（随应用数据目录始终可创建），不依赖用户
    // 是否安装过独立 pi CLI。
    fn should_sync(&self) -> bool {
        true
    }

    fn get_skills_dir(&self) -> PathBuf {
        pi_skills_dir()
    }

    fn sync_skill(&self, directory: &str, source: &std::path::Path) -> SkillAdapterResult<()> {
        sync_skill_impl(&pi_skills_dir(), directory, source)
    }

    fn remove_skill(&self, directory: &str) -> SkillAdapterResult<()> {
        remove_skill_impl(&pi_skills_dir(), directory)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use uuid::Uuid;

    /// 在临时 LOCALAPPDATA 下计算托管 skills 目录（与生产同源计算）。
    fn with_temp_local_app_data(test: impl FnOnce(&Path)) {
        let temp = std::env::temp_dir().join(format!("codemux-pi-skills-{}", Uuid::new_v4()));
        let runtimes = temp.join("CodeMUX").join("runtimes");
        fs::create_dir_all(&runtimes).unwrap();
        // default_root 读 LOCALAPPDATA env；Windows 下该 env 同时被其他
        // adapter 的 home 推导使用，保存并在测试后恢复。
        let previous = std::env::var_os("LOCALAPPDATA");
        std::env::set_var("LOCALAPPDATA", &temp);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| test(&temp)));
        match previous {
            Some(value) => std::env::set_var("LOCALAPPDATA", value),
            None => std::env::remove_var("LOCALAPPDATA"),
        }
        fs::remove_dir_all(&temp).ok();
        assert!(result.is_ok(), "test panicked");
    }

    #[test]
    fn syncs_skill_into_managed_agent_dir() {
        with_temp_local_app_data(|temp| {
            let source = temp.join("ssot").join("my-skill");
            fs::create_dir_all(&source).unwrap();
            fs::write(source.join("SKILL.md"), "---\nname: my-skill\n---\nbody").unwrap();

            let adapter = PiSkillAdapter;
            assert!(adapter.should_sync());
            adapter.sync_skill("my-skill", &source).unwrap();

            let expected = temp
                .join("CodeMUX")
                .join("pi-agent")
                .join("skills")
                .join("my-skill");
            assert!(
                expected.join("SKILL.md").exists(),
                "skill synced to managed dir"
            );
            assert_eq!(adapter.get_skills_dir(), expected.parent().unwrap());

            adapter.remove_skill("my-skill").unwrap();
            assert!(!expected.exists(), "skill removed from managed dir");
        });
    }
}
