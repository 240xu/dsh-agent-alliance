# A1 — 对抗性复核：三条 claim 的驳回尝试

> 角色：ADVERSARIAL AUDITOR A1。任务不是复述结论，而是**尽力证伪**。
> 对象：`/home/ova/dsh/.artifacts/dsh-plugins/dsh-agent-alliance`，审计基线 commit `e15fcf8`，版本 0.2.0。
> 被复核 claim 出自 [docs/audit/00-REPORT.md](../audit/00-REPORT.md) 的 C1 / C2 / C4。
> 本文件是唯一写入；源码零改动（探针脚本只写在 `/tmp`，用后已删）。
>
> 复核期间仓库前进了两个 fix commit（`2f6660e`、`b5693d8`）。凡涉及行号，同时给出基线 `e15fcf8`
> 与当前 HEAD 的对应位置，避免拿"已修好的代码"去反驳"当时的结论"。

## 结论速览

| Claim | 判决 | 一句话理由 |
|---|---|---|
| **A** — `jobs.start()` 无 controller 时恒抛，后台 dispatch/圆桌必坏 | **CONFIRMED（机制）/ OVERSTATED（影响面与归因）** | 抛错真实；但真实 Web 部署里**有 owner 的路径有 controller**，只有 **panel/unowned** 坏。而让它"必然"的是另一处 bug（N1），不是缺 controller。 |
| **B** — `/state` 对未安装 provider 谎报 `available: true` | **CONFIRMED** | `detect()` 全仓只有测试在调；我实测 resolver 报 true、`detectAll()` 报 false；面板 UI 直接消费该字段。无法驳回。 |
| **C** — 圆桌第 2 轮与第 1 轮共享前缀为 0 | **CONFIRMED（字面）/ OVERSTATED（成本结论）** | 前缀确为 0，我复现了。但"修复省 21%"依赖未验证的 vendor 缓存前提，属未证实推论。 |

**最重要的产出不是这三条，而是 N1**：`exec.agent.sessionId` 读的是一个**不存在的字段**
（DSH 的 `Agent` 只有 `id`），所以**所有工具发起的后台 job 都退化成无主 job**，连锁导致
(a) 完成通知永不送达、(b) agent 销毁时 job 不被取消、(c) 面板 `/tasks` 暴露本应属于某会话的 job。
前一轮审计**未发现**这一条，且它在当前 HEAD 上**依然存在**。

另附两条前一轮同样遗漏（且被错误标为 CLEAN）的缺陷：

| 编号 | 缺陷 | 严重度 |
|---|---|---|
| **N1** | `exec.agent.sessionId` 不存在 → 后台 job 全部无主（通知丢失 / 不随 agent 取消 / 跨会话可见可杀 / 配额互踩） | **critical** |
| **N2** | `runner.js` 只监听 `close` 且只 kill 直接子进程 → 孙进程占管道时 promise 永不结算，槽位永久泄漏 | **high** |
| **N3** | `zcode` 的 `replaceAll` 把 prompt 里的 `$&`/`$$`/`$'` 当替换模式 → prompt 被静默篡改 | **high** |

> 每条都附了可复现命令与实测输出；探针脚本写在 `/tmp` 且已删除，仓库源码零改动。

---

## Claim A — `jobs.start()` 在无 controller 时恒抛

### 判决：**CONFIRMED（机制真实），但 OVERSTATED（影响面与归因都错）**

#### A-1 打不掉的部分：准入机制真实存在

- `packages/jobs/jobs-local/src/index.ts:208-210`
  ```js
  if (!this.servesOwner(owner)) {
    throw new Error('background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)')
  }
  ```
- `servesOwner`（同文件 `:378-382`）对 **unowned**（`owner === undefined`）**只查 global 层**：
  ```js
  if (!this.layers.global.controllers.isEmpty()) return true
  return this.layers.chainLayers(owner === undefined ? undefined : scopeOf(owner.ctx))
    .some(layer => !layer.controllers.isEmpty())
  ```
  `chainLayers(undefined)` 恒为 `[]`（`packages/core/scope/src/store.ts:192-199`；
  `scopeChainOf(undefined)` 返回空数组，`packages/core/scope/src/index.ts:98-102`）。
  ⇒ unowned job 能否 start，**只取决于有没有人从 root context 挂过 controller**。
