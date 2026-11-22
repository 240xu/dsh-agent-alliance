# C1 — 圆桌与官方缓存机制对齐

> 只读审计。除本文件外未改动任何文件，未 commit。
> 基线：`dsh-agent-alliance` @ `842b09c`，含本轮已落地的 `a555d57`。
> 官方契约：runtime `0.2.2-rc.5`（`/opt/dsh-0222`）；官方 adapter 源码需读源码树
> `/home/ova/dsh/packages/experimental/claude-code-mods`（rc.5 运行时**不安装**该包）。

## 结论摘要

1. **"我们的严格前缀拼接 = 官方 in-history 的手工实现"这个判断，方向对、强度不对。**
   对的部分：两者都是"把变更推到已处理区域的尾部，不重写开头"。错的部分：官方
   in-history 是 **adapter 声明的模型能力 + loop 侧投影**，由
   `projectToolUpdates()` 在每个请求上执行；我们的实现是**我们自己拼字符串**，没有
   任何一方声明它、也没有任何东西能验证 provider 真的复用了。它是 in-history 的**文本层
   仿形**，不是同一个机制。
2. **本轮落地的 5 项改动，逐条核实为真**（见 §3），其中 usage 映射"重命名而非减法"的
   判断经源码核实**正确**，避免了双扣。
3. **但新加的 prefix 度量量错了对象，并且掩盖了一个真实的缓存缺口。**
   `sharedPrefixChars` 比的是"本轮 prompt vs 原始问题"，而缓存复用发生在"本轮 prompt vs
   **上一轮** prompt"之间。实测：轮 2→轮 3 只共享 **20.5%**（生产尺寸下），因为轮次号
   `【第N轮辩论】` 排在同伴发言**之前**，轮 2/轮 3 在索引 1049 处分叉，整个同伴块每轮重付。
   把轮次标记挪到同伴块之后，同一指标从 20.5% → **97.9%**。
4. **usage 只有 claude 一家接通**；codex 只吐一个聚合 `tokens used:`，**无法**诚实填充
   DISJOINT 字段；opencode 的 JSON 事件里没有 token 字段。所以"圆桌能证明省钱"目前仍只对
   1/3 的 CLI 成立。
5. **圆桌成员走官方 backend 时看到的是全新上下文，不是父前缀**：`subagent-codex` /
   `subagent-claude-code` / `subagent-acp` 三家 `inheritsParentContext` 全是 `false`
   （仅 `fork-in-process` 为 `true`）。所以"圆桌成员走官方 backend 就能蹭缓存"不成立。
6. **把成员换成 `subagent_fork` 技术上可行但不该做**：它会把"外部 agent 编排器"变成
   "自身会话的复制器"，且 fork 的缓存收益来自**父会话前缀**，与圆桌要的"独立异质视角"
   直接冲突。详见 §5。

---

## 1. 官方缓存契约摘要

每条都核到运行时 `0.2.2-rc.5` 的实际文件。

### 1.1 计量是 DISJOINT 的计费事实（不是内部优化细节）

`/opt/dsh-0222/node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts:160-174`：

```ts
/**
 * Token accounting for one model call (cache fields are optional).
 *
 * Counts are DISJOINT: `inputTokens` is uncached input only; cached input is
 * reported separately as `cacheReadTokens`/`cacheWriteTokens` (billed input =
 * sum of the three). Adapters whose providers fold cache hits into a total
 * prompt count (DeepSeek's `prompt_tokens`) subtract them out.
 */
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}
```

三个要点，直接决定我们的映射能不能照抄：

- `inputTokens` **只是未缓存部分**，不含缓存读写。
- `cacheReadTokens` / `cacheWriteTokens` **可选**；"没报"和"报了 0"是两件事。
- **减法只对"把缓存折进 prompt 总数"的 provider 生效**（DeepSeek 的 `prompt_tokens`）。
  Anthropic 不在这个集合里 —— 见 §3.2。

### 1.2 请求头状态影响缓存复用，且 loop 会记录快照

`dsh-llm/lib/types/call-config.d.ts:1-6`：

