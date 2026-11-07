# dsh-agent-alliance 0.2.0 全面审计报告（主报告）

> 审计对象：`/home/ova/dsh/.artifacts/dsh-plugins/dsh-agent-alliance`，commit `e15fcf8`，版本 0.2.0
> 审计环境：DSH `0.2.1-rc.2`，Node v22.20.0，Linux x86_64
> 审计日期：2026-11-06 / 07
> 审计方式：**5 条独立专项线并行**，每条由专精角色独立取证，本报告汇总并按严重度排序。
> 所有结论都附可复现证据（文件:行号 / 实测命令输出）。凡未经实测的一律标注「静态推断」。

分报告索引：

| 线 | 专项 | 文件 | 发现数 |
|---|---|---|---|
| A | 缺陷、竞态、资源泄漏、错误路径 | [01-bugs.md](01-bugs.md) | 5（1 high / 2 medium / 2 low） |
| B | DSH 框架契约对齐 | [02-framework.md](02-framework.md) | 14（3 high / 3 medium / 3 low / 3 clean / 2 其他） |
| C | 官方 subagent bundle 行为正误 | [03-official-subagents.md](03-official-subagents.md) | 11（3 HIGH / 3 MEDIUM / 5 LOW） |
| D | 编排领域专业判断（缓存/并发/成本） | [04-orchestration.md](04-orchestration.md) | 量化成本模型 + 8 项改动排序 |
| E | 客户端 UI / slot / i18n / 主题 | [05-client-ui.md](05-client-ui.md) | 6（1 high / 2 medium / 3 low） |

**合计 36 条编号发现**，其中 7 条 high 及以上、8 条 medium、16 条 low，另有 5 条经实测确认为
**正确的实现**（CLEAN）——这部分同样重要，它划清了"确实没问题"与"没人看过"的边界。

> **关于线 A 的说明**：该线原指派给团队成员，两次运行均因网络中断无落盘。为不拖住交付，
> 由 Lead 亲自补齐，因此覆盖广度弱于其他线；但最危险的几处（信号量竞态、监听器泄漏、
> 子进程回收）都做了**真实对象实测**，并在文末明确列出了未覆盖的缺口（SQLite 句柄）。

---

## 0. 总体判断

**这个插件在功能正确性上已经达标，但审计发现了两条 critical、一条架构级 high，以及一个会让
"官方子代理优先"这个核心卖点静默失效的缺陷。**

好消息先说清楚：经过 186 个离线测试、真实 v4 校验器、真实 Cordis 挂载、真实 JSONL 往返验证，
核心链路（导入、工具注册、HTTP 面、生命周期回收）是**确实能工作**的，不是"测试通过而已"。
并发与资源管理这部分实测**比我预期扎实**——我最担心的三类竞态（排队取消、同步抛错后槽位泄漏、
监听器悬挂）全部正确。

坏消息是审计暴露了一批**此前完全没有覆盖到的问题**，而且集中在"用户能直接看到/直接付钱"的地方：

- 状态页**谎报四家 provider 全部可用**（实测 `detectAll()` 说全不可用，`/state` 说全可用）
- 后台功能在缺 `tool-jobs` 的组合里**必然抛错**，而圆桌默认就是后台模式
- `resumeSessionId` 的守卫放在了**真实计费进程启动之后**
- 已中止的 signal **仍会启动一次真实外部调用**
- 圆桌第 2 轮与第 1 轮**共享前缀恰好为 0 字符**（实测），修复后可省 21% 成本
- `agent_dispatch` 与官方 bundle 自带的全局工具**语义相反**，却同时暴露给模型

---

## 1. 关键发现（按严重度）

### 🔴 C1 — 后台任务在未挂载 `tool-jobs` 的组合里必然抛错

**严重度：critical（当前部署下功能直接不可用）**
**证据链**（三层，全部实测）：

1. 框架：`dsh-jobs-local/lib/index.js:414`

```js
if (!this.servesOwner(owner)) throw new Error(
  "background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)")
```

2. 唯一的 controller 提供者：`dsh-tool-jobs/lib/index.js:256`

```js
ctx.jobs.attachController("tool-jobs");
```

全仓 grep `attachController`，生产代码里**只有这一处**。

3. 插件侧：`src/tools.js:123-127`

```js
function startJob(ctx, spec) {
  const jobs = serviceOf(ctx, 'jobs')
  if (jobs === undefined || jobs === null || typeof jobs.start !== 'function') return undefined
  return jobs.start(spec)          // ← 可能直接抛错，无 try/catch
}
```

