# J1 — 官方中心审计：jobs / controller 对齐

> 角色：OFFICIAL-CENTRIC AUDITOR J1。
> **最高准则（用户明示，压倒一切）**：开发绝对以官方 DSH 行为为唯一准则；
> 任何"插件自己造一套官方已有的机制"的做法都判为**偏离**，**即使它能跑通**。
>
> 对象：`/home/ova/dsh/.artifacts/dsh-plugins/dsh-agent-alliance` @ HEAD `6c22b47`。
> 权威：**已安装运行时**（`/usr/local/lib/node_modules/@deepseek-ai/dsh/`）为主，
> 源码 checkout（`/home/ova/dsh/packages/`）用于读设计意图。
>
> 本文件是唯一写入；源码零改动。

## 状态

进行中（增量落盘，逐题）：

- [x] Q1 第三方插件是否可以自己 `attachController` → **不可以，判偏离**
- [x] Q2 字符串匹配官方错误消息 → **违反官方明文规则**
- [x] Q3 四选一排序 → **(b) > (a) > (c) > (d)**
- [x] Q4 官方 delegation 是否依赖 `tool-jobs` → **完全不依赖**
- [x] Q5 最小官方中心补丁 + 回归测试

## 结论速览

| Q | 判决 | 一句话 |
|---|---|---|
| Q1 | **官方行为：❌ 自挂 controller 是框架重实现；✅ 官方行为是 `ctx.inject(['jobs'])` + 消费 `tool-jobs`** | 第三方插件是被服务方，`attachController` 是"我提供 collect/stop 能力"的声明，而官方只授权 `dsh-tool-jobs` 提供它 |
| Q2 | **❌ 违规（官方明文禁止）** | `dsh-error-handling` skill：**"Never route handling by parsing messages."** |
| Q3 | **(b) > (a) > (c) > (d)** | 官方 `tool-bash` 的模板就是 (a)+(b) 合体：`ctx.inject(['jobs'])`，缺则**抛错并点名官方包** |
| Q4 | **✅ 官方 delegation 完全不碰 `ctx.jobs`** | `dsh-subagent`/`dsh-tool-subagent` 的 `lib/index.js` 里 `ctx.jobs` **0 命中**，用 `parent.inject`/`sendWaking` 自投递 |
| Q5 | 见文末补丁 | 4 处改动 + 5 条回归测试（含 `http.js` 一个更严重的同类缺陷） |

**一句话结论**：我们插件**既是 producer 又是 consumer**，但只挂了个 producer 的引用，
却假设官方会替它提供 consumer —— 这是把"官方组合的责任"和"插件的责任"混为一谈。

---

## Q1 — 第三方插件是否可以自己 `ctx.jobs.attachController(...)`

### 判决：**不可以。自挂 controller = 重实现官方机制，判为偏离。**

#### 官方对 controller 的定义（逐字引用）

`dsh-jobs` 的公开 Service Definition（`dsh-jobs/lib/types/index.d.ts:138-145`）：

> "Attach an effect-scoped **controller that can read and stop jobs**. It serves the owners its
> registering context's scope covers, and {@link start} **refuses an owner no attached controller
> serves**."

`dsh-jobs-local/lib/index.js:546-555`（`servesOwner` 的 JSDoc）：

> "Whether an attached job controller **can collect and stop work** owned by `owner`."

`docs/subsystems/jobs.md:397`：

> "start refuses work while **no attached job controller serves** the spec's owner,
> so a producer **cannot start work that owner cannot collect or stop**."

⇒ controller 的语义**不是"开关"**，而是一句**能力声明**：
"我这个 composition 能 collect（`job_output`）并 stop（`job_kill`）这个 owner 的 job"。

#### 谁有权做这个声明：官方只有一处

```bash
$ grep -rn "attachController" /home/ova/dsh/packages --include=*.ts | grep -v test
packages/jobs/jobs/src/index.ts:192          # 抽象定义
packages/jobs/jobs-local/src/index.ts:342    # 实现
packages/jobs/tool-jobs/src/index.ts:247     # ← 生产代码里唯一调用点
```

唯一的生产调用点是 `dsh-tool-jobs`（`lib/index.js:256`）：

```js
ctx.jobs.attachController("tool-jobs");
ctx.systemPrompt.section({ ... });          // 模型被承诺"完成会有通知"
ctx.jobs.events.subscribe({ owners: "scope" }, ...);  // 完成通知投递
// 以及 job_output / job_list / job_kill 三个工具
```

**关键在于这四件事是一体的**。`attachController` 只是它提供的四分之一：
controller 声明、系统提示、settled 订阅（真正把通知送进模型 inbox）、三个消费工具。

