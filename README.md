# dsh-agent-alliance

DeepSeek Harness 双面插件：让 DSH 与 **Claude Code / Codex / OpenCode / ZCode** 协同——
优先走官方子代理后端派发，回落到各家 CLI 包装层；附带圆桌讨论、外部会话浏览与历史会话导入。

> **0.2.0 是一次规范化重写**：对齐 DSH `0.2.1-rc.2`（会话格式 v4、jobs 契约、client-module 契约），
> 并把 Codex / Claude Code 的派发切到官方实验化子代理包。从 0.1.0 升级见
> [docs/MIGRATION-0.2.md](docs/MIGRATION-0.2.md)。

## 设计：两层派发

派发一个任务时，插件按以下顺序选后端：

| 顺序 | 后端 | 条件 | 特点 |
|---|---|---|---|
| 1 | `subagent`（官方） | 配置里 `subagentProvider` 指向的 provider 已注册在 `ctx.subagents`，**且** 调用方是一个活的 Agent | 官方实验包托管生命周期与模型；权限由**包自身的 `permissionMode` 默认值**决定（见下）；一次性、隔离、只回最终答复 |
| 2 | `cli`（包装层） | 其余情况（无 Agent 身份、未装官方包、用到 `resumeSessionId`） | 直调本机 CLI；可续聊外部会话；历史会话可浏览/导入 |

官方后端来自这两个包，在「设置 → 插件」里启用即可，插件会在运行时检查 `ctx.subagents` 是否注册了对应 provider（**不检查包的 payload 是否存在**）：

- `@deepseek-ai/dsh-subagent-codex` → provider `codex`
- `@deepseek-ai/dsh-subagent-claude-code` → provider `claude-code`

> 这两个名字由**官方包自己的 `providerName` 配置**决定（默认就是上面这两个）。如果你在启用官方包时改了
> `providerName`，必须把本插件的 `providers.<id>.subagentProvider` 改成同一个名字，否则官方路径会
> **静默不生效**并回落到 CLI。面板「状态」标签会在 `detail` 里说明真实的注册名，便于发现这种不一致。

官方子代理是**一次性**的：`resumeSessionId` 在这条路上会被明确拒绝，需要续聊请走 CLI 包装层
（也可用 `agent_sessions` 找到外部会话 id 后显式指定）。每个工具结果都带 `backend` 字段，标明这次走的是哪条路。

### ⚠️ 权限模式不由本插件设置

两个官方包的 `permissionMode` 默认值**不同**，而本插件**从不覆盖**它们：

| 包 | 默认 `permissionMode` | 实际含义 |
|---|---|---|
| `dsh-subagent-codex` | `never` | 不弹审批；执行失败在原生 sandbox 下返回给模型 |
| `dsh-subagent-claude-code` | `dontAsk` | 未预先授权的操作**直接拒绝**而非询问 |

后果需要你自己判断：

- 走 **codex** 官方后端时，任务在 sandbox 内自动执行，不打扰你，但也不经你确认。
- 走 **claude-code** 官方后端时，**会改文件的任务可能做不动**：授权请求被拒，而模型可能仍返回一段
  说明性文字，本插件会把它当作成功结果（`stopReason === 'completed'` 且有文本）。

要改变这些行为，请在启用官方包的 patch 行里显式配置 `permissionMode`，而不是期望本插件替你选。

### 环境变量

两条派发路径对子进程环境的处理不同：

- **官方后端**：由 host 的 subagent seam 清理 `*KEY*` / `*PASSWORD*` / `*SECRET*` / `*TOKEN*` 与全部 `DSH_*` 变量。
- **CLI 包装层**（面板走这条）：本插件同样清理这些名字（`src/runner.js`），因此不会把宿主的 API key
  交给第三方 CLI。显式传入 `env` 的条目会被保留——那是调用方的明确选择。

## 模型工具（6 个）

| 工具 | 说明 |
|---|---|
| `agent_dispatch` | 派发任务；前台等待或后台 job（`job_output`/`job_kill`）；受 `maxConcurrent` 并发上限约束（排队期间取消立即生效） |
| `agent_roundtable` | 同一问题并发发给多个 agent，可跑 1–3 轮辩论（后续轮可见其他 agent 上一轮发言），输出对比文本 |
| `agent_sessions` / `agent_session_read` | 浏览 / 读取外部 agent 本机历史会话（只读） |
| `agent_import_scan` / `agent_import` | 扫描四家历史会话并事件级导入为可继续的 DSH 会话（幂等、自动归组工作区、预热投影缓存） |

工具描述里写明了成本：**派发会真实消耗目标 agent 的额度，且它可能在 cwd 内读写文件**——重要操作先征得同意。

## Web 面板

侧边栏「Agent 协同」入口 → 中央视图五标签：状态 / 外部会话 / 派发 / 圆桌 / 任务。

