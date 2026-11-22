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

## 6. C1 子代理推翻了一个我落地时没看见的真实缺陷（已修，`d5b1372`）

C1 报告给出三条我没预料到的结论，其中第一条是**真缺陷**：

**我量错了基准。** `sharedPrefixChars` 比的是「本轮 prompt vs 原始问题」，
但缓存复用发生在「本轮 vs **上一轮**」。基准错了，就看不见布局 bug。

**布局 bug**：`buildDebatePrompt` 把轮次标记 `【第2轮辩论】` 放在同伴块**之前**，
于是轮 2 和轮 3 在轮次标记处（约第 1,049 字符）就分叉，**整个同伴块每轮重付**。
生产尺寸复现（1040 字符问题 + 2400 字符回答）：复用率 **20.6%**。
把轮号挪到同伴块之后：同伴回答不变时 **99.7%**；回答真变了则受限于变化量本身。

**这是本轮唯一真实的缓存收益**，比 usage 计量更值钱——计量只是"看见"，布局才是"真的省"。

**第二个缺陷**：失败的成员没有 `promptSent`，轮级 `strictPrefix` 算出
`''.startsWith(base) === false`，任何一个成员掉线就把整轮标成 false。已改为"没收到
prompt 的成员不参与表决"。

**第三个结论（重要）**："我们的手工实现 = 官方 in-history"——**方向对，机制不对**。
官方那两个是 `LlmResolvedModelInfo` 上的 adapter 声明，由 `projectToolUpdates()`
在 loop 内执行，插件无法声明也无法开关。诚实措辞是"文本层近似 in-history"。

**第四个结论**：`deferLoading` 是**对等不是缺失**——我们的 prompt 里根本没有工具声明块，
不存在"工具块被重写"的风险面。

**第五个结论（关于 fork）**：可行但**不该做**。fork 的缓存收益来自共享父前缀，而圆桌的
全部价值是异质独立视角；且 fork 是 in-harness，会把插件退化成官方 subagent 的更差包装。
已核实 codex/claude-code/acp 三家 `inheritsParentContext` **全是 false**，
只有 `fork-in-process` 是 true，所以"成员走官方 backend 就能蹭父缓存"不成立。

**usage 只接通 1/3**：codex 只吐聚合 `tokens used: 1200`，无法映射（拆分=伪造、
`totalTokens`=违反必填、不报=正确）。默认 4 成员里 3/4 无法证明省了缓存。
诚实的做法是**如实标注哪家能报**，而不是让计量看起来普遍可用。
