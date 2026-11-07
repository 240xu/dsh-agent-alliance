# D1 — 官方行为审计：Codex bundle

> 角色：OFFICIAL-BEHAVIOR AUDITOR D1。判据一律以 **DSH 源码 checkout** 为准（该 bundle 本机未安装）。
> 对象：`/home/ova/dsh/.artifacts/dsh-plugins/dsh-agent-alliance` @ `1054bcb`（八次 fix commit 之后）。
> 权威源：`packages/subagent/subagent-codex/{README.md,cordis.patch.yml,package.json,src/*.ts}`、
> `packages/subagent/subagent/src/types.ts`、`packages/subagent/tool-subagent/src/index.ts`。
> 本文件是唯一写入；源码零改动。

## 状态

进行中（增量落盘）。逐题：

- [ ] Q1 双工具重复（`subagent_codex` vs `agent_dispatch codex`）
- [ ] Q2 `startActivation` 调用形状对齐
- [ ] Q3 resume 拒绝是否为真
- [ ] Q4 `permissionMode` 默认 `never` 的含义与安全性
- [ ] Q5 `maxConcurrent` vs `maxActiveSubagents`
- [ ] Q6 `providerName` 与 `subagentProvider` 不一致时
- [ ] Q7 文档被官方源码推翻之处

<!-- APPEND PER ITEM -->
