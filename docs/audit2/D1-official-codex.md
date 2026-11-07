# D1 — 官方行为审计：Codex bundle

> 角色：OFFICIAL-BEHAVIOR AUDITOR D1。判据一律以 **DSH 源码 checkout** 为准（该 bundle 本机未安装）。
> 对象：`/home/ova/dsh/.artifacts/dsh-plugins/dsh-agent-alliance` @ `1054bcb`（八次 fix commit 之后）。
> 权威源：`packages/subagent/subagent-codex/{README.md,cordis.patch.yml,package.json,src/*.ts}`、
> `packages/subagent/subagent/src/types.ts`、`packages/subagent/tool-subagent/src/index.ts`。
> 本文件是唯一写入；源码零改动。

## 结论速览

| # | 问题 | 判决 |
|---|---|---|
| Q1 | 双工具重复是否必须移除 `codex` 默认 subagentProvider | **需改默认值**（推荐移除），但**不要把 `agent_dispatch` 的 codex 一并删掉** |
| Q2 | `startActivation` 调用形状 | **完全正确**；`prompt`/`cwd`/`delivery`/`dispose`/未知字段全部对齐（`cwd` 的相对路径由 service 解析，我一度怀疑、已撤回）。**唯一问题是 `model` 被静默丢弃** |
| Q3 | resume 拒绝是否为真 | **为真**，但我们的错误文案**指错了方向**（说"用 CLI provider 续聊"，而 CLI 的 codex 会话与官方 thread 根本不是同一个东西） |
| Q4 | `permissionMode` 默认 `never` 是否安全 | **不安全**（对"模型可自主要求"的场景）。`never` 是"不审批"，不是"有沙箱"，且 README 把它称为 *Safe default* |
| Q5 | `maxConcurrent` 是否仍约束官方路径 | **约束，且相互独立**：`maxConcurrent`(3) < `maxActiveSubagents`(8)，我们的闸门更严，不会双计 |
| Q6 | `providerName` 改动会怎样 | **静默降级到 CLI**，无任何告警——这是最容易被误判为"官方路径生效了"的陷阱 |
| Q7 | 文档被官方源码推翻之处 | **1 处硬矛盾**（`externalSessionId = childId` 语义）+ **2 处遗漏/误导**（无 system prompt 章节；README 暗示了不存在的等价性） |

---

## Q1 — 双工具重复：`subagent_codex` vs `agent_dispatch(provider:'codex')`

### 判决：**重复是真的，危害是"中等且可修"，推荐改默认值而不是删能力**

#### 事实基础

bundle 一旦启用，`cordis.patch.yml:1-9` 会插入两行：
```yaml
- id: subagent-codex
  name: '@deepseek-ai/dsh-subagent-codex'
- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  config: { provider: codex, toolName: subagent_codex, maxDepth: provider-managed }
```
`tool-subagent` 是 **Host row**，README:59 明确："`subagent_codex` is a **global tool visible to every
preset**, including minimal."

而我们的 `src/config.js:19` 默认 `codex: { enabled: true, subagentProvider: 'codex' }`，
于是 `src/backend.js:367-376` 的 `resolve({provider:'codex', parent})` 在有活体 parent 时
**返回 `kind:'subagent'`**，走同一个 `ctx.subagents` provider。

⇒ **模型手里有两个工具，调用的是同一个 Codex provider、同一个 `ctx.subagents`、
同一份配额与认证。** 这不是"provider 重复注册"（没有 `DUPLICATE_PROVIDER`），纯工具层重复。

#### 危害在哪（按严重度）

**危害 1（主要）— 语义相反，且只有一方有系统提示。**

官方工具在 `packages/subagent/tool-subagent/src/index.ts:373-387` 注册了一段 system prompt：

```js
runtimeCtx.systemPrompt.section({
  name: `tool:${toolName}`,
  ...
  return `Start independent delegations with ${names} together in one assistant message and continue useful work while they run.`
})
```
它的工具描述（同文件 `:225-229`）也明说："**immediately returns its id. The runtime notifies you when
it finishes.**"

而我们的 `agent_dispatch`（`src/tools.js:314`）说的是
"Dispatch one task headlessly ... **and return its answer**" —— **阻塞等答案**。

我全仓 grep 了 `systemPrompt`：**我们的插件一处都没有注册**
（`grep -rn systemPrompt src/ index.js client.js` → 0 命中）。
所以模型看到的两个工具里：

