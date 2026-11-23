# T3 — ACP 未验证项补齐

> 执行者：audit-bugs。只写本文件，不改源码，不 commit。
> 环境：opencode v1 `1.19.6`（`/home/ova/agent-clis/...`）、v2 `2.3.2`（`.artifacts-live-test/oc2/...`），
> 代理 `HTTPS_PROXY=http://127.0.0.1:19893`（不带则 `session/prompt` 42s 超时）。

## 结论速览

| # | 问题 | 结论 |
|---|---|---|
| 1 | mode 到底能不能切 | **能**。正确 method 是 `session/set_config_option`，参数 `{sessionId, configId, value}` |
| 1b | C5 用的 `session/select_config_option` | **不存在**（`-32601 Method not found`，v1/v2 都一样）→ **C5 的 mode 切换从未生效** |
| 2 | plan 是否真拦写入 | **拦住了**（v1 与 v2 均实测）。**C5 的结论作废** |
| 3a | v2 `additionalDirectories` | ⚠️ 声明存在，但**无可观测效果**（传不传都能写 cwd 外） |
| 3b | v2 `delete` | ✅ 确认可用（list 前后对比，会话真的消失） |
| 3c | v2 `steering` | ✅ 确认可用（`_session/steering`；声明在 `_meta` 下，不在 `sessionCapabilities`） |

**最重要的发现**：C5 的 `session/select_config_option` 是**编造的 method 名**，服务端直接
`Method not found`。所以 C5 的"plan 模式仍写入"是在 **build 模式**下测的——**那个结论作废**。

**第二个发现（差点写错）**：v1 的 `session/load` 会把 mode **重置回 build**。
用 load 去做验证会得到完全相反的结论（见 §5）。

---

## 1. mode 切换：正确调用方式（已证明生效）

### 1.1 方法名对照（v2 2.3.2 实测）

```js
// ❌ C5 用的（不存在）
session/select_config_option  ->  {"error":{"code":-32601,"message":"\"Method not found\""}}

// ✅ 正确
session/set_config_option     ->  {"result":{"configOptions":[...]}}
// 参数：{ sessionId, configId, value }
```

从 v2 二进制里枚举到的 ACP 方法（`strings opencode | grep -oE "session/[a-z_]+"`）：

```
session/new  session/load  session/prompt  session/list  session/delete
session/set_config_option   session/set_mode   session/steering
session/cancel  session/update  session/request_permission  session/close  ...
```

`session/set_mode` 也存在，参数是 `{ sessionId, modeId }`（**`modeId` 不是 `mode`**，传 `mode` 报
`Invalid input: expected string, received undefined`）。但见 §1.4：它不返回可验证状态。

### 1.2 证明切换生效（不是靠响应自述）

**响应里的 `configOptions` 不可信**——我发现它会滞后一拍。连续切换 5 次：

```
0 initial: build
1 set(plan) -> plan
2 set(build) -> build
3 set(plan) -> plan
4 set(build) -> plan     ← 滞后（要的是 build，回显 plan）
5 set(plan) -> build     ← 滞后
```

所以**不能用 set 的响应证明切换成功**。改用独立读回路径 `session/load`
（重新从会话状态读，不是回显本次写入）：

```
$ node load.mjs
initial (new): build
independent read via session/load: build | keys: [ 'configOptions' ]
set(plan) response says: plan
AFTER set(plan), independent load says: plan      ← 独立读回 = plan
after 1.5s settle, load says: plan                ← 稳定，不是瞬时回显
```

⇒ **mode 确实切换并持久化。** 判定成立。

### 1.3 补充证据：非法值被拒（说明这次真的走到了 mode 校验）

```js
session/set_config_option {configId:'mode', value:'nonexistent-mode'}
-> {"error":{"code":-32602,"message":"Invalid params: mode not found: nonexistent-mode"}}
```

C5 那次如果真走到了校验，非法值会报错；而 C5 用的是不存在的 method，连校验都没进。

### 1.4 `set_mode` 的问题（不推荐用于需要验证的场景）

`session/set_mode {sessionId, modeId}` 返回 `{"result":{}}` —— **空对象，不回任何状态**。
没有可观测证据说明它生效了，也没有像 `set_config_option` 那样回 `configOptions`。
⇒ 需要证明切换的应用应使用 `session/set_config_option`。

### 1.5 可复现命令

