# C3（落地记录）：usage 计量与圆桌前缀可验证性

> 子代理 audit-bugs 因网络超时未能交付，以下改动由 Lead 实施（提交 `a555d57`）。

## 1. 官方契约（对照基准）

`dsh-llm/lib/types/types.d.ts:160-182`：

```
Counts are DISJOINT: `inputTokens` is uncached input only; cached input is
reported separately as `cacheReadTokens`/`cacheWriteTokens` (billed input =
sum of the three). Adapters whose providers fold cache hits into a total
prompt count (DeepSeek's `prompt_tokens`) subtract them out.
```

两件事要分清：
1. DSH 的字段语义是 **disjoint**（三者和 = 计费输入）
2. **谁需要做减法** —— 只有"把缓存折进总数"的厂商（DeepSeek 的 `prompt_tokens`）

## 2. 我们的映射：重命名，零算术

`src/parse.js` 新增 `usageFromAnthropic(raw)`：

| Anthropic 原始字段 | DSH 字段 | 变换 |
|---|---|---|
| `input_tokens` | `inputTokens` | 原名保留 |
| `output_tokens` | `outputTokens` | 原名保留 |
| `cache_read_input_tokens` | `cacheReadTokens` | 原名保留，缺失则**不出现** |
| `cache_creation_input_tokens` | `cacheWriteTokens` | 原名保留，缺失则**不出现** |

**为什么不做减法**：Anthropic 的 `input_tokens` 已经是**不含 cached** 的裸输入，
`cache_read_input_tokens` / `cache_creation_input_tokens` 是分开的两个计数器。
这本来就是 DSH 的 disjoint 布局。做减法会双扣。

**权威依据**（`packages/experimental/claude-code-mods/src/index.ts:148-151`）：
```ts
usage.inputTokens += data.usage.inputTokens          // 直接加
usage.cacheReadTokens += data.usage.cacheReadTokens   // 直接加
usage.cacheWriteTokens += data.usage.cacheWriteTokens // 直接加
```
官方 adapter 也是零算术。

**我差点做错**：原计划按"对齐 disjoint"做 `inputTokens = input_tokens - cache_read - cache_creation`。
查官方源码后确认会双扣。测试把这个事实钉死（`tests/parse.test.js` 断言 1200 保持 1200）。

## 3. "缺失即缺失"

- CLI 没报缓存计数器 → 字段**不出现**，不填 0
  （否则"从不缓存的厂商"看起来像"报了零命中"）
- 整个 run 没有 usage → 返回对象里**没有 `usage` 字段**，不写 `usage: undefined`
- 三个测试分别覆盖：完整 usage、无 cache 计数器、完全无 usage

## 4. 园桌前缀可验证性

`src/roundtable.js` 每轮新增：

```js
{
  round: n,
  entries: [...],              // 每个成功成员带 promptSent + usage?
  basePromptChars: N,          // 原问题的字符数
  prefixes: [{ provider, strictPrefix, sharedPrefixChars }],
  strictPrefix: boolean,       // 本轮所有成员是否都严格前缀
}
```

**从实际发出的 prompt 算出**，不是从 builder 源码断言。三轮回读测试验证第 2 轮 prompt
确实以原问题开头、且 `sharedPrefixChars` 等于问题长度。

## 5. 仍未做

| 项 | 为什么没做 |
|---|---|
| 官方 `deferLoading` 对应机制 | 官方用它让工具声明跟在历史后面不重写；我们的圆桌是纯文本拼接，没有等价物。判定为**不对等但可接受**：外部 CLI 的工具声明由 CLI 自己管，我们无权干预 |
| 圆桌成员换成官方 `subagent_fork` | 会天然继承父前缀、缓存必然命中，但违背"外部 agent 编排器"定位（fork 是 in-process 子代理）。列为**不该做** |
| 真实 usage 端到端验证 | 无 API key，claude/codex 无法真实调用。当前验证是单元级（构造 payload） |