| | 官方 `subagent_codex` | 我们 `agent_dispatch` |
|---|---|---|
| 谁在 system prompt 里被点名 | ✅ 有专门章节 | ❌ **完全没有** |
| 返回时机 | 立刻返回 id，稍后通知 | 阻塞到有答案 |
| delivery | `'parent'`（`tool-subagent:339`） | `'caller'`（`backend.js:292`） |
| 并发池 | `maxActiveSubagents`（默认 8） | 我们的 `maxConcurrent`（默认 3） |

**"plugin 的 system-prompt-free path 让哪个不可发现"** —— 答案是 `agent_dispatch`。
它只能靠工具描述自我推销，而官方工具既有章节又有描述，**在提示层面结构性占优**。
模型在"要并行派发"的场景会自然选官方工具；只在它明确需要"阻塞拿答案"时才可能选我们。

**危害 2（次要）— 并发口径分裂。** 见 Q5：两个池互不相通，模型混用时真实并发 =
`min(剩余 maxActiveSubagents, 剩余 maxConcurrent)` 之外还能叠加，因为**两个闸门各算各的**。

**危害 3（轻微）— 结果可见性不同。** 官方 `delivery:'parent'` 会在父 session 里
`establishExternalCatalogChild`（`manager.ts:507`），我们能通过 `subagent/catalog` 看到；
我们的 `delivery:'caller'` **不建 catalog child**，所以面板/会话日志里看不到这次派发。

#### 推荐（明确结论）

**把 `codex` 的默认 `subagentProvider` 去掉，但保留 `agent_dispatch` 的 codex CLI 路径。**

理由：
1. 只要 bundle 启用，官方工具就是**更好的默认选择**（有提示、有通知、有 catalog、有官方并发池）。
2. 我们的 `agent_dispatch` 仍然有价值：**前台阻塞拿答案**、**在 panel/HTTP 场景**（无 Agent 时
   官方路径根本走不到）、以及**官方 bundle 未启用时的 CLI 兜底**。
3. 但"默认走官方 provider"这个选择**不该由我们替用户做**——因为我们的路径**绕过官方工具**，
   在模型眼里是"另一个更差的 Codex"，而它连 system prompt 都没占上。

具体改法（`src/config.js:19`，`claude` 在 `:18`）：

```js
// 之前
codex: { enabled: true, subagentProvider: 'codex' },
// 之后：默认 CLI-only；用户在需要"走官方 provider 但不装官方工具"时再显式打开
codex: { enabled: true },
```

同时**考虑 `claude` 的同款改动**（`config.js:18`）——理由是对称的：`subagent-claude-code` 启用后
同样会有官方工具。

> 补充：如果不想改默认，退而求其次的最小修复是**给我们自己的 `agent_dispatch` 注册一段
> system prompt 章节**，说明它何时优于官方工具（需要阻塞答案 / 面板无 Agent / 想要统一
> 四家 provider 的接口）。但那是"补齐竞争条件"，不是"消除重复"，我更推荐改默认值。

#### 这个改法我已实测验证不会破坏面板路径

```
current default (subagentProvider: codex)
   with live parent -> kind = subagent | text = official
   panel (no parent)-> kind = cli      | text = cli-answer
recommended default (CLI-only)
   with live parent -> kind = cli      | text = cli-answer
   panel (no parent)-> kind = cli      | text = cli-answer
```

（`/tmp/d1_q1.mjs`，真实 `createBackendResolver`；脚本已删。）

关键：**panel/HTTP 路径本来就永远走 CLI**（HTTP 没有 Agent，`subagentRoute` 的
`isLiveAgent` 恒 false，`backend.js:78`）。所以改默认值**只影响有活体 Agent 的工具路径**，
面板行为零变化——这正是我们想要的最小影响面。

> **不建议**删除 `agent_dispatch` 的 codex 能力：HTTP/panel 路径（`src/http.js` 的
> `backendOf`）永远拿不到 Agent，**只能走 CLI**；删掉会让面板对 codex 彻底不可用。

---

## Q2 — `startActivation` 调用形状对齐

### 判决：**全部字段对齐（含一处自我撤回）；唯一实质问题是 `model` 被静默忽略**