```
 * Conversation call configuration and freeze utilities. Provider routing,
 * model, reasoning effort, and sampling values are request-header state that
 * can affect cache reuse; request waterfalls replace them and the loop logs
 * changed snapshots instead of allowing silent per-call drift.
```

对圆桌的直接含义：**同一成员跨轮必须保持 route/model/effort 不变**，否则缓存即便前缀
相同也不复用。我们的 `runRoundtable` 对 `model` 是固定透传（`src/roundtable.js:52`），这点
合格；但**没有记录快照**——见 §2 的 gap 3。

### 1.3 in-history：把变更推到已处理区域之后

`dsh-llm/lib/types/types.d.ts:400-406`：

```ts
/**
 * How a model applies a system prompt that changes mid-conversation.
 * `'in-history'`: the model reads the latest `system` message at any position
 * of `messages` as the complete effective system prompt, so a changed prompt
 * can follow the cached history instead of rewriting message 0.
 */
export type SystemPromptUpdate = 'in-history';
```

`dsh-llm/lib/types/types.d.ts:407-416`：

```ts
/**
 * How a model accepts native tool declarations that change mid-conversation.
 * `'addition-only'`: the model reads a `tool-addition` block in a later
 * developer message as activating a tool declared with `deferLoading`, so an
 * added tool follows the cached history instead of rewriting the declaration
 * list. `'in-history'`: the model additionally reads `tool-removal` blocks,
 * so a removed tool keeps its declaration and the removal follows the history.
 * Absent means every request declares the complete current tool list.
 */
export type ToolUpdate = 'in-history' | 'addition-only';
```

**关键限定**：这两个是 `LlmResolvedModelInfo` 上的 **provider/adapter 声明**
（`types.d.ts:424-428`），由 adapter 实现，我们作为插件**无法**声明、无法开关、无法伪造。
运行时里实际声明它们的是 DeepSeek adapter（`dsh-llm-deepseek/lib/index.js:74-75`），
消费点是 `projectToolUpdates()`
（`dsh-llm/lib/index.js:855` 定义，`:2449` 在每次请求上调用）。

### 1.4 `inheritsParentContext` 是 provider 声明能力

`dsh-subagent/lib/types/types.d.ts:307-312`：

```ts
    /**
     * Whether the child sees the parent's completed-turn prefix. This is descriptive, not a
     * service-validated start capability: the model-facing tool derives truthful wording from it.
     * It says nothing about tool registration, injected services, or authority inheritance.
     */
    readonly inheritsParentContext: boolean;
```

**注意 "descriptive, not a service-validated start capability"**：它是给工具生成文案用的，
不是能请求的能力。运行时实测取值：

| provider | `inheritsParentContext` | 来源 |
|---|---|---|
| `subagent-fork-in-process` | **`true`** | `dsh-subagent-fork-in-process/lib/index.js:41` |
| `subagent-spawn-in-process` | `false` | `dsh-subagent-spawn-in-process/lib/index.js:27` |
| `subagent-codex` | `false` | `packages/subagent/subagent-codex/src/index.ts:65` |
| `subagent-claude-code` | `false` | `packages/subagent/subagent-claude-code/src/index.ts:75` |
| `subagent-acp` | `false` | `packages/subagent/subagent-acp/src/index.ts:89` |

fork 的种子逻辑（`dsh-subagent-fork-in-process/lib/index.js:22-27`）取父会话日志到最后一个
`turn/end` 为止，**从 seq 0 连续**，这正是前缀缓存能命中的形态。

### 1.5 `SubagentResult` 不带 usage

`dsh-subagent/lib/types/types.d.ts` 全文里 `usage` 只出现在第 246 行的注释
（"Empty-content messages, including usage-only messages"），**结构体本身没有 usage 字段**。
所以 §C 里"官方 backend 的 `SubagentResult` 是否带 usage"的答案是**不带**，我们无法从官方
backend 拿到计量。这条 C2 文档也已独立核实过（`docs/audit5/C2-official-delta-manual.md`）。

---

## 2. 逐条对照表

