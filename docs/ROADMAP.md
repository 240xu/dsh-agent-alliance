# ROADMAP — dsh-agent-alliance 后续计划（PM 视角）

> 2026-08-22 基于 92 测试全绿、四期交付与深度兼容轮的全面审计制定。
> 优先级：P0 = 立即做 / P1 = 下个迭代 / P2 = 观察后决定。

## 现状快照

- 双面插件：6 CLI 工具 + 原生子代理工具 subagent_opencode + 7 HTTP 端点 + 主题/i18n 面板
- 质量：92/90+ 测试全绿；manifest-guard 防线；零运行时 npm 依赖
- 已验证：导入全链路（45~59 轮真实会话）、端点、ACP 握手、工作区归组、主题令牌

## P0（立即）

1. **重启回归**：本轮 host 侧改动（信号量并发上限、opencode 工具部件映射、
   claude sidechain 过滤）需一次重启后跑全量回归——清单见 VERIFICATION-P1.md
2. **用户环境修复指引**：claude 依赖本地代理 9316；opencode 默认模型已由
   原生工具挂载钉为免费实验模型，CLI 包装层仍可用 `model` 参数覆盖

## P1（下个迭代）

1. **codex 原生嵌入**：无内建 ACP。两条路线：
   a. 调研社区适配器（codex-acp 类项目）成熟度后挂载；
   b. 自写 stdio→ACP 桥（复用 runner，工作量 ~2 天）
2. **面板「外部会话」标签接原生子代理**：从面板直接发起 subagent_opencode 派发
3. **导入体验**：agent_import_scan 结果分页 + 按工作目录聚合视图；
   导入完成后在返回值里给出「打开该会话」的 GUI 跳转提示
4. **设置卡片**：把 providers.enabled/maxConcurrent 从 JSON 配置升级为 GUI 设置面
   （web-ui.plugin.item slot，参照 task-board SettingsCard）

## P2（观察后决定）

1. **发布 npm**：当前 file: 本地安装。若要分享：先 git history 重写（含旧 UUID 的历史提交）+
   CI 加 security-scan 步骤 + 版本号策略（0.2.0）
2. **zcode 协同实测**：等 zcode 安装后按 commandTemplate 实测调优
3. **claude ACP 稳定性**：依赖本地代理在线；可考虑直连模式开关
4. **导出/回写**：DSH 会话 → 各 agent 格式的反向导出（对标 chat-import 的 export 能力）
5. **多 workspace 派发记录持久化**：recent dispatches 目前进程内，重启即失——按需落盘

## 技术债登记

- ~~maxConcurrent 未生效~~ ✅ 已实现（信号量）
- ~~opencode 工具部件丢失~~ ✅ 已映射
- ~~claude sidechain 噪声~~ ✅ 已过滤
- 面板动态文案（错误消息等）仍为中英混合硬编码 → 随 i18n 二期补全
- pnpm 对 file: 目录依赖不重拷 → 每次发布需手动 tar 同步（脚本化候选）