我们的调用（`src/backend.js:280-306`）：
```js
const activation = await route.service.startActivation({
  provider: providerName,
  label: promptLabel(providerId, text),
  request: {
    prompt: [{ type: 'text', text }],
    parent,
    ...(typeof request.cwd === 'string' && request.cwd !== '' ? { cwd: request.cwd } : {}),
  },
  signal,
  delivery: 'caller',
})
```

逐项核对官方：

| 项 | 官方要求 | 我们 | 判决 |
|---|---|---|---|
| `request.prompt` | `ContentBlock[]`（`types.ts:140` `readonly prompt: ContentBlock[]`）；codex 只收 text 块（`run.ts:167-180` `textTask`） | `[{type:'text', text}]` | ✅ |
| `request.parent` | `Agent`（`types.ts:145`） | `parent`（调用方传入的活体） | ✅ |
| `request.cwd` | **`ResolvedSubagentStartRequest.cwd` 是必填绝对路径**（`types.ts:197-199`）；codex `start()` 里 `assertUsableCwd` 强校验（`index.ts:76`，`out-of-process.ts:105-113`） | **原样透传用户字符串，可能是相对路径** | ❌ **见下** |
| 未知字段 | `NO_START_CAPABILITIES` 全 false（`out-of-process.ts:56-62`），`assertCapabilities` 会拒（`subagent/src/index.ts:627-634`） | 我们**没有**传 `maxDepth`/`agentOptions`/`outputSchema`/`toolFilter`/`persona` | ✅ 正确 |
| `delivery` | `'parent' \| 'caller'`（`types.ts:43`） | `'caller'` | ✅ 见下 |
| 一次性 dispose | `dispose()` 幂等（`manager.ts:772-783` 的 `close` 用 `activation.closing` 记忆化） | `finally { await activation.dispose() }` | ✅ 不会双重释放 |

#### `delivery: 'caller'` 与官方工具 `'parent'` 的关系：**不冲突**

`delivery` 不是全局策略，是**每次 activation 的投递选择**。`manager.ts:1184`：

```js
private notifySettlement(activation, terminal) {
  if (!activation.announced || activation.delivery === 'caller') return
  ...
}
```
`'caller'` 只是**跳过自动通知**，把结果留在 `activation.result` 上让我们自己读完返回。
这正是我们想要的（`agent_dispatch` 同步返回）。它**不会**破坏官方工具自己的 `'parent'` 路径——
两者是同一个 service 上两个独立的 activation。

唯一副作用：`manager.ts:507` 的 `establishExternalCatalogChild` 只在 `delivery === 'parent'`
时执行，所以**我们的派发不会出现在 `subagent/catalog` 里**（见 Q1 危害 3）。这是设计选择，不是 bug。

#### ✅ `cwd` 我一度怀疑有缺陷，核对后**撤回**（保留记录以免重复劳动）

我最初怀疑：`backend.js:289` 原样透传 `request.cwd`，而 `ResolvedSubagentStartRequest.cwd`
的文档写的是 "**Absolute** child directory"（`types.ts:196-199`），codex provider 又有
`assertUsableCwd` 强校验绝对性（`subagent-codex/src/index.ts:76`）——
看起来相对路径会在 provider 处炸掉。

**证伪过程**：`manager.startExternal` 在调用 provider **之前**先做
`const cwd = await this.resolveDirectory(spec.request, spec.signal)`（`manager.ts:492`），
然后 `this.host.startExternal(spec.provider, { ...spec.request, cwd, ... })`（`manager.ts:500-502`）
——**传下去的是已解析的绝对路径**。`resolveDirectory`（`manager.ts:526-533`）：

```js
const cwd = request.cwd !== undefined && isAbsolute(request.cwd)
  ? request.cwd
  : resolve(await this.ctx.workingDirectory.ensure(request.parent, signal), request.cwd ?? '.')
```

⇒ 相对路径、`undefined`、`.` 全部会被 service 解析成绝对路径，`assertUsableCwd` 不会因
相对路径失败。**这不是缺陷，撤回。**

（真正会失败的是目录不存在/不可进入；`assertUsableCwd` 会给出
`child cwd is not an accessible directory`，属正常报错。）

#### `model` / `timeoutMs` 被静默丢弃 —— 这是设计，但值得写进契约

`backend.js:249-259` 的 JSDoc 说 "`model` and `timeoutMs` do not apply: official providers own
their route and limits"。核对官方：`SubagentStartRequest` 里**确实没有** model/timeout 字段
（`types.ts:136-188` 全字段已列），模型只能由 **bundle 的 config `model`** 固定
（`subagent-codex/src/index.ts:39-40`、README:43 "fixed for every thread from this provider instance"）。