| # | 官方做法 | 我们的做法 | 差距性质 |
|---|---|---|---|
| 1 | **前缀保持**：in-history 让变更跟在缓存历史后（`types.d.ts:400-416`） | `buildDebatePrompt` 第 2 轮起以原问题为严格前缀追加（`src/roundtable.js:26-36`） | **形似、非同机制**。方向对，但见 #5、#6：轮 3 起前缀复用率崩塌 |
| 2 | **声明式**：能力由 adapter 在 `LlmResolvedModelInfo` 上声明，loop 执行 | 我们自己拼文本，没有声明、没有执行方 | **缺失**。绕过声明意味着没有任何组件能保证 provider 真的复用；我们只能靠字节比较**推断** |
| 3 | **header 快照**：route/model/effort 变动被记录，"no silent per-call drift"（`call-config.d.ts:2-5`） | 每轮重建 prompt，**不记录** route/model 快照，也不记录"本轮 vs 上轮"的公共前缀 | **缺失**。新加的度量记的是 vs 原始问题，不是 vs 上一轮（见 §4.1） |
| 4 | **`deferLoading` + 工具块**：新增工具跟在历史后，不重写声明列表（`types.d.ts:407-416`） | 圆桌 prompt 是纯文本，成员每轮由 CLI 重新装载自己的完整工具集 | **对等，不是缺失**。理由见 §4.2 |
| 5 | **计量**：cacheRead/cacheWrite 单列，billed = 三项之和（`types.d.ts:160-174`） | `a555d57` 起：claude 路径接通 `usage`；codex/opencode **无** | **部分落地**。1/3 的 CLI 可信，见 §3、§4.3 |
| 6 | **`inheritsParentContext` 决定子代理是否看父前缀**（`types.d.ts:307-312`） | 圆桌成员走官方 backend 时，codex/claude-code/acp 全为 `false` → 看到**全新上下文** | **不是差距，是事实约束**。见 §4.4 |
| 7 | 并发：官方由 service 拥有生命周期与限额（`SPEC-v2.md:117-118`） | `a555d57` 前圆桌绕开 `maxConcurrent`；现已接入 `gatedRegistry`（`src/tools.js:515-524`） | **已补齐**（本轮之前修） |

### 2.1 "我们的手工实现 = 官方 in-history"这个判断成立吗？

**结论：作为设计意图成立，作为机制对等不成立。**

成立的证据：`src/roundtable.js:5-11` 的注释把理由写得很准确——"Opening with the round
header would diverge from round 1 at the first byte and forfeit that reuse"。这与官方
`SystemPromptUpdate = 'in-history'` 的动机（"instead of rewriting message 0"）是同一个直觉。

不成立的三点：

1. **执行方不同**。官方由 `projectToolUpdates()` 在 loop 内对每个请求做投影
   （`dsh-llm/lib/index.js:2449`）；我们是插件自己拼字符串，然后把字符串交给一个我们无法
   观测的 CLI。**我们无法知道 CLI 是否真的按前缀命中**，只能假设。
2. **声明方不同**。官方能力是 adapter 在模型元数据上声明并由 loop 尊重；我们没有任何
   声明途径，也没有"provider 不支持 in-history 就降级"的分支。
3. **粒度不同**。官方 in-history 处理的是 **system prompt 与工具声明**这两个结构化输入；
   我们处理的是**整个扁平 prompt 字符串**。这两者在内核看来没有可比性。

诚实的措辞应该是：**"圆桌用文本层的前缀保持来近似 in-history 的效果"**，而不是
"实现了 in-history"。

---

## 3. 已落地部分逐条核实（`a555d57`）

我用 stub provider 实跑了代码，不是只读注释。

### 3.1 `src/parse.js` 新增 `usageFromAnthropic()`

`src/parse.js:32-48`。核实结果（`/tmp/c1/verify.mjs`）：

```
full:            {"inputTokens":10,"outputTokens":20,"cacheReadTokens":300,"cacheWriteTokens":40}
no cache fields: {"inputTokens":10,"outputTokens":20}
  -> cacheReadTokens present? false          ← 可选字段保持缺失，未填 0（正确）
garbage:         undefined                   ← 全非法时整体缺席
null:            undefined
```

