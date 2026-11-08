# dsh-agent-alliance

DeepSeek Harness **扩展插件**：把 **Claude Code / Codex / OpenCode / ZCode** 这些**外部 agent** 接进 DSH——
派发任务、并发圆桌、浏览它们的历史会话、把历史事件级导入为可继续的 DSH 会话。

> **定位：只做官方没有的事。**
> DSH 本身已经内置了完整的子智能体体系（见下），本插件**不重复**它。我们负责的是**外部 agent**
> ——那些不在 DSH 进程内、有自己 CLI 与账号体系、历史存在自己目录里的编码助手。

## 先搞清楚：DSH 自带什么

在装本插件之前，你的每个会话**已经**有这些（来自 `dsh-base`，无需任何配置）：

| 官方工具 | 作用 | 关键特性 |
|---|---|---|
| `subagent` | 派发一个**自包含**任务给子代理（spawn provider） | 子代理空上下文；立即返回 id，完成时通知 |
| `subagent_fork` | 派发一个**延续本对话**的子任务（fork provider） | 子代理继承父对话所有已完成轮次 |

`subagent_fork` 是为 **KV cache 复用**设计的：base bundle 的注释明确写着

> Fork omits model selection so provider/model stay equal to the parent and the inherited
> history remains eligible for **KV Cache reuse**.

也就是说，**想复用父会话缓存，用 `subagent_fork`，不要用本插件**。这是 DSH 内部最省钱的派发方式，
本插件提供的任何外部路径都做不到这一点（外部 CLI 是独立进程，缓存不共享）。

启用官方 vendor 包后还会多出 `subagent_codex` / `subagent_claude_code`（同样是异步、池化、带 system prompt 引导）。

**结论：需要 DSH 内部子代理时，用官方工具。本插件不解这个问题。**

## 本插件解决什么

外部 agent 有三个官方没有的问题：

1. **它们不在 DSH 里** —— 没有 provider 注册，官方工具够不着
2. **它们的会话历史在别处** —— `~/.claude/projects`、`~/.codex/sessions`、`opencode.db`、`zcode` 的 sqlite
3. **它们要并发对比** —— 同一问题发给多家，收集各自观点

对应的六件工具：

| 工具 | 解决什么 |
|---|---|
| `agent_dispatch` | 把任务派给外部 CLI，**同步**拿回答（这是与官方异步工具的主要差异） |
| `agent_roundtable` | 同一问题并发发给多家外部 agent，可多轮辩论 |
| `agent_sessions` / `agent_session_read` | 浏览外部 agent 自己的历史会话 |
| `agent_import_scan` / `agent_import` | 把外部会话**事件级导入**为可继续的 DSH 会话 |

## 可选：把官方 backend 也接进本插件的派发

本插件**默认不绑定**官方 provider（`subagentProvider` 默认为空）。如果你确实希望用
`agent_dispatch` 的**同步**语义去驱动官方 Codex / Claude Code，可以显式打开：

```yaml
- id: agent-alliance
  config:
    providers:
      codex: { subagentProvider: 'codex' }
      claude: { subagentProvider: 'claude-code' }
```

需要先在「设置 → 插件」启用 `@deepseek-ai/dsh-subagent-codex` / `-claude-code`。插件会在运行时检查
`ctx.subagents` 是否注册了对应 provider（**不检查包的 payload 是否存在**）。

> provider 名字由**官方包自己的 `providerName` 配置**决定（默认 `codex` / `claude-code`）。
> 如果你改了它，必须把 `subagentProvider` 改成同名，否则官方路径**静默不生效**并回落到 CLI。
> 面板「状态」标签的 `detail` 会显示真实注册名。

### ⚠️ 权限模式不由本插件设置

两个官方包的 `permissionMode` 默认值**不同**，本插件**从不覆盖**：

| 包 | 默认 `permissionMode` | 实际含义 |
|---|---|---|
| `dsh-subagent-codex` | `never` | 不弹审批（只发 `approvalPolicy: never`，**不传 sandbox**，用 Codex 原生沙箱配置） |
| `dsh-subagent-claude-code` | `dontAsk` | 未预先授权的操作**直接拒绝**而非询问 |

后果需要你自己判断：

- 走 **codex** 官方后端：任务在原生沙箱内自动执行，不打扰你，但也不经你确认。
- 走 **claude-code** 官方后端：**会改文件的任务可能做不动**——授权请求被拒，而模型可能仍返回一段
  说明性文字，本插件会把它当作成功结果。

要改行为，请在启用官方包的 patch 行里显式配置 `permissionMode`，而不是期望本插件替你选。

### 环境变量

两条派发路径对子进程环境的处理**一致**：

- **官方后端**：由 host 的 subagent seam 清理 `*KEY*` / `*PASSWORD*` / `*SECRET*` / `*TOKEN*` 与全部 `DSH_*`。
- **CLI 包装层**（面板走这条）：本插件同样清理这些名字（`src/runner.js`），不会把宿主的 API key
  交给第三方 CLI。显式传入 `env` 的条目会被保留——那是调用方的明确选择。

## 优先级建议

| 你的需求 | 用什么 |
|---|---|
| 让子代理做自包含的研究/实现 | 官方 `subagent` |
| 让子代理接着本对话做后续分析 | 官方 `subagent_fork`（**还能吃缓存**） |
| 用官方 Codex / Claude Code 后端 | 官方 `subagent_codex` / `subagent_claude_code` |
| 调度本机的 Claude Code / Codex / OpenCode / ZCode CLI | 本插件 `agent_dispatch` |
| 同一问题多家对比 | 本插件 `agent_roundtable` |
| 翻/导入外部 agent 的历史 | 本插件 `agent_sessions` / `agent_import` |

## 模型工具细节

| 工具 | 补充说明 |
|---|---|
| `agent_dispatch` | 前台等待或后台 job（`job_output`/`job_kill`）；受 `maxConcurrent` 并发上限约束（排队期间取消立即生效）；官方后端无法应用 `model` 覆盖时会返回 `ignored: ["model"]` |
| `agent_roundtable` | 可跑 1–3 轮辩论；第 2 轮起把问题作为**严格前缀**再追加同伴发言（让缓存能复用），并排除成员自己的上一轮发言 |
| `agent_sessions` / `agent_session_read` | 只读 |
| `agent_import_scan` / `agent_import` | 幂等、自动归组工作区、预热投影缓存 |

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
      # 默认不带 subagentProvider：官方工具已经覆盖那部分能力。
      # 需要本插件的同步语义去驱动官方 backend 时再显式打开（见上文）。
      claude:   { enabled: true }
      codex:    { enabled: true }
      opencode: { enabled: true }
      zcode:    { enabled: false, commandTemplate: '', resumeTemplate: '' }
    defaults: { timeoutMs: 300000, maxConcurrent: 3, defaultCwd: '' }
    panel: { enabled: true }
    legacyConfigFile: true
```

- `subagentProvider` **默认为空**（该家只走 CLI 包装层）；显式填写才启用官方 backend 路径
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