⇒ 模型传 `agent_dispatch({provider:'codex', model:'gpt-5'})` 走官方路径时，**model 参数被静默忽略**，
不会报错、不会生效。这是**行为上的静默丢弃**，不是崩溃。

**建议**：`agent_dispatch` 在走 subagent 路径且 `args.model` 非空时，**明确报错或在返回里标注
"model ignored on official path"**，而不是静默忽略。当前实现两者都没做（`backend.js:296-306`
的返回里没有该信息），模型会以为自己换了模型。

---

## Q3 — resume 拒绝是否为真

### 判决：**拒绝为真；但我们的错误文案把用户引向错误的方向**

#### 官方确实是一次性

`subagent-codex/README.md:95`：
> "**One fresh process, thread, and turn per run.** Every run spawns a fresh app-server, creates one
> ephemeral thread, and executes exactly one turn; **there is no continuation, resume, or pooling**."

`:167` 再确认："there is no continuation, resume, pooling, progress stream, or product-session
persistence."

机制上也没有续聊入口：`SubagentRun` 只有 `result` / `dispose`，`thread/start` 传的是
`ephemeral: true`（README:110）。

⇒ `src/backend.js:280` 的提前拒绝**是正确且必要的**。

#### 但错误文案是误导的

`src/backend.js:168-181`：
```js
return new Error(
  'resumeSessionId is not supported on the official subagent path for provider "' + providerId + '"'
  + ' (official provider "' + providerName + '" is one-shot); use the CLI provider for external-session resume',
)
```

问题在最后半句 **"use the CLI provider for external-session resume"**。它暗示"官方 thread 和
CLI 会话是同一段对话，换个通道就能接着聊"。**这是假的**：

- 官方路径的 `childId` 是 **DSH 自己在 `manager.ts:488` 用 `randomUUID()` 生成的内部 id**
  （`brandString<SessionId>(randomUUID())`），**不是 Codex 的 session id**。
- 官方 thread 是 `ephemeral: true`，**Codex 侧根本不保留可续的会话**。
- 我们 CLI 路径（`src/provider/codex.js:47` `resume <id|last>`）续的是
  `~/.codex/sessions/**/rollout-*.jsonl` 里**另一次独立运行的 Codex CLI 会话**。

⇒ 即使模型照做去用 CLI 续聊，也**不可能接上刚才那个官方 thread**——那段对话在 Codex 侧
已经不存在了。正确文案应该是：

> "official Codex subagents are one-shot and ephemeral; this delegation cannot be resumed at all.
> To continue the work, dispatch a new task that restates the needed context."

**建议**：把 `resumeRejection` 的措辞改为"不可续，需重新陈述上下文"，并**删除**"use the CLI
provider"这半句（它只在**同一个外部 CLI 会话**的场景下成立，与官方 thread 无关）。

#### 附带：`externalSessionId` 的语义在两条路径上不一致（Q7 相关）

| 路径 | `externalSessionId` 实际含义 |
|---|---|
| CLI（`codex.js:56`） | **真实的 Codex 会话 id**，可用于 `resumeSessionId` |
| 官方（`backend.js:306`） | `activation.childId` = **DSH 内部随机 UUID**，**不可用于 resume** |

而 `agent_dispatch` 的返回字段名是同一个 `externalSessionId`，描述也没区分
（`src/tools.js:318` "resumeSessionId continues one of that agent's existing sessions
(find ids with agent_sessions)"）。模型拿到官方路径返回的 `externalSessionId` 后，
**用于 `resumeSessionId` 会被 `resumeRejection` 拒绝**——它能"看见 id 却用不了"。
这是 Q7 的硬矛盾之一。

---

## Q4 — `permissionMode` 默认 `never`：安全吗？

### 判决：**不安全。`never` 是"不问"，不是"有沙箱"。模型静默获得无审批执行权。**

#### 官方权限表（README:48-52，逐字引用）

| `permissionMode` value | `thread/start` fields | Native behavior |
|---|---|---|
| `never` | `approvalPolicy: never`; **sandbox omitted** | Never ask for approval; execution failures return to the model under the native sandbox |
| `approve-for-me` | `approvalPolicy: on-request`, `approvalsReviewer: auto_review`, `sandbox: workspace-write` | Route permission requests through Codex automatic review without a human |
| `dangerously-bypass-approvals-and-sandbox` | `approvalPolicy: never`, `sandbox: danger-full-access` | Skip approval and sandbox enforcement; this value must be selected explicitly |