**我的实测**（真实 `LocalJobRegistry`，不是 mock）：

```
$ node job-proof.mjs
jobs mounted: true
no controller attached:
  unowned (panel path): THREW -> background jobs unavailable: no job controller serves this agent
                                    (load @deepseek-ai/dsh-tool-jobs in its composition)
  owned  (tool path):   THREW -> background job ownership requires the agent registry
after attachController:
  unowned (panel path): STARTED -> agent-alliance-570d28c077964896
```

**为什么这是 critical**：插件的守卫 `serviceOf(ctx,'jobs') !== undefined` 只检查**服务是否存在**，
但 `jobs-local` 是 `dsh-base` 的一部分，**永远存在**；真正缺的是 **controller**。
所以守卫恒真，`jobs.start()` 恒抛。而当前 web profile 里 `tool-jobs` 的 enabled 状态取决于
`dsh-base` 第 289 行的 row —— 若被任何 overlay 关掉（本 profile 有大量自定义 patch），
后台功能立刻全线失效。

**影响面**（逐条核实过调用点）：

| 入口 | 是否受影响 |
|---|---|
| 工具 `agent_dispatch` + `background:true` | ❌ 抛错 |
| 工具 `agent_roundtable`（默认就 background） | ❌ 抛错 |
| 面板 `POST /roundtable`（`src/http.js:432`） | ❌ 抛错 |
| 面板 `POST /dispatch` | ✅ 不受影响（同步，不碰 jobs） |
| 工具前台 `agent_dispatch`（`background` 非 true） | ✅ 不受影响 |

注意圆桌的 `background` **默认是 true**，所以"圆桌"这个功能在缺 controller 时是**默认不可用**的。

**修复**（三选一，推荐 ①+②）。**两种方案我都已实测验证**：

1. `startJob` 包 try/catch，捕获后返回 `undefined`，让既有的内联回退路径接管——插件本来就有
   `if (jobId === undefined) return dispatchForeground(...)`，这个回退是**已经写好的**，只是被
   抛错绕过了。
2. 用 `ctx.jobs.attachController('agent-alliance')` 自己注册一个 controller（在 `apply` 里，
   通过 `ctx.effect` 管理生命周期），让插件不依赖 `tool-jobs` 是否启用。
3. 把 `tool-jobs` 加入 profile 依赖并在 README 里写明。

实测输出（`c1-fix-validate.mjs`，真实 `LocalJobRegistry`）：

```
jobs mounted: true
no controller, no guard -> THREW: background jobs unavailable: no job controller serves this a
no controller, guarded  -> undefined (undefined => inline fallback runs)
after attachController  -> agent-alliance-0763d505ad434a64
PASS both strategies verified
```

即：**方案 ① 能让既有的内联回退真正跑到**，方案 ② 能让后台功能恢复。

修完必须补一个测试：**在 jobs 服务存在但没有 controller 时，`background:true` 应静默降级为前台**。

---

### 🔴 C2 — `/state` 对四家 provider 一律谎报 `available: true`

**严重度：critical（用户可见的错误信息，直接误导操作）**

`src/backend.js:363-372` 的 `list()` 只要 provider 在 registry 里找到就填 `available: true`，
**从不调用 `detect()`**；`zcode` 即使 `enabled: false` 也照样报可用。

**我的实测（双重证据）**：

```
# 1) 真实 detectAll() 说四家全部不可用
$ node -e "buildProviders(...).detectAll()"
   claude     available=false spawn /data/data/com.termux/files/usr/bin/grun ENO...
   codex      available=false Function.executeUserEntryPoint ...
   opencode   available=false spawn /home/dsh/.local/share/xucodex/opencode/bin/...
   zcode      available=false zcode 未配置 commandTemplate...

# 2) /state 端点却说四家全部可用
$ node -e "createBackendResolver(...).list(undefined)"
   claude     available=true kind=cli
   codex      available=true kind=cli
   opencode   available=true kind=cli
   zcode      available=true kind=cli
```

**用户看到什么**：面板「状态」标签里四家全绿，派发与圆桌的选择器里四家都可选。点下去才发现
spawn 失败。状态页的全部意义就是回答"现在哪家能用"，而它答错了。

**根因**：`detect()` 在 `src/provider/*.js` 里**都实现了**（claude/codex/opencode/zcode 各自的
`async function detect()`），但**没有任何生产代码路径调用它**——grep 显示 `detectAll` 只出现在
`tests/` 里。

**修复**：