```bash
cd /tmp/t3 && timeout 150 node load.mjs
# 需要的环境变量（lib.mjs 已内置）：
#   HTTPS_PROXY=http://127.0.0.1:19893 HTTP_PROXY=http://127.0.0.1:19893
```

<!-- APPEND: plan write test -->

## 2. plan 模式是否真拦写入 —— **确定结论：拦住了**（推翻 C5）

### 2.1 关键前提：C5 的 mode 从未切换成功

C5 用的是 `session/select_config_option`，服务端返回 `-32601 Method not found`。
也就是说 C5 那两次"实测"（build/plan）**跑的都是 build 模式**，所以"plan 也不拦写入"
只是"build 写入"被贴了两次标签。**C5 的这条结论作废。**

### 2.2 本次实验设计（保证 mode 真的切了）

每次写入前做三件事，缺一不可：

1. `session/set_config_option {configId:'mode', value:MODE}`
2. **独立读回** `session/load` → 取 `configOptions[mode].currentValue`
3. 断言读回值 == 请求值，才继续；否则该轮作废

### 2.3 实测结果

```
$ node buildvsplan.mjs
=== BUILD | requested=build CONFIRMED=build ===
stopReason: end_turn
updates: agent_thought_chunk,tool_call,tool_call_update,tool_call_update,agent_message_chunk,usage_update
FILE WRITTEN: true "BUILD"

=== PLAN | requested=plan CONFIRMED=plan ===
stopReason: end_turn
updates: available_commands_update,agent_thought_chunk × N,agent_message_chunk × 2,usage_update
FILE WRITTEN: false

mode at very end: plan
```

磁盘核对：

```bash
$ ls /tmp/t3/ws4/
BUILD.txt          # 只有 build 的那一个
$ test -f /tmp/t3/ws4/PLAN.txt && echo YES || echo NO
NO — plan mode blocked the write
```

### 2.4 差异是**结构性**的，不是运气

不只是"文件没写成"，**工具调用序列本身不同**：

| 模式 | 出现的 update 类型 | 有没有 `tool_call` |
|---|---|---|
| build | `agent_thought_chunk, tool_call, tool_call_update, agent_message_chunk, usage_update` | ✅ 有 |
| plan | `agent_thought_chunk × N, agent_message_chunk, usage_update` | ❌ **完全没有** |

⇒ plan 模式下模型**根本没有调用写入工具**。而且是模型自己在推理中引用了 plan 约束：

> "System-reminder says plan mode: do not modify any other files..."

即 opencode 通过 **system-reminder 注入**把 plan 约束送到模型，模型据此放弃了写入。
这和 v2 的 plan 描述一致：**"Read-only agent for exploring the codebase and planning work"**。

### 2.5 但要注意一个**边界**（不要过度归纳）

本实验只证明了：**模型会遵守注入的 plan 约束，不调用写入工具**。
它**没有**证明服务端会硬性拒绝一次写操作。区分很重要：

- 若模型**无视** system-reminder 强行发 tool_call，服务端是否拒绝？——**本次未测**。
- 对"模型驱动的 agent"这个用例，这个区别影响不大（模型遵守即可）；
- 但若要把 plan 当作**安全边界**（对抗恶意/越狱 prompt），必须另测服务端强制。
  本报告**不**声称 plan 是一道安全边界。

### 2.6 顺带修正 C5 引用的描述文本

C5 写的是 opencode 把 plan 描述为 "Disallows all edit tools"。
**v2 2.3.2 实际描述**是："Read-only agent for exploring the codebase and planning work before
implementation." —— 措辞不同，而且"read-only agent"是**角色描述**，不是"硬拒绝工具"的承诺。
这进一步说明 §2.5 的边界区分是必要的。

<!-- APPEND: v2 caps -->

## 3. v2 三个声明实测

### 3.1 `additionalDirectories` —— **声明存在，但不是访问门槛（无法证明它做了什么）**

`initialize` 的 `sessionCapabilities` 里确实有 `additionalDirectories:{}`。
`session/new` 接受该参数（不报错）。但**行为上无法区分它是否生效**：

```
$ node addir2.mjs
[with]    additionalDirectories=SET   stopReason=end_turn
  wrote outside cwd: true "WROTE_with"
[without] additionalDirectories=none   stopReason=end_turn
  wrote outside cwd: true "WROTE_without"
```

磁盘核对：