#### 关键事实（源码级，比 README 表格更硬）

`subagent-codex/src/wire.ts:32-44` 是**实际发往 `thread/start` 的参数表**：

```js
const THREAD_PERMISSION_PARAMS: Readonly<Record<CodexPermissionMode, JsonObject>> = {
  never: { approvalPolicy: 'never' },
  'approve-for-me': {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: 'workspace-write',
  },
  'dangerously-bypass-approvals-and-sandbox': {
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  },
}
```

**`never` 分支的对象里只有 `approvalPolicy: 'never'` 一个键——`sandbox` 键完全不存在。**
对照 README:50 的措辞 "sandbox omitted"，这条是精确的：不是"设成某个宽松值"，
而是**根本不发送**，于是 Codex 使用它自己的原生配置（可能配了，也可能没配）。

#### 其余关键事实

1. **默认值是 `never`**：`run.ts:73` `export const DEFAULT_CODEX_PERMISSION_MODE: CodexPermissionMode = 'never'`
   （注释写的是 `/** Safe default for unattended Codex runs. */`）。
   `index.ts:56-57` 与 `:112` 都把它当作 config 省略时的兜底。
2. **我们的插件从不设置它**：`grep -rn permissionMode src/ index.js` → **0 命中**。
   所以走我们路径的每一次官方 codex 派发，**必然是 `never`**。
3. `never` 的真实含义是 **`approvalPolicy: never`（永不询问）+ `sandbox` 字段省略**。
   "sandbox omitted" 意味着**不覆盖** Codex 原生配置——沙箱强度取决于用户
   `~/.codex/config.toml` 里有没有配；**插件既不设也不校验**。

#### 危险组合

把它和我们的工具描述放在一起看（`src/tools.js:17`）：
```js
const COST_WARNING = 'This spends the target agent\'s quota and it may read or write files in its cwd; confirm before important work.'
```
这只是一句**给模型看的提醒**，不是审批闸门。真实链路是：

```
模型自主决定 → agent_dispatch(provider:'codex') → startActivation(delivery:'caller')
  → permissionMode = never（我们没设，用默认）
  → approvalPolicy: never（不询问），sandbox 省略（不强制）
  → Codex 直接执行文件写/命令
```

**全程没有人类批准**。`dsh-tool-jobs` 那套 approval 机制对 subagent 路径不适用——
subagent 不经过 DSH 的 approval seam，它是把任务整包丢给一个外部进程。

而且 README:172 明确写了这是设计：
> "**No human approval path** — known unattended approval requests are denied and unknown server
> requests fail closed; the three Profile modes never create a DSH interaction channel or per-call
> allow policy."

#### 判断

**不安全**，理由有三：

1. **默认值是给"无人值守批处理"设计的**，而我们的调用是**模型自主发起**的。二者不是一回事：
   批处理的发起者是人类（他配了 bundle），模型派发的发起者是模型。
2. **`never` 不提供任何沙箱保证**。"sandbox omitted" 只是"不覆盖"，用户若没配 Codex 沙箱，
   就是真·无沙箱。README 把它写成 *Safe default* 有误导性——它 safe 的前提是
   "native sandbox 已配好"，而插件**无法验证这一点**。
3. **我们没有任何地方告诉用户这件事**。README/SPEC 都没提 `permissionMode`
   （`grep -rn permissionMode` 在插件仓库 → 0 命中）。用户启用 bundle + 我们的插件后，
   模型就能无审批地让 Codex 改文件。

**建议**（按优先级）：
1. 插件**不提供** `codex.subagentProvider` 默认（同 Q1 建议）——把"是否让官方 codex 无审批执行"
   这个决定还给用户。
2. 若保留官方路径，在 `agent_dispatch` 描述与 README 里**显式写明**："delegations run with the
   bundle's `permissionMode` (default `never`: no approval prompt, native sandbox unchanged)"。
3. 长期：给插件加一个 `providers.codex.requirePermissionMode` 校验，或至少把 bundle 的
   `permissionMode` 读出来在 `/state` 里展示。

---

## Q5 — `maxConcurrent` 是否仍约束官方路径？会不会双计？

### 判决：**约束，且独立，不双计。我们的闸门更严。**

两套限制**不同层、不同变量**：