- 插件侧（基线）`src/tools.js:123-127` 的 `startJob` 确实不 catch。

实测（真实 `Context` + 真实 `LocalJobRegistry` + 真实 `createScope`，`/tmp/aa_jobs_scope2.mjs`）：

```
jobs mounted: true
tool path   (owner = live agent)       -> THREW: background job ownership requires the agent registry
panel path  (unowned)                  -> THREW: background jobs unavailable: no job controller serves this agent
panel path  (unowned, root controller) -> STARTED agent-alliance-4072f7c10cdb46e7
```

⇒ unowned 路径在 root 无 controller 时**确实恒抛**。这部分驳回失败。

#### A-2 被推翻的部分：真实 Web 部署里 tool 路径是通的

原报告把"工具 `agent_dispatch` + `background:true`"和"工具 `agent_roundtable`（默认 background）"
都标为"❌ 抛错"。这在真实 Web 部署里**不成立**，因为它忽略了 controller 的**挂载层级**：

1. Web 面确实把 host-plane 的 `tool-jobs` 关了：`packages/bundle/web-app/cordis.patch.yml:484-485`
   ```yaml
   - id: tool-jobs
     disabled: true
   ```
   —— 这点原报告对，root 层没有 controller。
2. 但 **每个 agent preset 在自己的 scope 里又挂了一个**：
   `packages/bundle/web-app/presets/cordis.patch.yml:36-37`、
   `standard.patch.yml:33-34`、`ptc.patch.yml:33-34`，
   以及**当前 live profile** `~/.dsh/profiles/web/cordis.patch.yml:285-286`。
3. `attachController` 把 token 记进**注册它的 ctx 所属 scope 的 layer**：
   `packages/jobs/jobs-local/src/index.ts:342-350` →
   `this.layers.effect(this.ctx, layer => layer.controllers.append(token))`；
   `ScopedLayers.effect` 按 `scopeOf(ctx)` 选层（`packages/core/scope/src/store.ts:226-247`）。
4. `servesOwner(owner)` 对**有 owner** 的 job 走 `chainLayers(scopeOf(owner.ctx))`；而 Agent 的 ctx 是
   preset scope 下的子 scope（`packages/core/agent-loop/src/agent.ts:130` 的 `this.scope = createScope(loopCtx, this)`），
   所以链上**能命中 preset 那一层**。

实测（`/tmp/aa_jobs_scope3.mjs`，真实对象，preset-scoped controller + 子 scope agent）：

```
tool path (owner=live agent) -> STARTED agent-alliance-afb52a153c0748e4
panel path (unowned)        -> THREW: background jobs unavailable: no job controller serves this agent
```

⇒ **tool 路径通；只有 panel（unowned）路径坏。** 原报告"圆桌默认不可用"只对**面板发起**的圆桌成立，
对**模型工具发起**的圆桌不成立。

#### A-3 归因被打穿：owner 传的根本不是 SessionId

原报告说"`jobs-local` 永远存在，真正缺的是 controller，所以守卫恒真"。真实链条是：

```js
// src/tools.js:340（基线 :315）、src/tools.js:447（基线 :408）
owner: exec?.agent?.sessionId,
```

DSH 的 `Agent` **没有 `sessionId` 字段**：
- `packages/core/agent/src/types.ts:15-18` 只有 `readonly id: SessionId`
- 运行时增补（`packages/core/agent/src/runtime-types.ts:139-183`）加了 `options/session/inbox/status/ctx/cancel/whenIdle/...`，**没有 `sessionId`**
- 真实构造 `packages/core/agent-loop/src/agent.ts:122-127` 的字段是 `id`、`options`、`session`
- 全仓 grep `agent.sessionId` / `agent?.sessionId`：**DSH 自己的代码里 0 处**（只有本插件与 docs/SPEC-v2.md 抄的同一句）