```js
// 在 list() 里（或 /state handler 里，带短 TTL 缓存避免每次探测都 spawn --version）
const detected = await registry.detectAll()
const stateOf = (id) => detected.find((d) => d.id === id)
// 每行改为：
available: stateOf(providerId)?.available === true,
detail: stateOf(providerId)?.detail,
```

同时把 `config.providers[id].enabled === false` 的行从 `providerIds()` 里剔除
（当前 `zcode` 默认 disabled 却仍被列出）。

注意 `list()` 目前是同步的，改成 async 会影响 `src/http.js:329` 与 `src/tools.js` 的调用点——
要么让 `list()` 保持同步、在 `/state` handler 里单独 await 探测结果并合并，要么把 `list()` 改
async 并同步改所有调用点。前者改动更小。

---

### 🟠 C3 — `resumeSessionId` 的守卫放在真实计费调用**之后**

**严重度：high（白花钱 + 错误信息被掩盖）**

`src/backend.js:232-248`：

```js
const activation = await route.service.startActivation({   // :232 ← 已经 spawn 了真实的 Codex/Claude 进程
  provider: providerName, ...
})
let primary
try {
  activation.result.catch(() => {})
  if (hasResumeId(request.resumeSessionId)) throw resumeRejection(...)   // :248 ← 守卫在这里才执行
```

官方 provider 的 `startActivation` 一旦接受就会 spawn 进程、跑 `initialize` 握手、建 thread。
守卫在**那之后**才抛，`finally` 再 dispose。

**官方权威**（`packages/subagent/subagent-codex/README.md`）：

> "**One fresh process, thread, and turn per run.** Every run spawns a fresh app-server, creates one
> ephemeral thread, and executes exactly one turn; there is no continuation, resume, or pooling."

**影响**：
1. 调用方带了 `resumeSessionId` → 付了完整的进程启动 + 握手 + thread start 的钱，只为收到一个
   **本来可以零成本提前知道**的错误。
2. 更糟：如果官方 payload 缺失，`startActivation` 会先抛 `initialize` 诊断，`:248` 永远到不了——
   用户看到的是底层的 initialize 错误，而不是"官方后端不支持续聊"这个真正原因。

**修复**（一行搬家）：把守卫提到 `startActivation` **之前**：

```js
if (hasResumeId(request.resumeSessionId)) throw resumeRejection(providerId, providerName)
const activation = await route.service.startActivation({ ... })
```

---

### 🟠 C4 — 圆桌绕过并发闸门，且第 2 轮 prompt 与第 1 轮零前缀共享

**严重度：high（成本与稳定性，非功能性）**

**证据 1 — 闸门漏掉圆桌**：

```
$ grep -n "gate.run" src/tools.js
233:    const result = await gate.run(signal, () => backend.dispatch({
319:          const produced = gate.run(controller.signal, () => backend.dispatch({
```

两处都在 `agent_dispatch` 内（`:233` 前台、`:319` 后台）。圆桌的执行体在 `:391-425`，
直接调 `runRoundtable`，**从未经过 `maxConcurrent`**。所以 `maxConcurrent: 3` 管不住圆桌：
4 家并发就是 4 路直发，多个圆桌 job 叠加则更多。后果是限流（provider 429）与成本尖峰。

**证据 2 — 前缀零共享**（`src/roundtable.js:5-20`）：

```js
function buildDebatePrompt(basePrompt, round, history) {
  if (round <= 1 || !history.length) return String(basePrompt)      // 第1轮 = basePrompt 原文
  ...
  return [
    '【第' + round + '轮辩论】',      // ← 第2轮从第 0 字节就不同
    '原始问题：',
    String(basePrompt),              // ← 同样的文字，但已不是前缀
```

第 1 轮 prompt 就是 `basePrompt`；第 2 轮以 `【第2轮辩论】` 开头。**两者在第 0 个字节就分叉**，
即使 `basePrompt` 完全相同也无法复用任何缓存前缀。

**实测量化**（`cache-prefix-proof.mjs`，用插件真实拼接逻辑）：

```
round1 length: 49 chars
current design  shared prefix: 0 chars
fix A           shared prefix: 49 chars
reusable fraction under fix A: 100.0%

current round2 opens with: "【第2轮辩论】\n原始问题：\nreview thi"
fixed   round2 opens with: "review this codebase and"
```

即：当前设计**共享前缀恰好为 0**；把 `basePrompt` 提到最前面后，`basePrompt` 整段成为
严格前缀扩展，**100% 可复用**。注意实际收益按 `basePrompt` 在总输入中的占比折算——
真实 prompt 通常远长于这 49 字符示例，占比会更高。

**证据 3 — 官方权威说明**（`packages/subagent/subagent-codex/README.md`，"KV Cache effect"）：