| | 我们的 | 官方 |
|---|---|---|
| 配置名 | `defaults.maxConcurrent`（`src/config.js:25`，默认 **3**） | `maxActiveSubagents`（`subagent/src/index.ts:186,195`，默认 **8**） |
| 实现 | `src/tools.js` 的 `createSemaphore` | `ActivationPool.reserve`（`activation.ts:16-34`） |
| 作用对象 | **每一次 `backend.dispatch()`**，含官方路径 | **每一个 live Activation** |
| 超限行为 | 排队等待 | **抛错** `ACTIVATION_LIMIT_REACHED`（`activation.ts:26-31`） |

顺序上，我们的 gate 在外层：`src/tools.js:293`（前台）、`:379`（后台）与 `:461`（圆桌）都是
`gate.run(signal, () => backend.dispatch(...))`；`backend.dispatch` 内部才调
`startActivation`（`backend.js:283`）。圆桌也已纳入同一闸门
（`:455-463` 的 `gatedRegistry`）。

⇒ **不会双计**，因为两者不是同一计数：我们的 3 个槽位**限制并发进入**，
官方的 8 个槽位**限制存活**。3 < 8，所以正常情况下**我们的闸门先满**，官方池永远不会触发。

**但有两个边角**：

1. **跨工具共享官方池**：模型若同时用 `subagent_codex`（官方工具，**不过我们的闸门**）
   和 `agent_dispatch`，官方的 8 池会被两边共同消耗。我们只保证自己那 3 个，
   真实并发上限 ≈ `我们的 3 + 模型直接调官方工具的数量`。这是 Q1 重复问题的直接后果。
2. **官方池超限会抛错而不是排队**：如果模型用官方工具把 8 个池占满，我们第 4 个
   `agent_dispatch` 即使拿到了我们的槽位，也会在 `startActivation` 里**抛
   `ACTIVATION_LIMIT_REACHED`**。我们的 gate 会正常释放槽位（`finally` 在
   `tools.js` 的 semaphore 里），但这会表现为"我们的工具失败了"，而真实原因是别的工具占满了池。

**建议**：`backend.js` 在捕获到 `ACTIVATION_LIMIT_REACHED` 时，把错误文案改写成
"another delegation (possibly the official `subagent_codex` tool) holds the subagent pool"，
避免用户误以为是本插件的问题。

---

## Q6 — `providerName` 与 `subagentProvider` 不一致时会怎样？

### 判决：**静默降级到 CLI，无任何告警。这是最危险的"看起来生效了"陷阱。**