行为与 `TokenUsage` 的可选语义一致：**"未报告" 不会被伪装成 "0"**。

### 3.2 "映射是重命名，不是减法"——核实为**正确**

这是本轮最关键的技术判断，我独立核了官方 adapter 源码
`/home/ova/dsh/packages/experimental/claude-code-mods/src/index.ts:146-152`：

```ts
  const usage = turnRecord.usage ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model }
  usage.input_tokens += data.usage.inputTokens
  usage.output_tokens += data.usage.outputTokens
  usage.cache_read_input_tokens += data.usage.cacheReadTokens ?? 0
  usage.cache_creation_input_tokens += data.usage.cacheWriteTokens ?? 0
```

**纯加法，零算术**。Anthropic 的 `input_tokens` 本来就不含缓存部分，与 DSH 的 DISJOINT
约定同构。如果按 `dsh-llm` 注释里那句 "Adapters whose providers fold cache hits into a
total prompt count ... subtract them out" 去做减法，就会**双扣**（把本来就没含进去的
减掉）。这个判断正确，值得保留在代码注释里（`src/parse.js:20-27` 已写入）。

### 3.3 `parseClaudeStreamJson` 从 `result` 行提取 usage

`src/parse.js:64-65`、`:75`。空值时不出现 `usage` 键（不是 `usage: undefined`）。核实：

```
{"text":"final answer","sessionId":"s1","usage":{"inputTokens":7,"outputTokens":9,"cacheReadTokens":1234,"cacheWriteTokens":56}}
```

### 3.4 `src/provider/claude.js` 透传

`src/provider/claude.js:58`：`...(parsed.usage === undefined ? {} : { usage: parsed.usage })`。
同文件 `:51-54` 还收紧了失败语义（非零退出即抛错），这是审计 B1-4 的修复。

### 3.5 `src/tools.js` 透传

`src/tools.js:350-352`：`...(result?.usage === undefined ? {} : { usage: result.usage })`，
注释写明 "Absence means 'not reported', never 'zero'"。**语义正确。**

### 3.6 `src/roundtable.js` 每轮 prefix 度量

`src/roundtable.js:60`（记录实际发出的 prompt）、`:68-86`（计算并挂载三项字段）。
实测字段形状（`/tmp/c1/verify.mjs`）：

```
round-1 entry keys: provider,ok,text,externalSessionId,durationMs,promptSent,usage
debate[0] keys:     round,entries,basePromptChars,prefixes,strictPrefix
prefixes item:      {provider, strictPrefix, sharedPrefixChars}
```

**从实际发出的字符串算出**（不是断言），这点是对的。但度量对象错了 —— §4.1。

---

## 4. 仍未做的部分，以及三个新发现的缺陷

### 4.1 【缺陷】`sharedPrefixChars` 量错了基准，掩盖了真实缓存缺口

度量的是 **"本轮 prompt vs 原始问题"**，而缓存复用发生在 **"本轮 prompt vs 上一轮
prompt"** 之间。`src/roundtable.js:71-79`：

```js
const base = String(prompt)
const shared = entries.map((entry) => {
  const strictPrefix = rn === 1 ? sent === base : sent.startsWith(base)
  ...
```

生产尺寸实测（`/tmp/c1/proof.mjs`，1040 字符问题 + 2400 字符回答 + 2000 字符同伴截断）：

```
question chars      = 1040
round1 prompt chars = 1040
round2 prompt chars = 5121
round3 prompt chars = 5121

round1->2 reuse = 1040 chars = 100.0% of round 1's prompt
round2->3 reuse = 1049 chars =  20.5% of round 2's prompt   ← 真实复用率

报出的指标却是：
  round 2: sharedPrefixChars=1040 strictPrefix=true   （vs 问题，不是 vs 轮 2 的 5121）
  round 3: sharedPrefixChars=1040 strictPrefix=true   （同上）
```

**根因**在 prompt 布局（`src/roundtable.js:26-36`）：轮次标记排在同伴发言**之前**。

