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
      # 两个能力是分开的：
      #   enabled  —— 历史会话浏览 + 导入（官方没有这两项）
      #   dispatch —— 本插件是否充当该家的派发目标（官方对已覆盖的家做得更好）
      # 所以已覆盖的三家保留 enabled、默认 dispatch:false；
      # 想恢复用本插件派发它们，显式写 dispatch: true。
      claude:   { enabled: true,  dispatch: false }
      codex:    { enabled: true,  dispatch: false }
      opencode: { enabled: true,  dispatch: false }
      zcode:    { enabled: false, dispatch: true, commandTemplate: '', resumeTemplate: '' }
    defaults: { timeoutMs: 300000, maxConcurrent: 3, defaultCwd: '' }
    panel: { enabled: true }
    legacyConfigFile: true
```

- `subagentProvider` **默认为空**（该家只走 CLI 包装层）；显式填写才启用官方 backend 路径
- `dispatch: false` 会让 `agent_dispatch` 明确拒绝派发该家，并指出应改用的官方工具与覆盖开关；
  **历史浏览与导入不受影响**——官方 seam 完全没有这两项能力，裁重复不能连带删掉它们
- **升级注意**：默认值变了。以前依赖 `agent_dispatch` 派发 claude / codex / opencode 的用法，
  需显式设置 `providers.<id>.dispatch = true` 才能继续

### 第三方 agent（opencode / zcode）如何"进官方"

官方没有为任何第三方 CLI 做 provider（npm 上的官方 subagent 包只有
`spawn` / `fork` / `codex` / `claude-code` / `acp` / `dsh-sdk`）。
官方给第三方 agent 留的**唯一正式通道**是 `@deepseek-ai/dsh-subagent-acp`：

```yaml
- id: subagent-acp
  name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: 'acp'
    command: '/path/to/agent-cli'   # 该 CLI 必须以 ACP 协议通信
    args: ['acp']                   # 按该 CLI 的 ACP 启动语法
```

它接受任何 ACP-compatible agent，`capabilities` 全为 false（out-of-process，
声明不出任何父进程能力）、`inheritsParentContext` 为 false。
**判据是那个 CLI 是否讲 ACP 协议**，不是它的牌子。

**实测结论（2026-11-23）**：

| agent | 支持 ACP？ | 证据 |
|---|---|---|
| **opencode v1 `1.19.6`** | **是** | `opencode acp` 是 stdio JSON-RPC 服务；`initialize` → `session/new` → `session/prompt` 完整往返，流式 `PONG` + `end_turn`，12.4s |
| **opencode v2 `2.3.2`** | **是** | 同上往返，5.4s；`protocolVersion` 仍为 1，但能力声明不同（见下） |
| zcode | **无法验证** | npm 上的 `zcode@0.0.1` 是无 bin 的空壳包（`description: "This is a nice project"`），非官方产物 |

> ⚠️ **v1 与 v2 是两套架构，不能用一版的结论代表另一版**：
> v2 不在 `opencode-ai` 这个包名下发布（那条线**只有 0.x/1.x**），而是 `@opencode/*` 拆包系列
> （`core` 有 38 个依赖，二进制以 4 个平台变体分发，**必须跑 postinstall**）。
> 两者的 ACP 能力差异：v2 **去掉** `mcpCapabilities.sse`，**新增**
> `sessionCapabilities.additionalDirectories` / `delete` 与 `_meta.steering`；
> v2 的 `acp` 子命令**没有** `--cwd`/`--port`（v1 有）。逐项对照见
> [docs/audit5/C4-acp-feasibility.md](docs/audit5/C4-acp-feasibility.md)。

所以 opencode 可以走上面的官方通道（两版只是 `command` 不同）：

```yaml
# v1
- id: subagent-acp
  name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: 'opencode'
    command: '/path/to/opencode-ai/bin/opencode.exe'
    args: ['acp']
    # 注意：permission 对 opencode 无效（见下）

# v2
- id: subagent-acp
  name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: 'opencode2'
    command: '/path/to/@opencode/cli-linux-x64/bin/opencode'
    args: ['acp']
```

**这两个配置都需要进程环境里有可用代理**，否则 `session/prompt` 会超时——
实测同一个二进制换代理就从不返回变成 5–12 秒返回，所以这不是可选项。

> ⚠️ **`permission` 对 opencode 无效**。官方 `subagent-acp` 的 `permission: 'allow'|'reject'`
> 只在子 agent 主动发 `session/requestPermission` 时起作用，而 opencode **一次都不发**
> （实测 build / plan 两种模式下都是 0 个请求，文件照样写出来）。
> 所以把 opencode 接进官方 ACP 时，**它会在 cwd 里读写文件且没有任何审批环节**。
> 详见 [docs/audit5/C5-acp-permission.md](docs/audit5/C5-acp-permission.md)。

**但两条路是并存而非二选一**，因为官方 ACP provider 的能力边界是：
`agentOptions:false`（不能指定 model）、`outputSchema:false`、`inheritsParentContext:false`
（不继承父上下文、一次性、不能续聊）。本插件的 CLI 包装层补齐的正是这些：
`resumeSessionId`、`model` 覆盖、以及会话历史浏览与导入。
- `zcode` 走 `commandTemplate` 模板（`{prompt}` `{session}` `{cwd}`，单引号安全转义）
- `maxConcurrent` 限制同时派发到外部 agent 的在飞数量；排队期间取消立即出队
  **作用域是「每个插件实例」**，不是每个 Agent：三个 Session 共享同一个已加载插件时总共只有 3 个槽位。
  官方 `maxActiveSubagents` 是「每个根 Agent 树」，两者是不同策略——而且官方池只作用于经
  `ctx.subagents` 路由的调用，外部 CLI 派发不走那条链路，这正是本插件自己需要这道闸门的原因
- 各家探测（**仅 CLI 路径**）：claude 经 grun；codex 绝对 node 入口；opencode 强制 TMPDIR 归一；
  宿主环境缺失时 runner 自动补 PATH/HOME/TMPDIR。官方后端使用包内自带的平台 payload，
  **不经过 grun 也不使用宿主 PATH 上的同名 CLI**。
- **路径默认是 Termux/ARM64 时代的遗留值**（`$PREFIX` = `/data/data/com.termux/...`，且 claude 二进制
  名硬编码 `claude-code-linux-arm64`）。在普通 x86_64 Linux 上，请**显式配置路径**，否则 `detect()`
  会误报"路径不存在"而不是"未安装"：

```yaml
providers:
  claude:
    enabled: true
    paths:
      grun: /usr/bin/grun                    # 或直接指向 claude 的启动器
      claudeBin: /usr/local/bin/claude
      projectsRoot: /home/you/.claude/projects
  codex:
    enabled: true
    paths:
      codexJs: /usr/local/lib/node_modules/@openai/codex/bin/codex.js
      sessionsRoot: /home/you/.codex/sessions
```

  `paths` 的具体键随各家而异（见 `src/provider/*.js` 的 `*DefaultPaths()`）。所有值必须是非空字符串；
  配置错误会在加载时报错。

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