#### 为什么我们自挂是错的

设想插件调用 `ctx.jobs.attachController('agent-alliance')`：

1. **它声明了一个不存在的能力**。`servesOwner` 变成 `true`，于是 `jobs.start()` 放行 ——
   但**我们的插件并没有注册 `job_output`/`job_kill`**，也**没有订阅 `settled` 事件**。
   job 会正常启动、正常跑完，然后**完成通知永远不会送到模型**，模型也没有工具去读它。
2. **它让官方的准入检查失效**。`start()` 里那句 `refuses an owner no attached controller serves`
   是**安全栏杆**：防止 producer 启动一个 owner **无法收尾**的工作。我们绕过它，等于
   自己拆掉了防止资源泄漏的那道门。
3. **它在冒充 `tool-jobs` 的身份**。而 `dsh-base` 已经挂了 `tool-jobs`（`base/cordis.patch.yml:284-285`）
   —— 官方明确指定了由谁承担这个角色。

⇒ 这不是"另一种实现方式"，这是**把官方已有的机制在插件里重造一份**，
而且只造了四分之一。按用户给的最高准则，**判偏离**。

#### 官方正确的形态：请求、不要提供

官方 producer 的模板（`dsh-tool-bash/lib/index.js:719-723`）：

```js
let foregroundOnly = ctx.get("jobs") === void 0 ? ctx.tools.register(bashTool(void 0)) : void 0;
ctx.inject(["jobs"], (jobCtx) => {
  foregroundOnly?.();
  foregroundOnly = void 0;
  const unregister = ctx.tools.register(bashTool(jobCtx.jobs));
  ...
});
```

注意它做的是 **`ctx.inject(['jobs'])`（请求服务）**，不是 `attachController`（提供服务）。
它假定 controller 由组合提供；没有就退回前台。

---

## Q2 — 字符串匹配官方错误消息

### 判决：**违规。官方明文禁止按消息文本路由控制流。**

#### 我们的代码（`src/tools.js:173`）

```js
} catch (error) {
  const message = String(error?.message || error)
  if (!message.includes('no job controller serves')) throw error
  warn(ctx, '...running inline instead of background')
  return undefined
}
```

#### 官方明文（`.agents/skills/dsh-error-handling/SKILL.md:12`）

> "Expected failures need **declared types, stable discriminants**, and handling-relevant details.
> Reuse package error conventions, preserve causes, and separate machine identity from display text.
> **Never route handling by parsing messages.**"

这条正好点中我们的写法：我们正在用**显示文本**（`message`）当**机器身份**（discriminant）。

#### 它有多脆

1. **官方没有给 `start()` 的失败任何 code**。实测 `dsh-jobs-local/lib/index.js:412-419`：
   ```js
   start(spec) {
     const owner = this.resolveOwner(spec.owner);
     if (!this.servesOwner(owner)) throw new Error("background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)");
     if (spec.kind.length === 0) throw new Error("invalid job kind: expected a non-empty string");
     ...
   ```
   五种失败（无 controller / kind 空 / label 空 / outputLimitBytes 非法 / 容量满）
   **全部是裸 `Error`，零 `code`**。所以我们能匹配的**只有文案**。
2. **文案是 `dsh-tool-jobs` 自己让用户去装的提示**，不是给程序判断的 API。
   官方随时可以改这段英文（它已经随版本改过一次措辞）。
3. **误判的后果不对称**：
   - 若官方把 `no job controller serves` 改成 `no controller attached for this agent` →
     我们的 `includes` 失配 → **抛错逃逸**（而不是降级），后台功能直接报错。
   - 更糟：若**别的**错误消息里碰巧含这串（例如某个 provider 的错误摘要），
     我们会把**容量超限**误当"无 controller"→ 静默转前台 → **绕过 `maxConcurrent` 上限**，
     正是 `2f6660e` 那条注释想避免的情况。

#### 正确做法

**不要推断失败原因。** 官方 producer 怎么做，我们就怎么做：
启动前就用 `ctx.get('jobs')` / `ctx.inject(['jobs'])` **确定服务是否存在**，
存在就**直接调 `start()` 并让异常照常抛出**（官方的 `tool-bash` 就是这样：
`registry.start(...)` 外面**没有 try/catch**，`dsh-tool-bash/lib/index.js:394`）。
"没有 controller" 这个条件本来就该在**组装期**被 `ctx.inject` 表达，而不是在**运行期**靠猜。

---

## Q3 — `tool-jobs` disabled 时，哪种行为是官方中心？

### 判决：**(b) > (a) > (c) > (d)** —— 且 (a) 与 (b) 在官方代码里是**同一个方案的上下半部**

