# 从 0.1.0 升级到 0.2.0

0.2.0 是一次对齐 DSH `0.2.1-rc.2` 的重写。0.1.0 写于 `0.1.0-rc.6` 时代，有五处契约已经失效；
本文件逐条说明变化与迁移动作。

## 一句话

把 Codex / Claude Code 的派发交给官方实验化子代理包，插件自己只保留「无 Agent 身份」「要续聊外部会话」
「要读/导入历史会话」这三类 CLI 场景。

## 升级步骤

1. **升级 DSH 到 0.2.1-rc.2 或更新**，然后替换插件目录并重启。
2. **启用官方子代理包**（二选一）：
   - 设置 → 插件 → 搜索并启用 `@deepseek-ai/dsh-subagent-codex`、`@deepseek-ai/dsh-subagent-claude-code`；
   - 或命令行：`dsh plugin --profile web add @deepseek-ai/dsh-subagent-codex@0.2.1-rc.2`，
     `claude-code` 同理。
   插件启动时会探测 `ctx.subagents`，探测到就优先走官方后端，不需要额外配置。
3. **如果用过旧 ACP 挂载**（`@zed-industries/claude-code-acp`、自写 `scripts/cli-acp-bridge.mjs`、
   `subagent_opencode` 原生工具）：这些都已移除。改用 `@deepseek-ai/dsh-subagent-acp` 挂载需要的
   ACP agent，然后把 `providers.<id>.subagentProvider` 指向注册名。
4. **删除旧 profile 里的 ACP 相关行**（可选）：`dsh --profile web --dump-config` 检查是否还有
   指向 `cli-acp-bridge.mjs` 的 provider 行，有就删掉。
5. 重启后在「设置 → 插件」确认 `dsh-agent-alliance` 的标题/描述/图标与侧边栏入口正常。

## 破坏性变化

### 1. peerDependency 移除，运行时零依赖

0.1.0 声明 `peerDependencies: {"@deepseek-ai/dsh-tools": "^0.1.0-rc.6"}`，该范围排除 `0.2.x`，
导致 `import { defineTool } from '@deepseek-ai/dsh-tools'` 在运行时 `ERR_MODULE_NOT_FOUND`。

0.2.0 **不再 import 任何 `@deepseek-ai/*`**，改用原生 `ctx.tools.register({...})`，
`parameters` 直接写完整 JSON Schema。副作用：`defineTool` 的类型推断与参数校验没有了，
参数非法时由工具自身返回错误。

### 2. 工具参数 schema 形状变了

0.1.0（defineTool 方言）：

```js
parameters: { prompt: { type: 'string', required: true } }
```

0.2.0（原生 JSON Schema）：

```js
parameters: {
  type: 'object',
  additionalProperties: false,
  properties: { prompt: { type: 'string' } },
  required: ['prompt'],
}
```

模型看到的 schema 因此与 DSH 其他工具一致。

### 3. 后台任务走新 jobs 契约

| | 0.1.0（失效） | 0.2.0 |
|---|---|---|
| `jobs.start()` 返回 | `JobHandle` 对象 | `JobId` 字符串 |
| job 归属 | `owner: exec.agent`（Agent 对象） | `owner: exec.agent?.sessionId`（SessionId 字符串） |
| 读取输出 | `jobs.read(id).text` | `jobs.readAt(id, from)` → `{ chunks, next, lossy }` |
| 面板读取 | 自定义 `batches` Map | 无主 job + `jobs.list(undefined)` |

面板发起的工作是**无主 job**（`ctx.jobs.start({kind,label,run})` 不传 owner），
因此面板无需会话绑定即可列出、读取与取消。`ctx.jobs` 不可用时工具自动内联执行并直接返回前台结果。

### 4. 导入改为会话格式 v4

`SESSION_FORMAT_VERSION` 现在是 `4`，且 `sessionPersistence.append(id, events)` 这个服务级方法
**不存在**了——append/flush/close 都在 handle 上：

```js
const handle = await ctx.sessionPersistence.create({
  version: 4, id, createdAt, cwd, isSeeded: false,
})
try {
  await handle.append(events)
  await handle.flush()
} finally {
  await handle.close()
}
```

事件层面：

- `assistant/chunk` 事件类型已不存在。assistant 整段输出写一条
  `assistant/message`，`stream` 字段携带 `AssistantStreamRecord[]`
  （`{ type: 'text-chunks', time0, index, dt, texts }`）。
- `tool/result` 的 `message` 必须是 `role: 'tool'`，带 `toolCallId` 与
  `source: { kind: 'tool', callId }`。
- 每个 surface 事件（`user/message`、`assistant/message`、`tool/result`）必须带 `surfaceOp: 'append'`。
- `session/title` 仍是 log-only 事件，`{ title, messageSeqs, source: { kind: 'fallback' } }` 收尾。

**0.1.0 导入过的会话可以继续用**：它们是旧格式的合法日志，DSH 的相邻迁移链负责读取。
但请不要再用旧插件导入新会话。

### 5. 浏览器半边重写

0.1.0 用 `MutationObserver` 往侧边栏注入按钮，再手挂一个 `react-dom/client` root。
这不在当前 client-module 契约内（会被 release 身份校验、样式清理与 slot 折叠逻辑绕过）。

0.2.0 改成：

- `window.__ModuleLoader__.load({ id, factory })`，factory 返回 `{ inject, apply }`；
- `ctx.slots.inject('main', ...)` 提供面板页，`ctx.slots.inject('sidebar.panellist', ...)` 提供入口图标；
- 文案走 `ctx.locale.register('agentAlliance', { zh, en })`，用 `ctx.locale.bind()` 取；
- 样式只使用 `--dsw-alias-*` 令牌。

用户可见变化：面板从「浮层」变成中央视图（切走再切回保留状态由宿主管理），
入口图标跟随侧边栏列表排序（`order: 30`）。

### 6. HTTP 端点必须过信任校验

0.1.0 的 `/__agent-alliance/*` 直接可用。0.2.0 每个 handler 先调用
`ctx.connection.admit({headers})` / `ctx.connection.requestRejection({headers})`，
未通过返回 401/403/503 且**不触达任何外部 agent**。

同时响应体统一成 `{ ok: true, ... }` / `{ ok: false, error, code? }`。
如果你有自建脚本调这些端点，需要解包 `ok`。

路由也从「按 exact 逐条注册」改成「一条 `prefix` /__agent-alliance」，路径本身不变。

### 7. 配置优先级

新增 `cordis.patch.yml` 行内 `config` 层，优先级最高：

```
row config  >  ~/.dsh/dsh-agent-alliance.json  >  内建默认
```

旧的 JSON 文件继续有效；设 `legacyConfigFile: false` 可让行内配置独占。

新增字段 `providers.<id>.subagentProvider`（默认 `claude` → `claude-code`、`codex` → `codex`），
省略即该家只走 CLI。

## 需要人工确认的残留

- `~/.dsh/dsh-agent-alliance.json` 里如果有旧字段（如 panel 相关的手工键），0.2.0 会原样保留但不读取未知键。
- 官方子代理包自带原生 Codex / Claude Code payload，与系统里单独装的 CLI 互不影响；
  `subagentProvider` 走官方包时不使用 `claude`/`codex` 的系统 PATH。
