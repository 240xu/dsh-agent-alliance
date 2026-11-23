# T3 — ACP 未验证项补齐

> 执行者：audit-bugs。只写本文件，不改源码，不 commit。
> 环境：opencode v1 `1.19.6`（`/home/ova/agent-clis/...`）、v2 `2.3.2`（`.artifacts-live-test/oc2/...`），
> 代理 `HTTPS_PROXY=http://127.0.0.1:19893`（不带则 `session/prompt` 42s 超时）。

## 结论速览

| # | 问题 | 结论 |
|---|---|---|
| 1 | mode 到底能不能切 | **能**。正确 method 是 `session/set_config_option`，字段 `{sessionId, configId, value}` |
| 1b | C5 用的 `session/select_config_option` | **不存在**，返回 `-32601 Method not found` → **C5 的 mode 切换从未生效** |
| 2 | plan 是否真拦写入 | *（待测）* |
| 3 | v2 三个声明 | *（待测）* |

**最重要的发现**：C5 的 `session/select_config_option` 是**编造的 method 名**，服务端直接
`Method not found`。所以 C5 的"plan 模式仍写入"是在 **build 模式**下测的——**那个结论作废**。

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
