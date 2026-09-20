# 08 — 工作区文件与 git/forge 走协议

**What to build:** 项目树读目录、读/写/删文件、git 变更与仓库状态、创建 Pull Request 等走 Daemon，让智能体与界面看到同一文件系统。选文件夹、选文件仍是壳的原生对话框；用系统编辑器打开路径仍由壳唤起，壳不解释 git 状态。

**Blocked by:** 03 — 桌面只读走协议

**Status:** ready-for-agent

- [ ] 工作区读目录/读写文件经 Companion（含相对项目根的既有语义），项目树与文件预览不再走对应本机业务命令。
- [ ] git 变更列表、相对 HEAD 的变更、仓库状态、现有 forge/PR 动作经 Daemon。
- [ ] 文件/目录选择对话框与「在外部编辑器打开」走 Shell 门面；打开动作用 UI 或 Daemon 提供的路径，壳不查询 git。
- [ ] 切走后禁止双写；缺路由则入口报错，不得静默 invoke。
- [ ] 假 Daemon Client 覆盖列目录与读文件；对话框可用假 Shell 门面断言被调用且路径回传给 Daemon 操作。