> Independent of the parent request cache. Reuse depends only on Codex's own provider, model,
> instructions, tools, and ephemeral-thread request.

即：**跨 agent 的缓存共享在框架层面就不存在**，不要指望"圆桌让多家共享缓存"。
这一条同时是上一轮我回答"缓存命中率"问题的权威依据。

**修复优先级**：
1. 第 2 轮 prompt 改为 `basePrompt` 开头再做扩展（一行改动，让"原始问题"段可命中）
2. 圆桌纳入 `maxConcurrent`（顺带缓解 429）
3. 第 2 轮带上**自己**上一轮答案（更长的可复用前缀 + 辩论质量更好）

**注意结构性地板**：输出 token 永远不缓存。圆桌成本的大头是 `N 家 × R 轮 × 输出`，
缓存优化只能动输入侧。所以"圆桌贵"主要贵在**重复生成**，不是贵在缓存失效。

---

### 🟠 C5 — `agent_dispatch` 与官方 bundle 自带的全局工具重复，且语义相反

**严重度：high（架构层面；模型会看到两个互相矛盾的指令）**

启用 `@deepseek-ai/dsh-subagent-codex` **本身就会**给每个 Agent 装一个全局工具
（`packages/subagent/subagent-codex/cordis.patch.yml`）：

```yaml
- insert:
    - id: subagent-codex
      name: '@deepseek-ai/dsh-subagent-codex'
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
      config: { provider: codex, toolName: subagent_codex, maxDepth: provider-managed }
```

于是模型手里有**两个**指向同一个 provider 实例的工具，而它们的语义**正好相反**：

| | 官方 `subagent_codex` | 插件 `agent_dispatch` |
|---|---|---|
| 返回 | 立刻返回 `childId`，结果稍后以完成通知送达 | **阻塞等待**，直接把答案放进 tool result |
| delivery | `parent`（注入父会话） | `caller`（不注入） |
| 并发约束 | 宿主的 `maxActiveSubagents` | 插件的 `maxConcurrent`（**管不到官方工具**） |
| system prompt | 注册了一段指令 | 无 |

**最尖锐的证据**：官方工具会注册一段 system-prompt 章节
（`dsh-tool-subagent/lib/index.js:510-518`）：

> "Start independent delegations with `subagent_codex` together in one assistant message and
> continue useful work while they run."

而插件的 `agent_dispatch` 描述是（`src/tools.js:254`）：

> "Dispatch one task headlessly to an external coding agent as a subagent and return its answer."

**「发出去就继续干活」vs「等答案返回」** —— 同一个 provider，模型收到两套相反的行为指引。
而且插件自己的 `maxConcurrent` 根本无法约束官方工具，模型混用两者会静默超出配置的并发上限。

**需要澄清的是**：这**不是** provider 重复注册（插件没有调用 `registerProvider`，所以不会触发
`DUPLICATE_PROVIDER`）。问题纯在工具层，危害是可预期的模型困惑与并发失控。

**建议的处置**（三选一，按推荐度）：

1. **改文档定位**（最小改动）：明确说插件的 `agent_dispatch` 是官方工具的**同步补充**，不是替代品；
   用它当你需要答案直接落在 tool result 里（或需要 OpenCode/ZCode 这两家官方没有的）。
2. **动态收窄**：当检测到 `ctx.tools.get('subagent_codex')` 已存在时，从 `agent_dispatch` 的
   `providers` 枚举里去掉 `codex`，并在描述里说明原因。
3. **彻底分工**：插件只保留 CLI 包装层与历史导入，把 Codex/Claude 的派发完全让给官方工具。

我倾向于 **1 + 2**：既不丢掉"同步取答案"这个真实价值，又不给模型制造矛盾。

---

### 🟠 C6 — 已中止的 signal 仍会启动一次真实外部调用

**严重度：high（线 A F1）**

`src/tools.js:75-79` 的信号量快路径完全不看 `signal.aborted`：

```js
if (active < limit) {
  active += 1
  entry.begin()        // ← 有空位就直接干，不看是否已中止
  return
}
queue.push(entry)
if (signal) {
  if (signal.aborted) onAbort()   // ← 只有排队分支才检查
```

而 `begin()` 里立即调 `fn()`，即 `backend.dispatch()`；`src/backend.js` 的 dispatch 前置只有
`signal` 透传，全仓 grep `throwIfAborted` **零命中**。

**实测**（`semaphore-race2.mjs`，用插件真实的 `createSemaphore`）：

```
race5 pre-aborted+free slot -> "work executed" | work ran: true
```