```
[问题] \n\n --- \n\n 【第2轮辩论】 \n 其他 agent 的上一轮发言： \n 【b】... 【c】... \n 请...
                    ^^^^ 轮 2 和轮 3 在这里就分叉了
```

轮 2 与轮 3 在**索引 1049** 处分叉（`【第2轮辩论】` vs `【第3轮辩论】`），
于是**整个同伴块（约 70% 的 prompt）每轮重付**。

**修复**：把轮次标记挪到同伴块**之后**（或干脆不写轮号——它对模型没有信息价值）。

| 布局 | 轮 2→轮 3 可复用比例 |
|---|---|
| 当前（轮号在前） | **20.5%** |
| 轮号移到同伴块之后 | **97.9%** |

同一次测量里，仅此一项就让"每成员每多一轮"省下约 1800 token-eq 的重复输入
（2000 同伴 token 从 1.0x 变成 0.1x）。这是本轮**唯一一个真实、可量化、零风险**的缓存收益，
而且它比整个 usage 计量工作更值钱——因为计量只是"看见"，布局才是"真的省"。

### 4.2 【判断】`deferLoading` 没有对应机制：这是**对等，不是缺失**

官方 `deferLoading` 解决的是：**工具声明列表在会话中途变化，导致工具块被重写、前缀失效**。

我们的圆桌不存在这个问题，因为：
- 圆桌每轮是**一个新的 CLI 进程**，成员的工具集由它自己的 CLI 决定，不由我们传；
- 我们的 prompt 是纯文本，**不含工具声明块**，所以没有"工具块被重写"的风险面；
- `src/roundtable.js` 里 `deferLoading` 一词从未出现，也确实不需要。

**结论：不是缺失。** 真正对等的缺失是 §4.1 的布局问题 —— 那才是"我们自己造成的、本可避免的
前缀失效"。把 `deferLoading` 当成待补项是找错了方向。

### 4.3 【缺陷】usage 只有 1/3 的 CLI 接通，且 codex 的聚合数**不能**诚实映射

`src/parse.js:97-110` 的 codex 解析器只做了一件事：把 `tokens used:` 那行**删掉**
（`:107-108`）。opencode 的 JSON 事件里没有任何 token 字段（`src/provider/opencode.js`
全文件无 `usage`/`tokens`/`cost`）。

codex 真实输出形态（`tests/fixtures/codex-output.txt:13`）：

```
tokens used: 1200
```

**一个聚合数，没有 input/output 拆分，没有缓存拆分。** 实测三种映射都不成立
（`/tmp/c1/codex-usage.mjs`）：

| 映射尝试 | 结果 | 为什么不行 |
|---|---|---|
| `{inputTokens: 1200, outputTokens: 0}` | 伪造拆分 | `outputTokens: 0` 是假话，会污染任何成本核算 |
| `{inputTokens: 0, outputTokens: 0, totalTokens: 1200}` | 违反必填 | `inputTokens`/`outputTokens` 是必填的 |
| 不报 | ✅ 正确 | 符合 "absence means not reported, never zero" |

所以 codex 的**正确做法是继续不报**，不要为了"填满字段"而编造。opencode 同理。

**这对圆桌的直接后果**：只有当成员是 claude 时，"圆桌省了缓存"才可验证。默认 4 成员
（claude/codex/opencode/zcode）里 **3/4 无法证明**。这条要在文档和工具文案里说清楚，
不能笼统宣称"圆桌已支持计量"。

### 4.4 【事实约束】圆桌成员走官方 backend 时看到的是**全新上下文**

`src/backend.js` 的 `resolve()` 在 `subagentProvider` 已配置且存在 live parent 时优先
官方路径。但三家官方 vendor provider 的 `inheritsParentContext` 全是 `false`（§1.4 表）。

所以"成员走官方 backend 就能蹭父会话缓存"是**错的**。成员拿到的是
`{ prompt: [{type:'text', text}] }` 的全新一次性 activation（`src/backend.js:235-240`），
父会话的历史不进去。它自己的 prompt 内部仍然是 §4.1 那个布局，所以 §4.1 的修复对
**两条 backend 路径同样有效**——这是好消息。