实现走当前 client-module 契约：`__ModuleLoader__` 注册的 factory 返回 `{ inject, apply }`，
通过 `ctx.slots` 注册到 `main` 与 `sidebar.panellist`，文案全部经 `ctx.locale` 的 zh/en 字典，
样式只使用 `--dsw-alias-*` 皮肤令牌。数据来自 `/__agent-alliance/*` 端点。

**所有 HTTP 端点先过连接信任校验**（`ctx.connection.admit`），未通过直接 401/403/503，不会触达外部 agent。

端点一览：

| 方法 + 路径 | 用途 |
|---|---|
| `GET /state` | provider 清单（id/kind/available）+ 最近派发 |
| `GET /sessions` `GET /session-content` | 外部会话列表 / 单会话内容 |
| `POST /import` | 导入外部会话 |
| `POST /dispatch` | 派发（无 Agent 身份，固定走 CLI 后端） |
| `POST /roundtable` | 发起圆桌（返回 `jobId`） |
| `GET /tasks` `GET /tasks/output` `POST /tasks/kill` | 任务中心的列出 / 增量读 / 取消 |

## 安装

```jsonc
// ~/.dsh/profiles/web/package.json
"dependencies": { "dsh-agent-alliance": "link:/path/to/dsh-agent-alliance" }
"dsh": { "profile": { "bundles": [ …, "dsh-agent-alliance" ] } }
```

或让 Plugin Manager 从本地目录安装（`install_bundle` 指向包目录）。

**运行时零 npm 依赖**：包内不 import 任何 `@deepseek-ai/*`，所以 rc 版本升级不会让插件失联。
官方后端包由 DSH 自身安装与解析，插件只在运行时按名称探测 `ctx.subagents`。

## 配置

优先级：`cordis.patch.yml` 行内 `config` > `~/.dsh/dsh-agent-alliance.json`（`legacyConfigFile: false` 可关闭）> 内建默认。

```yaml
- id: agent-alliance
  config:
    providers:
      claude:   { enabled: true, subagentProvider: 'claude-code' }
      codex:    { enabled: true, subagentProvider: 'codex' }
      opencode: { enabled: true }
      zcode:    { enabled: false, commandTemplate: '', resumeTemplate: '' }
    defaults: { timeoutMs: 300000, maxConcurrent: 3, defaultCwd: '' }
    panel: { enabled: true }
    legacyConfigFile: true
```

- `subagentProvider` 省略即该家只走 CLI 包装层
- `zcode` 走 `commandTemplate` 模板（`{prompt}` `{session}` `{cwd}`，单引号安全转义）
- `maxConcurrent` 限制同时派发到外部 agent 的在飞数量；排队期间取消立即出队
- 各家探测（**仅 CLI 路径**）：claude 经 grun；codex 绝对 node 入口；opencode 强制 TMPDIR 归一；
  宿主环境缺失时 runner 自动补 PATH/HOME/TMPDIR。官方后端使用包内自带的平台 payload，
  **不经过 grun 也不使用宿主 PATH 上的同名 CLI**。

## 导入保真度

- claude：summary 标题、注入行过滤（尖括号开头）、sidechain 行跳过、tool_use/tool_result 配对
- codex：session_meta/首条非注入 user 作标题
- opencode：text 部件 + **tool 部件映射**（含 error 状态）
- zcode：按已验证 db.sqlite schema 只读读取（compaction 跳过）
- 落盘对齐会话格式 v4：`seq` 从 0 连续、surface 事件带 `surfaceOp`、assistant 输出写单条
  `assistant/message`（含 `stream` 记录）、`session/title` 收尾、lossless JSON；
  写入走 `sessionPersistence.create → handle.append → flush → close`

## 安全须知

- 派发真实消耗对应 agent 的 API 额度，且可能在其 cwd 内读写文件——重要操作先征得同意
- 导入对外部存储只读；台账 `<DSH_HOME>/agent-alliance/imports.json` 原子写入、幂等
- HTTP 端点全部经过连接信任校验，面板发起的任务是无主 job（不绑定会话），取消同样走 `jobs.kill`
- client 入口受 `tests/manifest-guard.test.js` 保护（2026-08-21 web 连崩事故防线）

## 开发

```bash
node --test 'tests/*.test.js'          # 全量测试，零外部依赖、不消耗额度
node --check index.js && node --check client.js
```

测试全用 fixture 与假 ctx 服务驱动：不真调外部 CLI、不需要 DSH 包可解析。

文档：[docs/SPEC-v2.md](docs/SPEC-v2.md)（0.2.0 契约）、[docs/MIGRATION-0.2.md](docs/MIGRATION-0.2.md)（升级指引）、
[docs/ROADMAP.md](docs/ROADMAP.md)（后续计划）。

## License

MIT
