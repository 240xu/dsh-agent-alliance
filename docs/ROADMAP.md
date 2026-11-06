# ROADMAP — dsh-agent-alliance

> 2026-11-06 重写为对齐 DSH 0.2.1-rc.2 的版本。上一版（0.1.0，2026-08-22）的目标与现状已归档在
> `docs/VERIFICATION-P1.md` 的历史小节里，不再作为当前计划依据。

## 现状（0.2.0）

- 双面插件，**运行时零 npm 依赖**（不 import 任何 `@deepseek-ai/*`）
- 6 个模型工具 + 一条 `/__agent-alliance` 前缀路由（9 个端点）+ slot 化 Web 面板
- 派发两层：官方子代理（`subagent-codex` / `subagent-claude-code`）优先，CLI 包装层回落
- 导入写会话格式 v4，走 `create → append → flush → close` handle 契约
- 测试：`node --test 'tests/*.test.js'`，全部 fixture + 假 ctx 驱动，零额度、零外部 CLI

## P0（立即）

1. **真实宿主回归**：重启后确认 6 工具可见、侧边栏入口出现、五标签面板可读数据。
   清单见 `docs/VERIFICATION-P1.md` 的「0.2.0 回归」小节。
2. **官方后端实测**：装上两个官方包后，用 `agent_dispatch` 发一条最小任务（需用户同意额度），
   确认结果里 `backend: "subagent"`，并在 `list_agents` 里看到子代理会话。
3. **告警可见性**：`ctx.logger` 的 warn/error 是否在面板「状态」标签暴露；目前只能看宿主日志。

## P1（下个迭代）

1. **设置卡片**：把 `providers.*.enabled` / `maxConcurrent` / `defaultCwd` 从配置升级为 Settings 面板表单
   （`settings.section` slot + `host.call` 写回 `cordis.patch.yml`），参照 `dsh-nightly-automation` 的做法。
2. **导入体验**：`agent_import_scan` 结果分页 + 按工作目录聚合；导入完成后返回可点击的会话跳转。
3. **任务中心细化**：把 `jobs.readAt` 的 `next`/`lossy` 暴露成「已丢失前段」提示，避免长输出被环形缓冲截断后误读。
4. **圆桌结构化输出**：辩论轮次结果落成 JSON 便于外部消费，而不只是给模型看的文本。

## P2（观察后决定）

1. **OpenCode 官方化**：若上游出现官方 ACP/子代理包，把 `providers.opencode.subagentProvider` 默认指向它，
   并把 CLI 包装层降为显式 opt-in。
2. **反向导出**：DSH 会话 → 各 agent 格式（对标 `dsh-chat-import` 的 export 能力）。
3. **多 workspace 派发记录持久化**：`recentDispatches` 目前只在进程内，重启即失。
4. **发布 npm**：当前是 `link:` 本地安装；若要发布，先补 CI（test + `node --check`）与版本策略。

## 技术债

- `src/provider/*` 仍按 Termux 优先的路径探测（`$PREFIX`），在普通 Linux 上依赖用户配置覆盖。
  可改成「按命令名探测 + 显式路径覆盖」的对称形式。
- 面板没有单元测试，只有 `manifest-guard` 的结构守卫；渲染逻辑靠人工点验。
- `docs/VERIFICATION-P1.md` 保留了大量 0.1.0 时代的验证记录，只作历史参考，其中的契约描述已过期。