顺带：`SubagentResult` 不带 usage（§1.5），所以走官方 backend 的成员连 claude 那条计量都拿不到。
**官方路径的圆桌成员计量能力 = 0。**

### 4.5 【缺陷】失败成员会把轮级 `strictPrefix` 打成 `false`

`src/roundtable.js:85`：`strictPrefix: shared.every((item) => item.strictPrefix)`。
失败成员没有 `promptSent`，`sent` 取空串（`:73`），于是 `strictPrefix=false`、`common=0`，
拉垮整轮的标志。实测（`/tmp/c1/failed-flag.mjs`）：

```
entries: good:ok bad:FAIL
round strictPrefix flag = false
per-member: [{"provider":"good","strictPrefix":true,"sharedPrefixChars":1},
             {"provider":"bad","strictPrefix":false,"sharedPrefixChars":0}]
```

健康成员**确实**拿到了严格前缀，但轮级标志是 `false`。于是这个指标无法区分
"前缀不变量被破坏"（真 bug）和"某成员失败"（正常运行）。只有正确回答成员的
`strictPrefix` 都应为 `true`，这是**缓存结论**，不能被失败掩盖。

---

## 5. 三层次建议

### 层次 1：最小改动（可直接落地）

| 项 | 内容 | 成本 | 收益 | 风险 |
|---|---|---|---|---|
| 1a | **把轮次标记挪到同伴块之后**（`src/roundtable.js:26-36`）：`[问题][同伴][\n\n请针对上述观点...]` | 极小（改一个数组字面量） | 轮 2→3 可复用率 20.5% → **97.9%**；每成员每多一轮省 ~1800 token-eq | **零**（文本语义不变，`round` 号对模型无价值） |
| 1b | **加 `reuse` 字段，量"vs 上一轮"而非"vs 问题"**：`{ vsPreviousRound: { strictPrefix, sharedPrefixChars, previousPromptChars } }` | 小 | 让缓存结论**可被验证**，且不再被 4.1 的错误基准误导 | 低（纯增量字段） |
| 1c | **`strictPrefix` 只对 `ok:true` 成员求值**：`shared.filter((_,i)=>entries[i].ok).every(...)` | 极小 | 指标不再被失败成员污染（§4.5） | 零 |
| 1d | **usage 能力如实上报**：在 `formatRoundtableText` 的表头加一行 "usage: claude ✓ / codex ✗（聚合数不可拆） / opencode ✗" | 小 | 诚实性 —— 见下 | 零 |

**1d 是这一层里最被低估的一项。** 任务描述说"圆桌主张省缓存永远无法被验证，这是**诚实性
缺口**，不是性能问题"——这个判断我完全同意，并且要补充：**只给 claude 接上 usage、却不说明
其他成员没有，反而把诚实性缺口放大成"看起来有计量"。** 必须显式写出哪家能报、哪家不能。

### 层次 2：中等改动

| 项 | 内容 | 成本 | 收益 | 风险 |
|---|---|---|---|---|
| 2a | **把 `usage` 从结构化结果透到模型可见文本**：`formatRoundtableText` 每位成员签名行追加 `· in X / cacheRead Y / cacheWrite Z`（无则写 `usage n/a`） | 中 | 模型能据此推理"这一轮值不值"，而不只是人能看到 | 低 |
| 2b | **轮级汇总计量**：在 `debate[i]` 上加 `usageTotals: { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, reportedBy: string[] }` | 中 | 让"省了多少"成为一个可 diff 的数字 | 中：跨家相加语义要谨慎——不同 provider 的 token 不可通约，**只能加"同一家跨轮"的和，不能跨家求和** |
| 2c | **记录 route 快照**（对齐 `call-config.d.ts:2-5`）：每轮记 `{ model, backend }`，变动时在结果里标注 | 中 | 防止"缓存没命中"被误判成布局问题，实为 model 漂移 | 低 |
| 2d | **codex/opencode 保持不报**，但在 `agent_sessions` 或状态里标注 "该 provider 不提供 token 明细" | 小 | 避免后人为了填字段而编造 | 零 |