先确认部署事实。`tool-jobs` 在 host 层是**关闭**的，只在 preset 层出现：

```yaml
# packages/bundle/web-app/cordis.patch.yml:484-485
- id: tool-jobs
  disabled: true
```
```yaml
# ~/.dsh/profiles/web/cordis.patch.yml:285-286（preset 内，scope 层）
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
```

#### 排名与证据

**(b) 失败要响、点名官方包 —— 最官方中心。**

官方同类场景的原文就是这个形态（`dsh-tool-bash/lib/index.js:675`）：

```js
if (jobs === void 0) throw new Error("background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs");
```

即：**缺依赖就抛错，错误消息直接告诉用户装哪个官方包**。这正是官方对"producer 需要
background 但组合没给"的答案。它满足 `dsh-error-handling` 的
"Localized, actionable, visible reports"：可读摘要 + 受影响操作 + 安全的下一步。

**(a) 用 `ctx.inject(['jobs'])` 声明依赖 —— 同样官方，且是 (b) 的机制载体。**

`dsh-tool-bash/lib/index.js:719-723` 展示的组合：`ctx.get('jobs')` 探测 →
`ctx.inject(['jobs'], ...)` 在服务出现时重注册。**官方用注入声明"我需要 jobs"，
而不是自己造 controller**。(a) 和 (b) 不冲突：用 (a) 表达依赖，用 (b) 表达缺失后果。

**(c) 静默降级到前台 —— 官方允许，但必须有明确条件。**

官方也做降级：`foregroundOnly`（`:719`）在 `jobs` 缺失时注册前台版本。
但注意区别：**官方降级是"能力降级"（工具干脆没有 background 选项），
不是"运行到一半才发现没 controller 然后偷偷改语义"**。
我们现在的做法是后者：模型传了 `background:true`、拿到的是"跑完了的前台结果"，
**行为与请求不符且无告知**。所以 (c) 只有在**启动前**就知道（`ctx.get('jobs')` 为空）
并且**在工具描述里就不承诺 background** 时才官方中心。

**(d) 自挂 controller —— 最偏离。**

理由见 Q1：声明了不存在的能力（无 `job_output`/`job_kill`/`settled` 订阅），
并且绕过官方的准入安全栏杆。

#### 一句话

官方中心的做法是 **"注入依赖 + 缺失则明确报错并点名包"（a+b）**，
而不是"自己挂个 controller 让检查通过"（d）或"悄悄换成前台"（c）。

---

## Q4 — 官方 `subagent` / `tool-subagent` 是否依赖 `tool-jobs`

### 判决：**完全不依赖。** 这就是我们该抄的模型。

```bash
$ grep -n "ctx.jobs\|attachController" dsh-subagent/lib/index.js
# （无输出）
$ grep -n "ctx.jobs\|attachController" dsh-tool-subagent/lib/index.js
# （无输出）
```

两者都是 **0 命中**。官方 delegation 的完成通知走**自己的路径**：

`dsh-subagent/lib/index.js:2048-2058`：

```js
notifySettlement(activation, terminal) {
  if (!activation.announced || activation.delivery === 'caller') return
  ...
  parent.inject(message);                                    // 忙：注入下一步
  this.sendWaking(parent, message, parent.status === "idle" ? "queue" : "steer");  // 闲：唤醒
}
```

而 `tool-subagent` 只注册一段 system prompt（`lib/index.js:509`），不碰 jobs。

#### 对我们的含义（这是本轮最重要的结论）

官方对"**长时外部工作 + 完成通知**"这件事，**没有任何一处依赖 `ctx.jobs`**。
它用：

| 官方机制 | 用途 |
|---|---|
| `subagent/start` / `subagent/end` 事件 | 可观测的生命周期 |
| activation 的 `result` promise | 结果归属 |
| `parent.inject` / `sendWaking` | 完成通知投递 |
| 自己的 tool 注册 | 模型侧入口 |

⇒ **我们的外部 CLI 派发本质上是同一类东西**（长时、外部进程、要回通知）。
官方中心的做法是**照抄这条路径**，而不是硬把自己塞进 `ctx.jobs` 这套
"bash/PTY 后台命令"专用的机制里。

这也解释了为什么我们的 `background:true` 一直别扭：我们想用 jobs 的**通知能力**，
却没有 jobs 的**消费者**；而官方早就给了另一条不依赖 jobs 的通知路径。

---

## Q5 — 最小官方中心补丁（只描述，不写源码）

### 改动 1：`src/tools.js` `startJob()`（当前 `:160-179`）

**删除** 整个 try/catch + 字符串匹配，替换为"调用方已确认存在，异常照常抛出"：

