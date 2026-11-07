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
回退点在当前 `:364`、`:459`）。**这修好了面板症状，但没修 A-3** —— 我在当前 HEAD 上仍复现 owner=undefined。

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

<!-- APPEND: N1 -->
