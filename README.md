# dsh-agent-alliance

DeepSeek Harness 双面插件：让 DSH 与 **Claude Code / Codex / OpenCode / ZCode** 深度协同——
CLI 子代理派发、圆桌讨论、历史会话导入，以及**经 ACP 嵌入 DSH 原生子代理体系**。

## 能力总览

### CLI 包装层（6 个模型工具）

| 工具 | 说明 |
|---|---|
| `agent_dispatch` | 无头派发任务；前台等待或后台 job（`job_output`/`job_kill`）；`resumeSessionId` 续聊；受 `maxConcurrent` 并发上限约束（排队可取消） |
| `agent_roundtable` | 同一问题并发发给多个 agent，输出观点对比（默认后台） |
| `agent_sessions` / `agent_session_read` | 浏览/读取外部 agent 本机历史会话 |
| `agent_import_scan` / `agent_import` | 四格式历史会话事件级导入为 DSH 会话（幂等、自动归组工作区、预热投影缓存） |

UI：dispatch/roundtable/import 均有原生形态卡片（terminal/generic），与宿主工具观感一致。

### 原生子代理嵌入层（ACP）

- **opencode**：内建 ACP server，已挂载 provider `opencode`；原生工具
  **`subagent_opencode`**（固定 provider + 钉实验模型 `opencode/x-preview-f-free`）
- **claude**：经 `@zed-industries/claude-code-acp@0.16.2` 适配器挂载 provider `claude`
  （运行前提：本地代理 `127.0.0.1:9316` 在线）
- codex 无内建 ACP——需社区适配器或自写桥（见 ROADMAP）

### Web 面板

侧边栏「Agent 协同」入口（DOM 注入自愈）→ 中央视图四标签：
状态（四家探测）/ 外部会话（查看·导入·归组标注）/ 派发任务 / 圆桌。
样式完全骑 `--dsw-*` 皮肤令牌；文案 zh/en 经 locale 服务跟随客户端语言并实时切换。
数据源：`/__agent-alliance/*` 七端点。

## 安装

```jsonc
// ~/.dsh/profiles/web/package.json
"dependencies": { "dsh-agent-alliance": "file:/…/dsh-agent-alliance" }
"dsh": { "profile": { "bundles": [ …, "dsh-agent-alliance" ] } }
```
另需 pnpm add `@deepseek-ai/dsh-subagent-acp@next`（原生子代理后端）与
`@zed-industries/claude-code-acp`（claude 适配器，可选）。

## 配置

`~/.dsh/dsh-agent-alliance.json`（缺省全内建）：

```json
{
  "providers": {
    "claude":   { "enabled": true },
    "codex":    { "enabled": true },
    "opencode": { "enabled": true },
    "zcode":    { "enabled": false, "commandTemplate": "" }
  },
  "defaults": { "timeoutMs": 300000, "maxConcurrent": 3, "defaultCwd": "" }
}
```

- `maxConcurrent`：同时派发到外部 agent 的在飞上限；排队期间取消立即生效
- zcode 走 `commandTemplate` 模板（`{prompt}` `{session}` `{cwd}`，单引号安全转义）
- 各家探测：claude 经 grun；codex 绝对 node 入口；opencode 强制 TMPDIR 归一；
  宿主环境缺失时 runner 自动补 PATH/HOME/TMPDIR

## 导入保真度

- claude：summary 标题、注入行过滤（尖括号开头）、sidechain 行跳过、tool_use/tool_result 配对
- codex：session_meta/首条非注入 user 作标题
- opencode：text 部件 + **tool 部件映射**（含 error 状态）
- zcode：按已验证 db.sqlite schema 只读读取（compaction 跳过）
- 落盘契约对齐宿主严格校验器：信封七键 / seq 从 0 连续 / 头含 version /
  turn/end 带 completed reason / lossless JSON

## 安全须知

- 派发真实消耗对应 agent 的 API 额度，且可能在其 cwd 内读写文件——重要操作先征得同意
- 导入对外部存储只读；台账 `~/.dsh/agent-alliance/imports.json` 幂等
- client 入口受 `tests/manifest-guard.test.js` 保护（2026-08-21 web 连崩事故防线）

## 开发

```bash
node --test --test-timeout=5000 'tests/*.test.js'   # 全量测试
node tests/.probe-real.mjs                          # 真实探测四家 CLI
node tests/.probe-browse.mjs                        # 真实浏览三家会话（只读）
```

文档：`docs/SPEC.md`（架构）、`docs/VERIFICATION-P1.md`（验证记录）、
`docs/ROADMAP.md`（后续计划）。