⇒ `owner` 在真实 Agent 上**恒为 `undefined`**，所有工具发起的后台 job 都变成 **unowned**，
于是才落回"必须 root 有 controller"那条分支。**这才是 tool 路径失败的真因。**

实测（`/tmp/probe_owner.mjs`，用 `{ id: 'session-abc' }` 这个 DSH 类型允许的最小真实形状）：

```
job spec keys: [ 'kind', 'label', 'owner', 'outputLimitBytes', 'run' ]
spec.owner = undefined
=> owner is UNDEFINED (job becomes UNOWNED / panel-visible)
```

#### A-4 正确的严重度

| 入口 | 原报告 | 我的判决 |
|---|---|---|
| panel `POST /roundtable`（unowned） | ❌ 抛错 | ✅ **critical**：确实坏，且当时 `http.js` 不 catch |
| 工具 `agent_dispatch({background:true})` | ❌ 抛错 | ⚠️ **high，但原因不是缺 controller**：是 A-3 的 owner 丢失 |
| 工具 `agent_roundtable`（默认 background） | ❌ 抛错 | ⚠️ 同上 |
| panel `POST /dispatch` | ✅ 不受影响 | ✅ 同意 |
| 工具前台 `agent_dispatch` | ✅ 不受影响 | ✅ 同意 |

#### A-5 修复状态

`2f6660e` 已给 `startJob` 加 try/catch 并返回 `undefined` 走既有内联回退（当前 `src/tools.js:130-152`；
回退点在当前 `:378`、`:476`）。**这修好了面板症状，但没修 A-3** —— 我在当前 HEAD 上仍复现 owner=undefined。

---

## Claim B — `/state` 对四家 provider 一律报 `available: true`

### 判决：**CONFIRMED**（尽力驳回，失败）

#### B-1 我尝试的三条驳回路线，全部失败

**尝试 1：也许 `detect()` 在生产路径被别的代码调用了。**
失败。`grep -rn "detectAll\|\.detect(" src/ index.js` 在 `src/` 只命中
`src/provider/types.js:28-43`（`detectAll` 的定义）——**没有调用点**。四个 provider 都实现了
`detect()`（`claude.js:31`、`codex.js:30`、`opencode.js:31`、`zcode.js:36`），但生产代码从不调。

**尝试 2：也许 `available: true` 是"已注册"而非"已安装"的有意语义，UI 会在别处纠正。**
失败。`client.js` 把它当作"能派发"用：
- `client.js:579-588` 直接渲染绿点/红点 + `state.available`/`state.unavailable`
- `client.js:682`、`:803`、`:941` 用 `entry.available === true` 过滤出**可派发/可参与圆桌的 provider**
- `client.js:806-808` 用它决定默认选中项；`:857`/`:903` 在 `availableIds.length === 0` 时禁用按钮
⇒ 语义确实是"当前可用"，而值恒 true。

**尝试 3：也许我构造的 fake registry 不代表生产，真实 registry 会不同。**
失败。`resolver.list()` 的 `available` 只由 `cli.found` 决定（`src/backend.js:348-385`：
`cliLookup` 命中就 `available: true`，否则才 `false`），与 `detect()` 无关。
`cliLookup` 只查注册表有没有这个 id（`src/backend.js:85-111`），**注册表在 `buildProviders` 里无条件塞进四家**
（`src/providers.js:17-29`），所以四家永远 `found: true`。

实测（`/tmp`，真实 `createRegistry` + 真实 `createBackendResolver`）：

```
resolver.list():      [{"id":"claude",...,"available":true},{"id":"codex",...,"available":true},
                       {"id":"opencode",...,"available":true},{"id":"zcode",...,"available":true}]
registry.detectAll(): [{"id":"claude","available":false,"detail":"NOT INSTALLED"}, ... 四家全 false]
```

#### B-2 两个加重情节

1. **`zcode` 默认 `enabled: false` 却仍报可用。** `src/config.js:21`
   `zcode: { enabled: false, commandTemplate: '' }`；`zcode.js:47-53` 的 `dispatch` 会直接抛
   "zcode 未启用"。而 `list()` 仍报 `available: true` —— 用户点下去必然失败。