详细分析见 [`docs/audit2/` 本文件 Q6 实测](#q6-实测)。复现：

```
bundle providerName = "my-codex", our subagentProvider = "codex"
resolver.list(parent): [{"id":"codex","label":"Codex CLI","kind":"cli","available":true}]
resolve().kind = cli  (subagent expected if it were wired)
dispatch -> {"text":"cli","externalSessionId":null,"durationMs":0,"backend":"cli"}
```

（`/tmp/d1_q6.mjs`，真实 `createBackendResolver` + 假 `ctx.subagents`，脚本已删。）

#### 机制

`subagentRoute`（`src/backend.js:75-82`）只做一件事：拿 `config.providers[providerId].subagentProvider`
的名字去 `usableSubagentService`（`:55-73`）里查 `service.list().includes(name)`。
名字不匹配 → 返回 `undefined` → `resolve()` 落到 `cliOrThrow(registry, providerId)`（`:338`）。

而 `buildProviders`（`src/providers.js:17-29`）**无条件**构造了四家 CLI provider，
所以 `registry` 里永远有 `codex` ⇒ **CLI 路径永远可用** ⇒ **永远静默降级，永不报错**。

#### 为什么危险

1. **返回值里 `backend: 'cli'` 是唯一线索**，而且它只出现在成功返回的 JSON 里。
   模型不会去比对，用户更不会。UI 的终端卡片只显示 output，不显示 backend
   （`src/tools.js:354-364` 的 `presentResult` 只取 `result.content[0].text`）。
2. **`/state` 会显示 `available: true`**（`backend.js:400-407` 的 `cli.found` 分支），
   于是面板看起来"codex 一切正常"，实则官方路径从未被走到。
3. **权限语义全变了**：走 CLI 时是我们自己的 `spawnCli`（无 `permissionMode` 概念），
   走官方时是 `never` 无审批。用户以为在用一个，实际在用另一个。

#### 建议

1. **名字不匹配时必须告警**。`/state` 的 `detail` 已经会说
   `'no CLI provider registered; official subagent provider "<name>" needs a live parent agent'`
   —— 但**只在 CLI 也不存在时**才显示（`backend.js:415-425`）。CLI 存在时这条信息完全不出现。
   建议：当 `config.providers[id].subagentProvider` **设置了但没注册**时，
   即使 CLI 可用，也在 `detail` 里追加 `official provider "<name>" is configured but not registered; using CLI`。
2. README 里把"`providerName` 必须与 `subagentProvider` 一字不差"写成**显式约束**，
   最好给个 `providerName: codex` 的例子。
3. 长期：把 `subagentProvider` 的匹配改成**启动期校验**（`apply()` 时若
   `ctx.subagents` 已存在且名字不在 `list()` 里，`logger.warn` 或直接失败），
   而不是等到 `list()`/`resolve()` 时静默回落。

---

## Q7 — 文档被官方源码推翻之处

### 判决：**3 处**（1 硬矛盾 + 2 遗漏/误导）

#### Q7-1（硬矛盾）— SPEC 说 `externalSessionId = activation.childId`，但那是 DSH 内部 UUID，不是 Codex 会话

`docs/SPEC-v2.md:124`：
> "Resolve with `activation.result`, then **always** `await activation.dispose()` in a `finally`.
> Return **`externalSessionId = activation.childId`**."

这在**CLI 路径**上成立（`codex.js:56` 的 `parsed.sessionId` 是真 Codex 会话 id）。
但在**官方路径**上，`childId` 是 `manager.ts:488` 生成的
`brandString<SessionId>(randomUUID())` —— **一个 DSH 内部的、与 Codex 无关的随机 UUID**。

后果：`agent_dispatch` 返回的 `externalSessionId` 在两条路径上**语义完全不同**，
而文档与工具描述（`src/tools.js:318` "resumeSessionId continues one of that agent's existing
sessions (find ids with agent_sessions)"）把二者混为一谈。见 Q3 的附带分析。

**修法**：在 SPEC 里把两种路径的 `externalSessionId` 语义分开写，并在官方路径的返回里
不要叫 `externalSessionId`（或加 `externalSessionIdIsResumable: false`）。

#### Q7-2（遗漏）— 我们的工具没有任何 system prompt 章节，官方工具有

`docs/SPEC-v2.md` 的 Tools 章节（`:157` 起）只列了工具名与参数，**没有任何一句**提到
"注册 system prompt section"。而官方 `tool-subagent/src/index.ts:373-387` 明确注册了
一段，且它的内容（"Start independent delegations ... together in one assistant message and
continue useful work while they run"）**与我们的阻塞语义相反**。

这不算"文档说谎"，但算**文档遗漏了一个影响模型选择的竞争维度**——而 Q1 的危害正源于此。

#### Q7-3（次要）— README 的"官方"措辞暗示了不存在的等价性

`README.md:21`：
> `@deepseek-ai/dsh-subagent-codex` → provider `codex`

这句话单看没错（provider **名字**确实是 `codex`），但它让读者以为"我们配的 `subagentProvider: 'codex'`
就是那个官方 provider"。实际上只有当 bundle 的 `providerName` **恰好也是** `codex` 时才成立
（默认值是，但可配置，见 Q6）。建议补一句"该名字由 bundle 的 `providerName` 决定，两边必须一致"。

#### 我核对后确认**没有**矛盾的部分（避免下一轮重复怀疑）

| 文档说法 | 核对结果 |
|---|---|
| SPEC:117 `delivery: 'caller'` | ✅ 合法值（`types.ts:43`），且 `manager.ts:1184` 确实对 caller 跳过通知 |
| SPEC:118-120 "Omit `maxDepth`" | ✅ 正确：`NO_START_CAPABILITIES.depthLimit = false`（`out-of-process.ts:59`），传了会被 `assertCapabilities` 拒 |
| SPEC:121 "always await dispose() in finally" | ✅ 正确且必要；`manager.ts:772-783` 记忆化，不会双释放 |
| SPEC:122 "stopReason !== 'completed' carries diagnostic" | ✅ 与 `run.ts` 的 `failureDiagnostic`（`:86-105`）一致 |
| README:73 "returns a child id after accepting" | ✅ `tool-subagent:342` 返回 `{ kind:'activation', subagentId: started.childId }` |
| README:95 "one fresh process, thread, turn per run" | ✅ `run.ts` 每次 `startCodexRun` 都新 spawn，无池化 |
| README:144 "KV Cache: independent of parent request cache" | ✅ 与我们 CLI 路径无共享缓存，Claim C 的评估已引用 |

---

## 对实现的可执行建议（按优先级）

| # | 建议 | 依据 | 工作量 | 状态 |
|---|---|---|---|---|
| 1 | 去掉 `codex`/`claude` 的默认 `subagentProvider`，改 CLI-only；用户显式开启 | Q1 + Q4 | 2 行 | ⏳ 未做 |
| 2 | README/SPEC 补 `permissionMode` 默认 `never` 的行为说明（**当前最高优先**） | Q4 | 文档 | ⏳ 未做 |
| 3 | `agent_dispatch` 在官方路径收到 `model` 时明确提示"model ignored"，而非静默丢弃 | Q2 | ~5 行 | ⏳ 未做 |
| 4 | `resumeRejection` 措辞改为"id 不可互换、官方不可续" | Q3 | 1 行 | ✅ `58e3ab1` |
| 5 | `subagentProvider` 配置了但未注册时，`list()` 的 `detail` 说明原因 | Q6 | ~10 行 | ✅ `58e3ab1` |
| 6 | 捕获 `ACTIVATION_LIMIT_REACHED` 改写文案，指明是池被别的 delegation 占满 | Q5 | ~5 行 | ✅ `58e3ab1` |
| 7 | SPEC 区分两条路径的 `externalSessionId` 语义 | Q7-1 | 文档 | ✅ 代码已改，SPEC 待补 |

---

## 本报告结论的落地状态（审计后复核）

本报告的三条主要建议在审计过程中已被 `58e3ab1` 采纳落地，我复核了实现：

| 本报告条目 | 落地情况 | 复核证据 |
|---|---|---|
| Q3 `externalSessionId` 语义 / resume 文案 | ✅ **已修** | `src/backend.js:168-181` 的新文案明确写出"official run mints a fresh id per run"、"those ids are not resumable and are not the same as the CLI provider's"，并指明用 `agent_sessions` 找 CLI 侧 id |
| Q5 pool contention 文案 | ✅ **已修** | `src/backend.js:184-194` 识别 `ACTIVATION_LIMIT_REACHED`，改写为"pool held by another delegation" |
| Q6 `providerName` 不匹配静默降级 | ✅ **已修（可观测）** | `src/backend.js:415-425` 现在返回 `configured but not registered on ctx.subagents (is the bundle enabled, and does its providerName match ...?)`，并列出已注册的名字 |
| Q1 移除 `codex`/`claude` 默认 `subagentProvider` | ⏳ **未采纳**（属产品决策，非缺陷） | `src/config.js:18-19` 仍是 `subagentProvider: 'codex'` / `'claude-code'` |
| Q4 `permissionMode` 默认 `never` 的告知 | ⏳ **未处理** | `grep -rn permissionMode src/ README.md` → 0 命中 |
| Q2 `model` 静默丢弃 | ⏳ **未处理** | `src/backend.js:296-306` 的返回里仍无该信息 |

**剩余风险集中在 Q4**：既然 Q1 的默认值没改，模型仍可在启用 bundle 后通过
`agent_dispatch(provider:'codex')` 触发 `permissionMode: never` 的官方执行，
而插件与 README 对此**只字未提**。这是我建议的下一优先项。

---

## 方法与已知限制

- **bundle 未安装**：全部结论基于源码 checkout（`packages/subagent/subagent-codex`），
  未在运行中的 Host 上观测真实 `subagent_codex` 工具出现。Q1 的"模型会看到两个工具"是
  **从 `cordis.patch.yml` + 全局工具机制推出的**，不是实测。
- **Q6 的实测**用的是假 `ctx.subagents`（真实 `createBackendResolver`、真实 `registry`），
  验证的是**解析逻辑**，不是真实 bundle 挂载。
- 未验证：真实 Codex 二进制在 `permissionMode: never` 下的实际沙箱行为（本机无 @openai/codex）。
  README 的表格是我能引用的最强证据，但它描述的是**映射到的 thread/start 字段**，
  不等于"Codex 一定会怎么执行"。
- 探针脚本写在 `/tmp`，用后已删除；插件仓库源码零改动。
