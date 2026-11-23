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