2. **`config.providers[id].enabled === false` 从不参与 `providerIds()`。**
   `src/backend.js:294-315` 只枚举 registry 与 config 的 key，不看 `enabled`。

#### B-3 严重度

原报告定 critical，我认为 **high**：这是"误导性 UI/状态"，不会损坏数据或花钱，但会让面板的
选择器、默认值、按钮启用状态全部建立在谎报之上，用户唯一的发现方式是点下去吃一个 spawn 失败。
定 critical 略高，但**结论本身成立，无法驳回**。

---

## Claim C — 圆桌第 2 轮与第 1 轮共享前缀为 0

### 判决：**CONFIRMED（字面事实）/ OVERSTATED（成本结论）**

#### C-1 字面部分：驳回失败

`src/roundtable.js:5-20` 的 `buildDebatePrompt`：第 1 轮 `return String(basePrompt)`，
第 2 轮以 `'【第' + round + '轮辩论】'` 开头。我直接跑插件代码复现：

```
round1: "review this codebase and list bugs"
round2: "【第2轮辩论】\n原始问题：\nreview this codebase and list bugs\n\n其他 agent 的上一轮发言：\n【a】\nans-a\n\n请针对..."
shared char prefix: 0
```

⇒ "共享前缀 0"是**事实**，且 `matchesPrefix` 类缓存（Anthropic/OpenAI 的自动前缀缓存）按字节前缀匹配，
这个结构**确实一个字节都命中不了**。

#### C-2 我尝试的两条"仍有复用"路线，其中一条部分成立

**路线 1：也许走了 session resume，靠会话续跑天然复用上下文？**
失败。`runRoundtable` 调 `provider.dispatch({ prompt, cwd, model, timeoutMs, signal })`
（`src/roundtable.js:33-35`）——**根本没传 `resumeSessionId`**。我也实测确认第 2 轮收到的
`resumeSessionId` 是 `undefined`。所以没有会话级复用。

**路线 2：也许 vendor 侧的语义缓存/上下文缓存不在乎文本前缀？**
部分成立，但这恰恰说明原报告的**量化**站不住：

- 原报告的 21% / 29.1% 收益建立在"前缀缓存按字符前缀命中"这一模型上，并用
  `subagent-codex/README.md` 的 "KV Cache effect ... depends only on Codex's own provider,
  model, instructions, tools, and ephemeral-thread request" 作为权威依据。
- 但同一段权威说的是 **"One fresh process, thread, and turn per run. ... there is no
  continuation, resume, or pooling."** —— **每次 `dispatch` 都是一个全新的 ephemeral thread**。
  在这种路径下，"把 basePrompt 提到最前面"能否命中跨进程的 warm cache，**取决于该 vendor 的
  provider 侧缓存是否在两次独立 CLI 调用之间存活**，而这一点**没有任何实测**。
- 更重要的反向证据在**同一份原报告内部**：`docs/audit/04-orchestration.md:197-200` 自己承认
  "四个并发请求共享 12,800-token 前缀……**Whether a cache entry written milliseconds earlier is
  visible is provider-specific**"。既然并发首轮都不确定能命中，那么"第 2 轮一定能命中第 1 轮
  刚写的缓存"同样是**未证实前提**，而 21% 是把它当既成事实算出来的。

⇒ 结论：**"前缀为 0"确认；"修复可省 21%"是从未验证的缓存假设推出的数字，属过度断言。**
正确的表述应是："文本前缀为 0，因此**在任何按前缀匹配的缓存下**都不可能复用；实际可省多少取决于
vendor 缓存语义，插件侧未测量（也没有 usage 采样，见 `04-orchestration.md:58` 自述
`grep usage|cacheReadTokens|cacheWriteTokens` 为空）。"

#### C-3 严重度

原报告定 high。我认为 **medium**：这是一个真实的**成本结构**缺陷（前缀设计确实浪费），
但既不损失数据也不影响功能，且收益数字未证实。降级理由是"未测量的性能断言被当作 high 依据"。