```
$ ls /tmp/t3/addir/extra/
data.txt  out_with.txt  out_without.txt     # 两个都写了，且都在 cwd 之外
```

**结论**：**不传 `additionalDirectories` 也能写 cwd 之外的绝对路径**。
所以它**不是**"允许访问额外目录"的门槛——这个 opencode 构建对文件写入本身没有目录限制。
`additionalDirectories` 可能影响别的语义（如 `AGENTS.md` 搜索路径，二进制里有
`additionalDirectoriesForClaudeMd` 字样），但**本实验无法证明任何可观测效果**。

⇒ 判定：**声明存在，实测无可观测差异**。不声称它"能用"也不声称它"坏了"。

### 3.2 `delete` —— **确认可用**

```
$ node del.mjs
created: ses_df8b0e066ffem37BpSq0RPtpTD
list before delete has it: true
session/delete -> ok {}
list after delete has it: false      ← 列表里真的没了
```

不是"返回 ok 但没删"：**前后 `session/list` 对比**确认会话确实消失。

### 3.3 `steering` —— **确认可用，但声明在 `_meta` 里不在 `sessionCapabilities`**

声明位置容易看漏：

```
$ node caps.mjs
agentCapabilities.sessionCapabilities: { additionalDirectories, close, delete, fork, list, resume }
                                         ← 没有 steering
$ node steer.mjs
_meta: {"steering":{"supported":true}}   ← 在这里
```

二进制源码印证（`strings` 上下文）：

```
sessionCapabilities:{additionalDirectories:{},close:{},delete:{},fork:{},list:{},resume:{}},
_meta:{[wh]:!0}},
authMethods:[R],
_meta:{steering:{supported:!0}},agentInfo:{name:"OpenCode",version:...}
```

所以 C4 说"v2 声明了 steering"**是对的**，但它记在 `_meta` 下（`_meta.steering.supported`）。
**若只读 `sessionCapabilities` 会误判为"不支持"。**

调用方式与空闲行为：

```js
// 正确方法名（注意下划线前缀）
_session/steering { sessionId, prompt: [...] }
-> 空闲时：{"outcome":"promptRequired","reason":"noRunningTurn"}   ← 是结构化响应，不是 Method not found
-> 运行中：{"outcome":"injected"}                                 ← 真正注入成功

// 错误写法
session/steering -> {"error":{"code":-32601,"message":"\"Method not found\""}}
```

**运行中注入的实测**：

```
$ node steer2.mjs
steering during turn -> {"outcome":"injected"}
prompt finished stopReason: end_turn
STEERED appears in output: true     ← 中途改向真的改变了模型输出
```

⇒ 判定：**可用**（`_session/steering`，只有回合运行中才 `injected`）。

---

## 4. v1 与 v2 的方法名一致（顺带确认）

C5 可能用的是 v1，所以两个版本都查了：

| 项 | v1 `1.19.6` | v2 `2.3.2` |
|---|---|---|
| `session/select_config_option` | ❌ `-32601 Method not found` | ❌ `-32601` |
| `session/set_config_option` | ✅ ok | ✅ ok |
| `sessionCapabilities` | `{close,fork,list,resume}`（无 `additionalDirectories`/`delete`） | `+{additionalDirectories,delete}` |
| `_meta.steering` | `undefined` | `{supported:true}` |
| plan 描述文案 | **"Plan mode. Disallows all edit tools."**（C5 引的就是这句） | "Read-only agent for exploring the codebase and planning work" |

⇒ **C5 的 method 名在任何版本上都是错的**。C5 引用的是 v1 的描述文案，
但 v1 上同样只能用 `set_config_option`。

<!-- APPEND: summary -->

---

## 5. 补充：v1 上有个陷阱 —— `session/load` 会把 mode 重置回 build

这一点我**差点写错**，必须记下来，否则下一个人会重复踩。

### 5.1 先看矛盾的数据

第一轮 v1 测试（`v1plan.mjs`，**在 prompt 前调用了 `session/load` 做验证**）：

```
v1 mode confirmed: build          ← 明明 set 过 plan
v1 had tool_call: true
v1 FILE WRITTEN: true "V1PLAN"
```

看上去像"v1 上 plan 不生效"。但换成**不调用 load**、直接在同一会话里写：

```
$ node v1write.mjs
v1 set response: plan (in-session)
stopReason: end_turn
tool_call present: false | FILE: false
plan mention in reasoning: "Plan  Mode  is active and I must not  make any edits"
```

