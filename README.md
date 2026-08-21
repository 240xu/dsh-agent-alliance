# dsh-agent-alliance

DeepSeek Harness 插件：让 DSH 与 **Claude Code / Codex / OpenCode / ZCode** 协同运行——
把任务派给它们当子代理、多 agent 圆桌讨论、浏览并导入它们的历史会话。

## 功能

| 能力 | 工具 / 入口 | 说明 |
|---|---|---|
| 子代理派发 | `agent_dispatch` | 无头派发任务给外部 agent CLI；支持后台 job（`job_output`/`job_kill`）与会话续聊（`resumeSessionId`） |
| 圆桌讨论 | `agent_roundtable` | 同一问题并发发给多个 agent，收集观点输出对比文本（默认后台） |
| 会话浏览 | `agent_sessions` / `agent_session_read` | 列出/读取外部 agent 本机历史会话 |
| 历史导入 | `agent_import_scan` / `agent_import` | 四格式历史会话导入为可继续的 DSH 会话（幂等） |
| Web 面板 | 侧边栏「Agent 协同」 | Provider 状态 / 外部会话（查看+导入）/ 派发表单；数据源 `/__agent-alliance/*` |

## 安装（web profile）

```bash
# ~/.dsh/profiles/web/package.json
"dependencies": { "dsh-agent-alliance": "file:/…/dsh-agent-alliance" }
"dsh": { "profile": { "bundles": [ …, "dsh-agent-alliance" ] } }
# 然后 pnpm install 并重启 dsh web
```

## 配置

`~/.dsh/dsh-agent-alliance.json`（缺省全内建，无需创建）：

```json
{
  "providers": {
    "claude":   { "enabled": true },
    "codex":    { "enabled": true },
    "opencode": { "enabled": true },
    "zcode":    { "enabled": false, "commandTemplate": "", "resumeTemplate": "" }
  },
  "defaults": { "timeoutMs": 300000, "maxConcurrent": 3, "defaultCwd": "" }
}
```

- zcode 官方未公开 CLI 无头规范，协同走 `commandTemplate` 模板
  （经 `sh -c` 执行，变量 `{prompt}` `{session}` `{cwd}`，单引号安全转义）；
  其历史会话导入按已验证的 `~/.zcode/cli/db/db.sqlite` schema 只读实现。
- 各家 CLI 探测：claude 经 grun（glibc-runner）；codex 用绝对 node 入口；
  opencode 强制 `TMPDIR=$PREFIX/tmp`。环境缺失时 runner 自动补 PATH/HOME/TMPDIR。

## 安全须知

- 派发会**真实消耗对应 agent 的 API 额度**，且 agent 可能在目标目录内读写文件——
  重要操作先征得用户同意。
- 导入器对外部存储**只读**；导入幂等（台账 `~/.dsh/agent-alliance/imports.json`）。
- 面板端点仅本机 GUI 可达。

## 开发

```bash
node --test 'tests/*.test.js'   # 82 测试；fixture 驱动，不真调外部 CLI
node tests/.probe-real.mjs      # 真实探测四家 CLI（仅 --version）
node tests/.probe-browse.mjs    # 真实浏览三家本地会话（只读）
```

架构与事件契约见 `docs/SPEC.md`；分期验证记录见 `docs/VERIFICATION-P1.md`。
client 入口受 `tests/manifest-guard.test.js` 保护：声明 client 面必须有完整入口
（`__ModuleLoader__.load` + `apply`），否则测试红——这是 2026-08-21 web 连崩事故的制度化防线。