**后果**：用户按了取消，CLI 路径仍 spawn 一个真实子进程，官方路径仍 spawn Codex/Claude 进程
并跑 `initialize` 握手。启动成本已经发生，然后才被 signal 杀掉。

**修复**（两处各一行）：信号量 `run()` 开头 `if (signal?.aborted) return Promise.reject(...)`；
两个 `dispatch` 的 await 之前 `request.signal?.throwIfAborted()`。

**为什么现有测试没抓到**：测试覆盖了"排队中取消"（那条路径是对的），但没覆盖
"有空位时传入已中止的 signal"。补这一条即可防回归。

---

### 🟡 C7 — `inject` 只声明 `['tools']`，其余 7 个服务全靠 `ctx.get()` 兜底

**严重度：medium（不崩，但语义上放弃了框架保证）**

`index.js` 声明 `export const inject = ['tools']`，但实际触及 `jobs`、`webServer`、`connection`、
`subagents`、`agents`、`sessionPersistence`、`sessionProjectionCache`、`workspaceRegistry`。

Cordis 的语义是：**未 inject 的服务用属性访问会抛**，`ctx.get()` 则返回 `undefined`。
代码统一用了 `ctx.get()`（这点是对的、也是我上一轮亲自修的），所以不会崩。
但代价是：**框架无法在挂载期替插件检查依赖**，缺服务时插件静默降级而非报告。

这本身是一个可辩护的取舍（第三方插件要跨多个 profile 形态），但应当显式记录：
哪些服务是「必需」（应进 inject）、哪些是「可选增强」（继续 `ctx.get()`）。

按当前实现，建议把 `jobs` 与 `webServer` 保留为可选（`webServer` 在 headless 下确实没有），
但 `jobs` 一旦存在就应当可用——这正好是 C1 的根因。

---

### 🟡 C8 — `tablist` 声明了 ARIA 角色却未实现方向键导航

见 [05-client-ui.md](05-client-ui.md) F1。`client.js:1224-1232` 有 `role="tablist"` / `role="tab"` /
`aria-selected`，但全文件无 `onKeyDown`/`ArrowLeft`/`tabIndex`。键盘用户必须按最多 4 次 Tab
才能切换标签。声明角色而不实现键盘语义，比不声明更差——辅助技术会按 tablist 预期播报。

修复约 15 行（roving tabindex + 方向键/Home/End）。

---

### 🟡 C9 — 官方子代理路径静默回落，运维看不到原因

**严重度：medium（线 B F11）**

`agent_dispatch` 只有在**同时满足**「配置了 `subagentProvider`」+「该 provider 已注册」+
「调用方是活 Agent」时才走官方路径。任一不满足就静默落到 CLI，且 `resolver.list()` 的
`detail` 字段只在 CLI 也不存在时才给出原因。

于是：运维配置了 `providers.claude.subagentProvider: 'claude-code'`、装好了官方 bundle，
但某次调用没有 `exec.agent`（例如从 HTTP 面板发起），就会**悄悄**走 CLI，无任何提示。

**修复**（纯报告层，不动派发逻辑）：让 `list()` 在「配置了 subagent provider + provider 已注册
+ 但无活父 Agent」时返回
`{ kind:'subagent', available:false, detail:'official provider registered but the call has no live parent Agent' }`。

---

## 1.5 成本经济学的量化结论（线 D 摘要）

这是本轮审计里信息密度最高的一段，值得单独摘出来。假设：`S=12,000`（系统提示+工具 schema）、
`P=800`（问题）、`A=1,200`（每次回答）、`PEER=2,050`（第 2 轮同伴块）、`N=4`、`R=2`；
价格比按 input=1.0 / cache write=1.25 / cache read=0.1 / output=5.0。

| 方案 | 总成本（tok-eq） | 相对现状 | 输出占比 |
|---|---|---|---|
| **现状** | 158,600 | — | 30.3% |
| **Fix A**（第 2 轮保留 `basePrompt` 前缀） | 125,320 | **−21.0%** | 38.3% |
| Fix A（若 `S+P` 在第 1 轮前已预热） | 112,520 | **−29.1%** | 42.7% |
| Fix A + 排除自己的答案 | 123,320 | **−22.2%** | 38.9% |
| Fix B（每成员续聊自己的会话） | 125,800 | −20.7% | 38.2% |
| Fix C1（串行化，4 家不同厂商） | 158,600 | **0.0%** | 30.3% |
| Fix C2（串行化，同厂商） | 142,090 | −10.4% | 33.8% |
| Fix C2 + Fix A | 81,160 | **−48.8%** | 59.1% |
| *陷阱*：加 cache 注解但保持坏前缀 | 186,250 | **+17.4%（更差）** | 25.8% |

