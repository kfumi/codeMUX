# 06 — Model Provider、MCP 与 skills 走协议

**What to build:** 设置里改 Model Provider（增删改、启用停用、测连通、拉模型目录）、MCP 服务器、skills（含项目级技能）都写入 Daemon。凭据只留在权威侧。下一轮智能体读到的配置与界面一致。选文件夹等原生对话框仍走壳。

**Blocked by:** 03 — 桌面只读走协议

**Status:** ready-for-agent

- [ ] Model Provider 的列表与变更、测连通、拉取模型目录经 Companion；Provider Credentials 不经过壳持久化旁路。
- [ ] MCP 与 skills 的列表、启用/停用、项目级技能写入 Daemon，Session 下一轮能读到同一份。
- [ ] 设置 UI 经 Daemon 门面访问这些能力；切走后不得再 invoke 对应本机命令。
- [ ] Active Provider / Kind Model Selection 所需的只读选项若尚未被 03 bootstrap 覆盖，本票补齐并保持 append-only。
- [ ] 假 Daemon Client 可驱动设置页测试；旧配置缺字段仍能反序列化。
- [ ] 浏览器控制（忽略证书等）仍留在壳配置，不塞进 Companion 配置。