**2b 的坑要写进实现**：`TokenUsage` 的 DISJOINT 只保证**单家单次**语义。把 claude 的
`inputTokens` 和 codex 的（不存在）相加无意义；把 claude 轮 1 和轮 2 相加**有意义**
（同一 provider 同一 model）。建议字段名就叫 `usageTotals`，并在 JSDoc 写死"仅当
`reportedBy` 为单元素时有汇总语义"。

### 层次 3：架构改动 —— 圆桌成员换成 `subagent_fork`？

**技术上可行，但不该做。** 逐条给依据。

**为什么"可行"**：`fork-in-process` 的 `inheritsParentContext = true`
（`dsh-subagent-fork-in-process/lib/index.js:41`），种子是父会话到最后一个 `turn/end`
的连续前缀（`:22-27`），这正是前缀缓存命中所需形态。挂上它、把圆桌成员指向它，代码上是通的。

**为什么"不该"**——三条，按重要性排序：

1. **语义直接冲突。** fork 的缓存收益来自"所有成员共享父会话前缀"。但圆桌的全部价值是
   **异质独立视角**（`src/tools.js:459-460` 自己写的定位："This compares independent
   external agents"）。让成员共享同一前缀，等于把它们变成同一个上下文的多份采样——
   那正是审计 04 §2.1 判定为"科学上不成立"的配置（cross-provider 的差异被抹平成
   same-context 的采样噪声）。**用缓存收益换掉产品价值，是负和。**
2. **定位被摧毁。** 本插件的立身之本是"派发到**本 harness 之外**的 agent"
   （README 与 `agent_dispatch` 描述："its own CLI and account, outside this harness"）。
   fork 是 **in-harness** 子代理，它连的是**我们自己的**模型和额度。把圆桌成员换成 fork，
   这个插件就退化成"官方 subagent 的一个更差的包装"——官方 `subagent`/`subagent_fork`
   已经直接可用，用户没有理由经过我们。
3. **官方自己的工具文案已经指向正确的分工。** `dsh-tool-subagent/lib/index.js:324`
   的 fork 描述是"a follow-up analysis, a review, a continuation"；而我们的
   `agent_roundtable` 描述（`src/tools.js:459-461`）已经写了
   "To delegate work to in-harness children, use the `subagent` or `subagent_fork`
   tools instead"。**分工已经写对了，不要合并。**

**如果确实想要"继承父上下文 + 缓存"的能力**，正确做法不是改造圆桌，而是**在文案里把选择
讲清楚**（已基本做到），并在需要时让用户显式用官方工具。圆桌不该假装自己能给这个东西。

---

## 6. rc.5 相对 rc.2 的契约变更

`/home/ova/dsh/.artifacts/dsh-plugins/dsh-agent-alliance` 的对齐基线是 `0.2.1-rc.2`，
运行时现在是 `0.2.2-rc.5`。本次核对范围按任务要求限定在缓存相关契约；完整漂移清单已由
C2 文档覆盖（`docs/audit5/C2-official-delta-manual.md`），不重复。

| 契约 | rc.2（我们的假设） | rc.5（实际） | 对本任务的影响 |
|---|---|---|---|
| `TokenUsage` DISJOINT 语义 | 同 | **同**（`dsh-llm/lib/types/types.d.ts:160-174`） | 无变化；`usageFromAnthropic` 的重命名策略仍然正确 |
| `SystemPromptUpdate` / `ToolUpdate` | 同 | **同**（`types.d.ts:400-416`），仍只有 DeepSeek adapter 声明（`dsh-llm-deepseek/lib/index.js:74-75`） | 无变化；我们依然无法声明 |
| `call-config` header 影响缓存 | 同 | **同**（`call-config.d.ts:1-6`） | 无变化；§2 gap 3 依旧成立 |
| `inheritsParentContext` | 同 | **同**（`dsh-subagent/lib/types/types.d.ts:307-312`）；vendor 三家仍 `false` | 无变化；§4.4 结论仍成立 |
| `SubagentResult` 带 usage？ | 不带 | **仍不带**（仅 `types.d.ts:246` 注释出现 "usage-only"） | 官方 backend 路径计量能力仍为 0 |
| `SubagentCapabilities` | 4 字段 | **同**（`types.d.ts:122-128`） | 无变化 |
| `NO_START_CAPABILITIES` | 全 false | **同**（`dsh-subagent/lib/index.js:2767-2772`） | 无变化 |