**四条结论**：

1. **Fix A 才是正确解法，不是 Fix B。** 省得更多（21.0% vs 20.7%）、改动是一个数组重排，
   且在两条后端路径上都有效；Fix B 需要三套 resume argv 且官方路径根本不支持。
2. **串行化在默认配置下省 0%**，因为四家厂商四个独立缓存，别人的写永远等不到你的读。
   它的真实价值是**限流控制与延迟**，不是省钱；只有当多个成员共用同一 provider 时才变成 −10.4%。
3. **天真修复会主动变差 +17.4%**（见"不要做"第 2 条）。
4. **收益有上限，且大头不在问题文本上**：第 2 轮派发里系统提示占输入 **80.8%**，
   问题只占 5.4%，新同伴信息占 13.8%。跨轮重复的 `S+P` 是当前花费的 32.3%，
   以 0.1× 回收后是 **29.1% 的硬上限**（还要扣掉写入溢价）。

**输出 token 永远不缓存**——现状下输出占 30.3%，所以任何缓存工作的天花板都摆在明面上：
圆桌主要的钱花在**重复生成**上，不在缓存失效上。这与我上一轮对话的判断一致，现在有了量化支撑。

---

## 2. 已确认正确的部分（不是自我表扬，是划清边界）

审计的价值包括确认「哪些没问题」。以下由机械核验或真实运行时验证：

| 项 | 证据 |
|---|---|
| 186/186 离线测试通过，零外部依赖 | `node --test 'tests/*.test.js'` |
| 导入事件流通过真实 v4 准入与关系校验 | `assertV4RowAdmission` + `assertReleasedV4Relationships` |
| 真实 JSONL 后端写入→校验→读回 23 事件原样往返 | `write-validate.mjs` |
| 插件在真实 Cordis 挂载；6 工具参数均为合法 JSON Schema | `mount-validate.mjs` |
| 卸载后工具 6→0、路由 1→0（effect 归属正确） | `dispose-validate.mjs` |
| 零 `@deepseek-ai/*` 运行时 import | `grep -rn` 无输出；deps/peer 均为 none |
| i18n 98/98 键完全对齐；无 CJK 泄漏 | 脚本比对 |
| 零字面颜色；13 个主题令牌全部真实存在 | `comm` 比对 ui-theme 117 个令牌 |
| `dsh.client.inject` 两个包名均真实存在 | 逐个目录检查 |
| 轮询定时器有 `live` 标志 + `clearTimeout` 双保险 | `client.js:496-500`、`:1110-1114` |
| 所有失败路径都渲染带重试的 ErrorRow，无空白页 | `client.js:523-527` 及 6 处调用 |
| 无 react-dom / document.body / MutationObserver 残留 | `grep -c` = 0 |

### 框架侧经专家复核确认为 CLEAN 的 5 项（线 B）

这几条**曾被怀疑有问题、复核后确认写对了**，价值不低于找到 bug：

| 项 | 权威依据 | 结论 |
|---|---|---|
| 工具的 `output.schema` 全在受支持子集内 | `dsh-tools/lib/types/schema.d.ts` | ✅ 不会在注册时被拒 |
| `execute` 抛错被框架转为结构化 `isError` 结果 | `dsh-tools/lib/index.js` | ✅ 不会变成未处理拒绝、不会杀 turn |
| `isConcurrencySafe` 缺省是**正确且必需**的 | 框架默认 `exclusive` | ✅ 外部派发本就不该并行 |
| `delivery: 'caller'` 是正确选择 | `dsh-subagent/lib/types` | ✅ 它是结果能返回给调用方的**唯一**方式 |
| 省略 `maxDepth` 对 `NO_START_CAPABILITIES` provider 是对的 | `subagent/lib/types` | ✅ 传了反而会被 seam 拒绝 |

### 并发与资源管理经实测确认为 CLEAN 的 4 项（线 A）

用插件**真实的** `createSemaphore` 跑竞态脚本（`semaphore-race.mjs`）：

| 场景 | 结果 |
|---|---|
| 排队中 abort | ✅ 立即出队并 reject，不占槽 |
| abort 后槽位是否泄漏 | ✅ 后续任务正常获得槽位 |
| `fn` 同步抛错后槽位 | ✅ 抛出正确，槽位释放 |
| abort 后监听器悬挂 | ✅ `getEventListeners` 计数 = 0 |