---

## N1 — 新缺陷（前一轮审计遗漏，比上述三条都严重）

### `exec.agent.sessionId` 不存在 → 所有工具发起的后台 job 退化为「无主 job」

**严重度：critical**（数据可见性 + 生命周期 + 配额三重损坏，且**当前 HEAD 仍未修复**）

#### 缺陷本体

```js
// src/tools.js:363（agent_dispatch 后台分支）
owner: exec?.agent?.sessionId,
// src/tools.js:470（agent_roundtable 后台分支）
owner: exec?.agent?.sessionId,
```
（基线 `e15fcf8` 在 `src/tools.js:315`、`:408`；当前工作区在 `:363`、`:470`，同样两处。）

DSH 的 `Agent` **没有 `sessionId` 成员**：

| 证据 | 位置 |
|---|---|
| `interface Agent { readonly id: SessionId }` —— 全部字段就这一个 | `packages/core/agent/src/types.ts:15-18` |
| 运行时增补只加了 `options/session/inbox/status/ctx/cancel/whenIdle/runMaintenance/send/...`，**无 `sessionId`** | `packages/core/agent/src/runtime-types.ts:139-183` |
| 真实实现类的构造字段是 `id`、`options`、`session` | `packages/core/agent-loop/src/agent.ts:122-127` |
| 全仓 `agent.sessionId` / `agent?.sessionId` —— DSH 自身 **0 处** | `grep -rn` 于 `packages/ apps/` |
| DSH 官方同类工具用的是 `exec.agent.id` | `packages/shell/tool-bash/src/index.ts:272` `...exec.agent ? { owner: exec.agent.id } : {}`，以及 `:297` `const owner = exec.agent?.id` |

`CreateAgentOptions.sessionId`（`packages/core/agent/src/index.ts:65`）是**创建入参**的字段，
不是已存在 Agent 上的属性 —— 这正是本 bug 的诱因：字段名存在于同一文件，看着像真的。

#### 实测复现（当前 HEAD `b5693d8` + 本次工作区修改）

```js
// /tmp/probe_owner.mjs —— 用 DSH 类型允许的最小真实 Agent 形状 { id: 'session-abc' }
await tool.execute({ provider:'fake', prompt:'p', background:true },
                   { agent: realShapedAgent, signal })
// 输出：
job spec keys: [ 'kind', 'label', 'owner', 'outputLimitBytes', 'run' ]
spec.owner = undefined
=> owner is UNDEFINED (job becomes UNOWNED / panel-visible)
```

`undefined` 被 `jobs.start()` 解释为"无主 job"（`packages/jobs/jobs-local/src/index.ts:207`
`resolveOwner(undefined) → undefined`）。**该 job 从此不属于发起它的会话。**

#### 三条连锁后果（每条都实测）

**后果 1 — 完成通知永不送达，模型永远不知道后台任务结束了。**

`packages/jobs/tool-jobs/src/index.ts:278`：
```js
if (delivered || event.cause === 'teardown' || event.job.owner === undefined) return
```
无主 job 在 settle 时**直接 return**，不注入、不唤醒。

这里必须精确：插件自己的描述确实告诉模型去取结果（`src/tools.js:332`
"collect the result with job_output"），所以模型**不是完全无从下手**。
真正被破坏的是**框架层面的契约**：`dsh-tool-jobs` 装进 system prompt 的章节明确写着
（`packages/jobs/tool-jobs/src/index.ts:253`）：

> "Track every background job id you start. **You are notified in-session when a job finishes** —
> do not busy-poll or sleep on one; ... Before giving a final answer, collect every still-relevant
> job with `job_output` (set `wait: true` only when you are genuinely blocked on it)"

即模型被**明确要求不要轮询**，并且被承诺"完成时会收到通知"。对无主 job，
这个承诺是假的：模型若遵守指令就会**无限期等下去**，直到回合被别的原因结束；
若违反指令去轮询，就回到了该 prompt 想避免的 busy-poll。
更直接的证据是 `tool-jobs` 自己的注释（同文件 `:264-266`）："An idle owner is woken instead,
because **an undelivered notice is a completion the model never learns about**" ——
`owner === undefined` 分支正是它想避免的情况。