- 保留 `serviceOf(ctx,'jobs')` 的**启动前**探测，返回 `undefined` 时由调用方走前台分支
  （这是官方的 `foregroundOnly` 形态，条件在**启动前**成立）。
- **删除** `message.includes('no job controller serves')` 分支：
  不再把运行期异常翻译成降级。
- 若 `jobs` 存在但 `start()` 抛错 → **让异常逃逸**，由 `tools.execute` 的框架 catch
  转成结构化 `isError`（这是官方 `tool-bash` 的行为，`:394` 无 catch）。

### 改动 2：`index.js` `apply()`（当前 `:128-145`）

按官方 `tool-bash` 的 `ctx.inject` 形态声明 jobs 依赖，**不 attach**：

- 现有的 `ctx.effect(() => registerTools(ctx, options), ...)` 保留。
- 新增：当 `ctx.get('jobs') === undefined` 时，**降级注册**一份
  "不承诺 background"的工具集（描述里去掉 `background:true` 那句话，
  `presentCall` 也不出 background 卡片）。
- 用 `ctx.inject(['jobs'], (jobCtx) => { ... })` 在 jobs 出现后**重注册**完整版。
  ⇒ 这正是 `dsh-tool-bash/lib/index.js:719-723` 的模板。

### 改动 3：`src/http.js` `/roundtable`（当前 `:494-531`）—— 这里比 `tools.js` 更糟

工具侧至少还做了"只匹配特定文案"，HTTP 侧是**吞掉所有异常**：

```js
try {
  jobId = jobs.start({ ... })
} catch (error) {
  // A mounted jobs service without a controller refuses the start. Fall
  // through to the inline path so the panel gets an answer, not a 500.
  jobId = undefined
  ...
}
```

⇒ 官方 `start()` 的五种拒绝（无 controller / kind 空 / label 空 / `outputLimitBytes` 非法 /
**容量超限**）**全部**被翻译成"降级到前台"。其中"容量超限"被静默忽略意味着
**面板圆桌可以无上限地堆并发**——这正是 `maxConcurrentJobsPerOwner` 要防的事，
而注释（"so the panel gets an answer, not a 500"）把这个安全栏杆写成了 UX 优化。

修法同改动 1：**只有启动前的 `jobs === null` 才降级**，`start()` 抛错就让它成为 500/结构化错误。

### 改动 4：`src/tools.js` 的 `agent_dispatch` / `agent_roundtable` 描述

- `background` 参数的描述必须**反映当前注册版本**：
  前台版不出现 `background` 属性（`params()` 里动态不含它），
  而不是"有参数但实际前台跑"。

### 需要的回归测试（5 条）

| # | 测试 | 断言 |
|---|---|---|
| T1 | 无 `jobs` 服务时注册的工具 | `parameters.properties.background === undefined`；描述不含 "background job" |
| T2 | 有 `jobs` 但 `start()` 抛 `no job controller` | `execute()` **抛错**（不是静默前台），且错误消息含 `dsh-tool-jobs` |
| T3 | `jobs` 服务后挂载（`ctx.inject` 触发） | 工具被**重注册**为完整版；旧的降级注册被 `unregister` |
| T4 | 源码守卫 | grep 断言 `src/` 中**不再出现** `no job controller serves`（禁止按文案路由） |
| T5 | `src/http.js` `/roundtable` 容量拒绝 | `jobs.start` 抛 `background job limit reached` → 路由返回 **500/结构化错误**，不是 200 + 前台结果 |

T4 是关键：它把"不许按消息文本路由"这条官方规则**固化成一道门**，
防止以后有人再把字符串匹配加回来。

---

## 一句话回答（给 Lead）

- **Q3 排名**：(b) 失败要响并点名官方包 > (a) `ctx.inject(['jobs'])` 声明依赖 > (c) 启动前就降级 > (d) 自挂 controller。
- **最该停止做的事**：**不要自己 `attachController`，也不要按错误消息文本做控制流** ——
  前者冒充官方 `tool-jobs` 的消费者身份（我们只提供了四分之一的能力），
  后者违反官方 `dsh-error-handling` 的 "Never route handling by parsing messages"。
  **具体地：删掉 `src/http.js:518` 那个 `catch { jobId = undefined }`** ——
  它把官方的容量拒绝（`background job limit reached`）也吞成前台降级，
  使面板圆桌可以无上限堆并发，是两处里更危险的一处。
- **最重要的正面结论**：官方 `subagent`/`tool-subagent` **完全不依赖 `tool-jobs`**，
  用 `parent.inject`/`sendWaking` 自投递完成通知 —— 我们的外部 CLI 派发应照抄这条路径。