另外 `src/runner.js` 的 `settle` 单一出口设计正确地防止了双重结算与定时器泄漏。

---

## 3. 修复优先级建议

综合五条线的排序，按「真实危害 ÷ 工作量」。`S` ≈ 30 分钟内，`M` ≈ 数小时，`L` ≈ 一天以上。

### 第一批：必须修（都是 S，且都在用户直接受损的路径上）

| 序 | 事项 | 依据 | 收益 | 工作量 |
|---|---|---|---|---|
| 1 | **`startJob` 包 try/catch + `ctx.jobs.attachController`** | C1 | 后台/圆桌从"必然抛错"恢复可用；既有内联回退已写好，只是被绕过 | S |
| 2 | **`/state` 接 `detectAll()` + 过滤 `enabled:false`** | C2 | 状态页从"全绿谎报"变为真实；避免 4 家全选后集体失败 | S |
| 3 | **`resumeSessionId` 守卫提到 `startActivation` 之前** | C3 | 每次被拒的续聊不再白付一次进程启动 | S |
| 4 | **`signal.throwIfAborted()` 前置到 dispatch 与信号量** | A-F1 | 取消不再白启动真实外部调用 | S |
| 5 | **第 2 轮 prompt 以 `basePrompt` 开头** | C4 / D#1 | **−21.0%** 成本（`R≥2` 时），纯数组重排 | S |
| 6 | **圆桌纳入 `maxConcurrent`** | C4 / D#5 | 防 429 与成本尖峰；共享 provider 场景额外 **−10.4%** | S |
| 7 | **圆桌排除成员自己的上一轮发言** | D#3 | 修正一个假陈述（告诉成员"这是别的 agent 说的"，其实是它自己） | S |

### 第二批：应该修（M，涉及文案/契约/可访问性）

| 序 | 事项 | 依据 | 说明 |
|---|---|---|---|
| 8 | 明确 `agent_dispatch` 与官方 `subagent_codex` 的分工，或动态收窄 `providers` 枚举 | C5 | 两个语义相反的工具同时暴露给模型，会让模型困惑并绕过 `maxConcurrent` |
| 9 | 上报 `backend` 与 per-member token usage | D#4 | 插件目前是成本黑盒；这一个字段让其余所有成本结论从猜测变可测 |
| 10 | 修 `tablist` 键盘导航 | C7 | 唯一的可访问性实质缺陷，约 15 行 |
| 11 | `subagentRoute` 失败时在 `list()` 里给出原因 | B-F11 | 官方路径静默回落到 CLI，运维看不到"为什么没走官方" |
| 12 | 把 `inject` 与可选服务的划分写进文档 | C6 | 让取舍显式，而非隐含 |
| 13 | 区分 `ENOENT` 与权限错误（provider 的 `readFileSync` catch） | A-F3 | 环境问题不该伪装成"会话是空的" |

### 第三批：可选（低优先或需产品决策）

| 序 | 事项 | 依据 |
|---|---|---|
| 14 | 宣布 `rounds` 默认 1，或给多轮加收敛判据 | D#8（第 2 轮占总成本 1/3 且无收益度量） |
| 15 | 输出不再截断到 4000 字符（只限制渲染层） | D#7（已付费的输出被展示函数删掉，回收 **5.0%**） |
| 16 | provider 路径探测改为 PATH 优先、Termux 前缀按需 | A-F2（跨 profile 可移植性） |
| 17 | 区分 `SubagentError` 的 code，不要压平成普通 `Error` | B-F14 |

### ⚠️ 明确**不要**做的两件事

1. **per-member resume（让每个成员续聊自己的会话）** ——它只比 Fix A 多省 0.3 个百分点
   （20.7% vs 21.0%），却要为三家 CLI 各写一套 resume argv（`--resume` / `resume` 子命令 /
   `-s`），且官方子代理路径**根本拒绝 resume**。Fix A 严格占优。
2. **在"头部先行"的 prompt 上直接加 cache 注解** ——实测这会让第 2 轮对整块
   `S + P + PEER` 付 1.25× 写入费却永远读不到，**比现在更差 +17.4%**。
   这是后续补丁最可能引入的回归，值得专门写一个测试守住。

---

## 4. 审计方法与局限（必须说明）

**做了什么**：
- 5 条专项线分工，各自独立取证、独立产出，避免同一个人既写代码又给自己盖章
- 每条结论都要求 file:line 或可复现命令；Lead 独立复核了 C1、C2、C3、C4、C6 以及全部
  「已确认正确」项，**没有直接采信团队成员的结论**