**后果 2 — agent 销毁时不取消该 job，进程泄漏。**

`ensureOwnerCleanup` 只对**有 owner** 的 job 生效（`packages/jobs/jobs-local/src/index.ts:217`
`if (owner !== undefined) this.ensureOwnerCleanup(owner)`；`:614-622` 把清理挂在 `owner.ctx` 的
effect 上）。无主 job 没有这条 cleanup，**会话结束、agent 销毁、甚至用户关掉 UI 之后，
外部 CLI 子进程仍在跑**，继续烧配额。这正是 `jobs-local` README 承诺要避免的情形。

**后果 3 — 面板 `/tasks` 暴露别人的 job，且配额是全局共享的。**

`assertAccess`（同文件 `:406-410`）只拦**有 owner** 的 job（`job.owner !== undefined && ...`）。
无主 job 对任何 caller 可见：

```js
// /tmp/n1_consequences.mjs
view.owner: undefined   (undefined => unowned)
panel list(undefined) sees it:              [ 'agent-alliance-4f6ba2740243473f' ]
the originating session list("session-A") sees it: [ 'agent-alliance-4f6ba2740243473f' ]
```

而 `http.js` 的 `/tasks` 正是按 `jobs.list(undefined)` 拉的（`src/http.js:516`），
所以**任何一个会话发起的后台 dispatch 都会出现在面板任务列表里**，包括在另一个会话里
点 "kill" 就能杀掉它。

配额也跟着串了。`activeJobCount` 按 `job.owner === owner` 计数（同文件 `:385-391`），
所有无主 job 挤在**同一个全局桶**里：

```js
// /tmp/n1_consequences2.mjs
11th UNOWNED job (any session): background job limit reached for this owner (limit: 10)
10 owned jobs for sess-A started fine (separate bucket: 20 visible to A)
panel (unowned view) count: 10
```

⇒ 会话 B 的 10 个后台任务会把会话 A 的第 11 个任务挡掉，报的还是"A 自己超限"。

#### 为什么 193 个测试全绿却抓不到

`tests/tools.test.js:224` 手造了一个 DSH **永远不会产生**的 agent 形状：

```js
const exec = { agent: { id: 'agent-1', sessionId: 'session-42' }, signal: ... }
...
assert.equal(spec.owner, 'session-42')
assert.equal(typeof spec.owner, 'string', 'owner must be the SessionId string, never the Agent')
```

这条测试**断言了错误契约**：它给 fake agent 补了一个真实 Agent 没有的 `sessionId` 字段，
于是 `assert.equal(typeof spec.owner, 'string')` 通过。`docs/SPEC-v2.md:187`
（`owner: exec.agent?.sessionId,   // SessionId, NOT the Agent`）与
`docs/MIGRATION-0.2.md:63` 把这个错误字段写进了规范，测试再照着规范造 fixture ——
**规范、实现、测试三者自洽，但全部偏离了框架的现实。**

正确的断言应该只用 DSH 真实形状：`{ id: 'session-42' }`，并断言 `spec.owner === 'session-42'`。
在现有测试里跑这个断言会立刻失败（我手工验证：`spec.owner === undefined`）。

#### 修复（1 行 × 2 处）

```js
owner: exec?.agent?.id,          // DSH: Agent.id IS the SessionId
```

同时把 `docs/SPEC-v2.md:187`、`docs/MIGRATION-0.2.md:63` 与
`tests/tools.test.js:224` 的 fake agent 一并改成 `{ id: 'session-42' }`，
并加一条"owner 必须等于 agent.id"的回归断言。

#### 为什么它比 Claim A / B / C 都严重

| | 性质 | 用户可见性 | 是否当前仍存在 |
|---|---|---|---|
| A | 面板圆桌不可用 | 立刻可见（报错） | 症状已修（回退到前台） |
| B | 状态页谎报 | 立刻可见（点下去失败） | 仍存在 |
| C | 成本结构浪费 | 不可见（账单） | 仍存在 |
| **N1** | **job 脱离会话：通知丢失 + 进程泄漏 + 跨会话可见/可杀 + 配额互踩** | **不可见**，直到发现进程还在跑或任务列表里冒出陌生的 job | **仍存在** |