**结论：缓存相关契约在 rc.2→rc.5 之间没有任何变化。** 本轮 5 项改动不需要为 rc.5 返工。
唯一需要留意的是 C2 已记录的 `JobError.code` 漂移（与本任务无关）。

---

## 7. 能做 / 不能做 / 不该做

### 能做（有依据、可落地）

1. **把轮次标记挪到同伴块之后** —— 20.5% → 97.9% 复用率，改一个数组字面量。
2. **加 `vsPreviousRound` 度量** —— 让"复用"这个结论可被验证，而不是被断言。
3. **`strictPrefix` 只统计健康成员** —— 去掉失败成员的污染。
4. **在输出里如实标注哪家 provider 能报 usage** —— 补上诚实性缺口。
5. **把 usage 透到模型可见文本** —— 让模型而不只是人能据此决策。
6. **记录 route/model 快照** —— 对齐官方 "no silent per-call drift" 的姿态。
7. **保持 codex/opencode 的 usage 缺席** —— 这是**正确**行为，不是遗漏。

### 不能做（受官方契约或 provider 能力限制）

1. **不能声明 `SystemPromptUpdate='in-history'` / `ToolUpdate='addition-only'`。**
   那是 `LlmResolvedModelInfo` 上的 adapter 能力（`types.d.ts:424-428`），插件无途径声明。
2. **不能从官方 backend 拿 usage。** `SubagentResult` 无该字段（§1.5）。
3. **不能从 codex 的 `tokens used:` 拆出 input/output/cache。** 它只有一个聚合数（§4.3）；
   任何拆分都是伪造。
4. **不能让圆桌成员通过走官方 backend 获得父前缀。** codex/claude-code/acp 三家
   `inheritsParentContext=false`（§1.4）。
5. **不能跨 provider 求和 token。** DISJOINT 只保证单家单次语义（§5 层次 2 的 2b 注）。
6. **不能保证 provider 真的命中了缓存。** 我们只能证明"前缀结构对"，命中与否由 provider 决定；
   唯一能证明的是 provider 回传的 `cacheReadTokens` —— 而只有 claude 给。

### 不该做（能做但会亏）

1. **不该把圆桌成员换成 `subagent_fork`。** 用产品价值换缓存收益，负和（§5 层次 3）。
2. **不该为了"填满字段"给 codex/opencode 编造 usage。** 会污染所有下游成本核算。
3. **不该把 `deferLoading` 当成待补项。** 我们的 prompt 里没有工具声明块，不存在那个风险面
   （§4.2）；真问题在别处。
4. **不该在圆桌工具文案里宣称"已支持缓存计量"。** 4 家里只有 1 家可信，笼统宣称会制造
   新的诚实性缺口。
5. **不该为了省缓存把成员的回答截断得更狠。** 那会加剧审计 04 §3.3 已记录的
   "付了钱又丢掉"问题，且输出 token 本来就不缓存（占成本约 30%）。

---

## 8. 可核对的复现命令

本轮所有数字均由实跑产生，脚本在 `/tmp/c1/`：

| 脚本 | 验证内容 |
|---|---|
| `verify.mjs` | usage 映射形状、可选字段缺席、roundtable 字段结构、`promptSent` 记录 |
| `proof.mjs` | 生产尺寸下 轮1→2 = 100%、轮2→3 = 20.5%；度量基准错误 |
| `crossround.mjs` | 轮 2/轮 3 在索引 1049 处分叉（`【第2轮辩论】` vs `【第3轮辩论】`） |
| `reuse-model.mjs` | 布局改为轮号后置后 97.9%；每成员每轮省 ~1800 token-eq |
| `codex-usage.mjs` | codex 聚合数三种映射均不成立 |
| `failed-flag.mjs` | 失败成员把轮级 `strictPrefix` 打成 `false` |
