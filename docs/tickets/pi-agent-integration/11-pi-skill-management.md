# 11 — pi 接入 CodeMUX Skill 管理（二期）

**What to build:** 把 CodeMUX 管理的 skills（SSOT `~/.codemux/skills/`）同步给 pi 会话使用，完全镜像现有 SkillAdapter 模式。pi 侧依据（0.73.1 源码核实）：pi 遵循 Agent Skills 标准（SKILL.md，与 Claude Code 同源）；全局 skills 目录为 `<agentDir>/skills/`——**跟随 `PI_CODING_AGENT_DIR` 重定向**（skills.js: `join(resolvedAgentDir, "skills")`），即 CodeMUX 托管目录 `%LOCALAPPDATA%/CodeMUX/pi-agent/skills/` 放入的 skills 在 pi spawn 时自动发现，无需传参；skills 描述自动注入系统提示词（渐进披露），`/skill:<name>` 命令默认启用（`enableSkillCommands ?? true`），RPC `prompt` 原生接受斜杠命令。同步目标是 CodeMUX 托管目录而非 `~/.pi`——满足 ADR 0005 硬隔离（比 claude/codex 写 home 目录更干净）。实现：①Rust `skills/adapters/pi.rs`（`should_sync` 恒 true——托管目录始终可用；`get_skills_dir`/`sync_skill`/`remove_skill` 复用 `sync_skill_impl`，路径计算 `FileSystemRuntimeRoots::default_root().parent()/pi-agent/skills`，与 spawn 侧 `runtime_resolver.root().parent()/pi-agent` 在生产环境一致）；②adapter 注册 + `all_apps` 增至 5；③skills 表加 `enabled_pi` 列（列存在性检查 + ALTER 迁移，DEFAULT 0），`SkillApps` Rust/TS 增 `pi`；④前端 SkillsSettings 勾选（AppIcon 字母徽标回退，pi 无品牌 SVG）；⑤slashCommands：放开 `getSkillCommandsForAgent` 的 pi 早退（enabledApps 增 `pi: 'pi'`），`renderCommandInput` 增 pi 分支渲染 pi 原生语法 `/skill:<name> <args>`。生效时机：pi spawn 时扫描 skills，运行中进程不热加载，勾选变更下次会话重建生效（与其他 kind「CLI 启动时读取」一致）。明确不做：不接 `get_commands`（会与本地注册双 listing）；project skills 的 `--skill <path>` 按会话传递（留作延伸）；ensure 已有的 `"pi" => "pi"` skills 名单传递维持现状（sidecar 对 pi 忽略该参数，pi 自行读盘）。

**Blocked by:** 07

**Status:** done

- [x] Rust：skills/adapters/pi.rs（托管目录路径计算 + sync/remove 复用 + 注释记录与 spawn 侧的一致性约束）
- [x] Rust：adapters/mod.rs 注册 + all_apps 5 项；service.rs ImportResult 增 pi 计数
- [x] Rust：skills 表 enabled_pi 列（schema.rs DDL + 迁移块）+ db.rs 读写/开关/名单 match 分支
- [x] 前端：SkillApps 类型 + SkillsSettings APP_ORDER/LABELS/SVGS（pi 走字母徽标回退）
- [x] 前端：slashCommands 放开 pi skill 命令 + renderCommandInput `/skill:<name>` 语法分支
- [x] 测试：Rust adapter（重定向 LOCALAPPDATA 验证 sync/remove 落在托管 skills 目录）+ db enabled_pi 往返 + service 计数；前端 slashCommands pi 渲染
- [x] gate：Rust lib 全绿 + fmt/clippy/check；根 vitest 无新增失败（基线比对）
