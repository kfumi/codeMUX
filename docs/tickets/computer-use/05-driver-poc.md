# 05 驱动概念验证

**What to build:** 用外部开源驱动跑通一条最小闭环，回答能不能用、坑在哪：daemon 拉起驱动子进程并连通，在主力智能体上完成截图到点击到验证，结论回写 spec。

**Blocked by:** 01 浏览器快照与元素操作 MCP 化

**Status:** ready-for-agent

- [ ] daemon 拉起驱动子进程并经标准输入输出 MCP 连通
- [ ] Claude 与 Codex 跑通截图到点击到验证闭环
- [ ] 选型结论回写 spec 底部 Comments：行或不行、坑位清单
- [ ] MCP 图片回传可见性逐项记录，为铺开验收铺路