A/B/C 都只是"某个功能不好用"，N1 是**正确性 + 资源 + 隔离**同时破损，且**静默**。

---

## N2 — `runner.js` 的超时/取消只 kill 直接子进程，且只监听 `close`

**严重度：high**（原报告 `01-bugs.md:169` 明确把这一项标为 ✅ CLEAN，判断错误）

`src/runner.js:74` 只在 `close` 上结算：
```js
child.on('close', (code) => settle(code === null ? -1 : code))
```
而 Node 的 `close` 事件要等**子进程的 stdio 流全部关闭**。`sh -c` 自己再 fork 的子进程会继承
stdout/stderr 管道；`SIGKILL` 只打中 `sh`，孙进程仍持有管道 ⇒ `close` 迟迟不来。

实测（`/tmp/verify_kill.mjs`，直接对比 `exit` 与 `close`）：

```
[sh -c sleep 3]  exit  at 308ms  sig=SIGKILL     ← 进程确实死了
[sh -c sleep 3]  close at 3012ms                 ← 但 close 晚了 2.7 秒
```

于是 `spawnCli` 的 promise **在超时后仍然挂着**：

```
// /tmp/verify_runner3.mjs，timeoutMs: 300
spawnCli returned after 3013 ms; timedOut= true    ← 10× 超时

// /tmp/verify_forever.mjs，timeoutMs: 200，孙进程是长驻 daemon
STILL PENDING after 8s (timeout was 200ms)
surviving sleep 600: 3                              ← 孙进程存活
```

**真实触发路径**：`zcode` 是唯一走 `sh -c` 的 provider（`src/provider/zcode.js:55`
`argv: ['sh', '-c', script]`），而它的模板正是用户自由填写的任意命令
（`config.commandTemplate`，可能拉起 `zcode ...` 这类会自行 fork 的 CLI）。
CLI 若留下长驻子进程（daemon、语言服务器、`npm exec` 包装器），**一次 `dispatch` 的 promise
就永不 settle**。

**后果**：该 promise 占着 `createSemaphore` 的槽位不放。`maxConcurrent` 默认 3，我实测把槽占满后
第三个任务永远排队：

```
// /tmp/aa_wedge.mjs（maxConcurrent: 2，两个 dispatch 卡在 runner 里）
THIRD IS STUCK IN QUEUE (limit exhausted)
```
并且 `tools.js` 的 `dispatchForeground` 会 `await` 这个 promise，所以**前台 `agent_dispatch`
也会永久挂起**，直到整个回合被外部取消。

**修复（2 行）**：
```js
// 结算挂在 exit 上，并在结算时主动销毁管道，不等孙进程退出
child.on('exit', (code) => { child.stdout.destroy(); child.stderr.destroy(); settle(code === null ? -1 : code) })
```
更彻底的做法是 spawn 时加 `detached: true`，超时/abort 时用 `process.kill(-child.pid, 'SIGKILL')`
杀掉整个进程组。

**为什么前一轮判错了**：`01-bugs.md:169` 的验证方法是"`onAbort` 里调用了 `child.kill('SIGKILL')`"——
它只证明了 **kill 被调用**，没有证明 **promise 会 settle**。这两件事在存在孙进程时分开了。

---

## N3 — zcode 模板展开用 `String.replaceAll`，`$`-pattern 会静默篡改 prompt

**严重度：high**（静默数据损坏：模型发出去的 prompt 与目标 agent 收到的不一致，且会泄漏模板自身文本）

`src/provider/zcode.js:29-34`：
```js
function expandTemplate(tpl, { prompt, resumeSessionId, cwd }) {
  return tpl
    .replaceAll('{prompt}', shellQuote(prompt))
    .replaceAll('{session}', resumeSessionId ? shellQuote(resumeSessionId) : '')
    .replaceAll('{cwd}', shellQuote(cwd || '.'))
}
```