- C1 用真实 `LocalJobRegistry` 实例证明；C2 用真实 `detectAll()` 与 `list()` 双向对照；
  C4 用真实拼接逻辑量化前缀；C6 用真实 `createSemaphore` 跑 7 个竞态场景
- 审计全程**只读**：`git status` 确认除 `docs/audit/` 外零改动，186 测试审计前后均全绿

**过程中的一次事故与处置**：
第一轮 4 个审计成员全部因网络中断被杀死且无落盘。处置方式是：释放任务 → 重新派发并要求
**增量写盘**（先写骨架再逐节追加）→ 第二轮成功产出 5 份报告中的 4 份。缺陷线由 Lead 补齐。
这次事故本身也验证了一件事：**长任务的产出必须增量持久化**，否则一次网络抖动就全部归零。

**没做什么 / 局限**：
- **无浏览器交互控制**：面板的视觉渲染、真实焦点行为、点击链路未在浏览器实测。已有替代证据
  是客户端作者在 jsdom + React 18 下的无头渲染（五标签、错误重试、zh/en 无泄漏键），
  但这不覆盖像素与焦点。
- **无外部 CLI**：本机 `claude`/`codex`/`opencode`/`zcode` 一个都没装，CLI 包装层只有 fixture 覆盖。
- **官方 bundle 未安装**：`dsh-subagent-codex`/`-claude-code` 不在 node_modules 里（这正是
  `availability: missing` 的原因），官方行为依据来自源码 checkout 而非运行时。
- **无真实额度消耗**：官方子代理与 CLI 的真实派发均未执行，这是唯一需要付费的验证项。
- **SQLite 句柄未验证**（线 A 最大缺口）：`provider/opencode.js`、`provider/zcode.js` 的
  `node:sqlite` 打开/查询/关闭路径，特别是**异常路径是否关闭句柄**，未做实测。这是本报告里
  唯一可能真正泄漏系统资源的地方。
- **无 soak test**：未做长时间运行下的进程/内存泄漏观测。

---

## 5. 与上一轮对话结论的衔接

上一轮我回答"圆桌会不会让缓存命中率大幅下降"，本审计**确认并精确化**了那个回答：

| 上一轮的说法 | 本审计的验证结果 |
|---|---|
| 父 Agent 缓存不受影响 | ✅ 成立。圆桌结果只是追加到会话末尾的一条 tool result，前缀不变 |
| 外部 agent 命中率恒为 0，与圆桌无关 | ✅ 成立。`agent_dispatch` 单发也一样，每次全新 session |
| 第 2 轮前缀在第 0 字节就分叉 | ✅ 逐行确认（`src/roundtable.js:5-20`），并**量化为共享前缀 = 0 字符** |
| 圆桌没走并发闸门 | ✅ `grep gate.run` 确认只有两处、都在 `agent_dispatch` |
| 输出 token 永不缓存，是成本大头 | ✅ 量化为现状下占 30.3%，因此缓存工作有硬天花板 |
| 第 2 轮可改成 `basePrompt` 开头 | ✅ 量化：**−21.0%**，且这是收益最高的单项改动 |
| （我未提及）官方 README 的权威依据 | ➕ 新增：「KV Cache effect: Independent of the parent request cache」 |
| （我未提及）串行化能省钱 | ❌ **修正**：默认四家厂商配置下串行化省 **0.0%**，只对同厂商有效 |
| （我未提及）加 cache 注解总是好事 | ❌ **修正**：保持坏前缀时加注解会 **+17.4% 更差** |

最后两条是审计对我上一轮推理的**实质性修正**——我当时的建议方向对，但边界没说准。

---

## 6. 交付物清单

| 文件 | 行数 | 内容 |
|---|---|---|
| `docs/audit/00-REPORT.md` | 617 | 本文件：主报告、优先级、方法论 |
| `docs/audit/01-bugs.md` | 185 | 缺陷/竞态/泄漏/错误路径（5 条 + 干净清单 + 未覆盖缺口） |
| `docs/audit/02-framework.md` | 622 | 框架契约对齐（14 条，含 5 条 CLEAN） |
| `docs/audit/03-official-subagents.md` | 497 | 官方 bundle 行为（11 条，含"是否该保留 subagent 路径"的判定） |
| `docs/audit/04-orchestration.md` | 723 | 成本经济学（含可复现成本模型与 8 项改动排序） |
| `docs/audit/05-client-ui.md` | 253 | 客户端 UI/i18n/主题/UX（6 条 + 9 项机械核验通过） |

合计 **2,897 行**。所有定量结论均可用仓库内脚本或文中给出的命令复现。