⇒ **plan 在 v1 上是生效的**（无 `tool_call`、文件没写、模型明说 "I must not make any edits"）。

### 5.2 差异的唯一变量就是 `session/load`

```
$ node v1seq.mjs
v1 new: build
v1 set(plan) RESPONSE mode: plan      ← 会话内确实变了
v1 load after set: build              ← 一 load 就回到 build
v1 set_mode(modeId=plan) -> {}
v1 load after set_mode: build         ← 同样被重置
```

⇒ **v1 的 `session/load` 不保留 mode**：它把会话的 mode 恢复成默认 `build`。
所以"用 `session/load` 读回当前 mode"这个验证手段**在 v1 上会破坏被测状态**
（观察者效应），得出完全相反的结论。

### 5.3 两版本的验证手段必须分开

| 版本 | `set_config_option` 是否生效 | 读回手段 | 注意 |
|---|---|---|---|
| **v2 2.3.2** | ✅ 生效且持久 | `session/load` **安全**，能读回正确值 | 用它验证无副作用 |
| **v1 1.19.6** | ✅ 生效（**仅限同一会话内**） | `session/load` **会重置为 build** | **不能**用它验证；只能靠"行为证据"（有无 `tool_call` / 文件是否写出 / 模型推理是否提到 plan） |

### 5.4 这对 C5 的最终解释

C5 既用错了 method 名（`select_config_option` → `Method not found`），
又（若中途重载过会话）可能撞上 v1 的 load 重置。
两种错误**都会**让实际执行落在 build 模式 —— 与 C5 观察到的"plan 仍写入"完全吻合。

**C5 的结论（plan 不拦写入）在 v1 与 v2 上都不成立。**

---

## 6. 无法验证 / 明确留白

诚实标注本次**没有**证明的东西：

| 项 | 状态 | 原因 |
|---|---|---|
| plan 模式下**服务端**是否硬拒绝一次写操作 | **无法验证** | 模型在 plan 下根本没发 `tool_call`，没有可拒绝的请求。要测需绕过模型直接构造 tool_call，ACP 不提供该入口 |
| `additionalDirectories` 的实际语义 | **无法验证** | 传与不传都能写 cwd 之外，无可观测差异；可能的语义（`AGENTS.md` 搜索路径）本次未涉及 |
| `_session/steering` 的 `promptRequired` 完整语义 | **未完全验证** | 只验证了"空闲→promptRequired/noRunningTurn"和"运行中→injected" 两个分支；其他 outcome 未探索 |
| v1 的 `session/load` 重置 mode 是否为**设计**还是 bug | **无法判定** | 只有行为证据，无 v1 源码或文档佐证 |

---

## 7. 复现清单

全部脚本在 `/tmp/t3/`（一次性，未入库）。关键三步：

```bash
cd /tmp/t3
# 1) 证明 mode 能切（v2，用 load 独立读回）
timeout 150 node load.mjs
# 2) build vs plan 写入对比（v2）
timeout 500 node buildvsplan.mjs
# 3) v1 的 load 重置陷阱
timeout 200 node v1seq.mjs && timeout 300 node v1write.mjs
```

所有脚本共用 `lib.mjs`，它内置：
```
HTTPS_PROXY=http://127.0.0.1:19893  HTTP_PROXY=http://127.0.0.1:19893
NO_PROXY=127.0.0.1,localhost
```
（**不带代理则 `session/prompt` 会 42s 超时**；`--help`/`initialize` 不需要代理。）

---

## 8. 给 C4/C5 的修正建议

1. **C5 §2「mode: 'plan' 也没有阻断写入」→ 删除或改写为已推翻**。
   实测（v1 与 v2）plan 都拦住了写入。
2. **C5 §6「未验证：select_config_option 的正确调用方式」→ 已解决**：
   正确 method 是 `session/set_config_option`，参数 `{sessionId, configId, value}`。
3. **C4「v2 声明了 additionalDirectories/delete/steering 但未实测」→ 已补**：
   `delete` ✅ 可用；`steering` ✅ 可用（声明在 `_meta.steering` 下，容易看漏）；
   `additionalDirectories` ⚠️ 声明存在但**无可观测效果**。
4. 若插件未来要用 mode 切换：**必须用 `set_config_option`**，且**不要**用 `session/load`
   验证 v1（会重置）。