`String.prototype.replaceAll` 的**第二个参数**（替换字符串）支持 `$&`、`` $` ``、`$'`、`$$`、`$1`
等特殊模式。`shellQuote` 返回的是 `'...'` 形式的字符串，**其中的 `$` 没有被转义**，
于是用户 prompt 里的 `$&` / `` $` `` / `$'` / `$$` 会被 `replaceAll` 当成 pattern 解释。

实测（`/tmp/zc.mjs`，模板 `zcode run -p {prompt} --yes`）：

```
prompt  : "fix the $& backreference in my regex"
received: "fix the {prompt} backreference in my regex"          <<< 字面量 {prompt} 被插回来

prompt  : "explain $$ in Makefiles"
received: "explain $ in Makefiles"                              <<< 少了一个 $

prompt  : "what does $' mean in bash"
received: "what does  --yes\'' mean in bash"                    <<< 模板尾部 "--yes" 被复制进 prompt
```

第三种最恶劣：`$'` 的语义是"匹配位置之后的整段字符串"，所以 `replaceAll` 把**模板中
`{prompt}` 之后的所有内容**（这里是 ` --yes`）复制进了 prompt 内部。
任何讨论正则替换、Makefile、bash 引号的提问（都是常见的编码任务）都会命中。

**为什么不是 RCE**：我专门做了注入尝试 —— 用 `$'`、`` $` ``、`$&`、`$$` 作 payload，
配 8 种模板 + 真跑 `sh -c` 检查 marker 文件是否被创建（`/tmp/aa_fuzz.mjs`），
**0 命中**。原因是 `replaceAll` 破坏文本后，payload 仍落在单引号内，`sh` 只把它当字面量。
所以这是**内容损坏**，不是命令注入 —— 但仍然严重：它让插件在**无声中改变了用户发给外部 agent 的指令**。

**修复（1 行 × 3）**：用函数形式的替换，避免 pattern 解释：
```js
.replaceAll('{prompt}', () => shellQuote(prompt))
.replaceAll('{session}', () => (resumeSessionId ? shellQuote(resumeSessionId) : ''))
.replaceAll('{cwd}', () => shellQuote(cwd || '.'))
```

**为什么前一轮漏掉**：`01-bugs.md` 的 F3 只按"`catch {}` 是否掩盖故障"分类，
`02-framework.md`/`03-official-subagents.md` 没有检查 `replaceAll` 的替换字符串语义；
`tests/provider-zcode.test.js:33-40` 的注入测试只用了**单引号** payload
（`"x'; rm -rf /; echo '"`），恰好是 `replaceAll` 不会特殊处理的形式，所以测试全绿。

---

## 附：我尝试驳回但失败的其它候选（记录负面结果，避免重复劳动）

| 我怀疑的缺陷 | 尝试的证伪方式 | 结果 |
|---|---|---|
| **zcode `{prompt}` 模板可命令注入** | 用 `$'`、`` $` ``、`$&`、`$$` 做 payload，配 8 种模板，再真跑 `sh -c` 找 marker 文件 | **注入不成立**（0 命中）。但 `replaceAll` 的 `$`-pattern 确实会**破坏 prompt 文本**，见 N3。 |
| **并发导入台账丢更新** | 两个 `importOne` 并发、用 `setTimeout` 拉大窗口、给 `/tmp` 副本插桩打点 | **打不掉，且不成立**。`saveLedger` 是**同步** fs 调用，`loadLedger`→`saveLedger` 之间没有 `await`，Node 单线程下天然原子；实测两条并发都进了台账（`['claude:s1','claude:s2']`）。HEAD 又加了 `recordLedgerEntry` 写队列（`src/importer/persist.js:97-112`）。⇒ 前一轮"未验证"的悬念可以关闭。 |
| **`/state` 的 `available` 其实调了 detect** | grep 全部调用点 | **驳回失败**，确认是谎报（Claim B）。 |

探针脚本均写在 `/tmp` 且已删除；仓库源码零改动。
