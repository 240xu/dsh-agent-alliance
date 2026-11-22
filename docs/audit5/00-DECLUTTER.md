# 第六轮：去冗余 + 官方对齐 — 执行记录

> 日期：2026-11-22
> 基线：`f5a8318`（231 tests）→ 本轮末 `a856f40`（**239 tests**）
> 子代理：8 个派出，5 个中途失败（网络超时）。剩余工作由 Lead 自己完成。
> 运行时：`/opt/dsh-0222` = **0.2.2-rc.5**（npm 最新，无更新）

## 一、总裁段

### 结论 1：基线里确实有垃圾，而且不止一处

用户说「上一下文肯定生成了大量的垃圾代码和冗余条件」——**成立**，但性质比"垃圾"更微妙：

| 发现 | 性质 |
|---|---|
| `tests/.conc.test.js` 275 行 | 以 `.` 开头 → 永远不被 glob 匹配 → **从未运行**。单独跑它 6 个 ✖ 失败。它不是测试，是让套件"看起来更大"的残留 |
| `serviceOf` **5 份副本** | 语义几乎相同，但每份在 null 处理上略有差异——子代理卡在这个问题上；我逐字核对后确认差异**不是有意的** |
| `termuxPrefix()` **4 份**、`withDb()` **2 份**、`detect()` **3 份** | 纯重复 |
| `ERROR_CODES` 8 个字面量散落 25 处 | 对外契约却是**没有一个测试守着**它不漂移 |
| `withArgValidation` 的 `array` 分支 | **完全无效**：`Array.isArray(type)` 比对 `typeof value`，而 `typeof [] === 'object'`，所以它什么都没拒绝。`providers: 'p1'` 能直达工具体 |

**最值得记住的一条**：`withArgValidation` 里那段"防御性"代码不是冗余，是**假的安全**——它看起来在处理 `array` 类型，实际这道门是开着的。删冗余之前必须先分清"多余"和"假防护"。

### 结论 2：官方契约在 rc.5 上漂移了一处，而且是我们注释写反的那处

`dsh-jobs-local` 在 rc.5 把后台任务失败升级为 **`JobError` + 稳定 `JobErrorCode`**（`dsh-jobs/lib/types/error.d.ts`）：

```
JOB_CONTROLLER_UNAVAILABLE / JOB_NOT_FOUND / JOB_FOREIGN_SESSION
JOB_OWNER_NOT_LIVE / JOB_OWNER_REGISTRY_UNAVAILABLE / JOB_LIMIT_REACHED
JOB_BACKGROUND_DISABLED
```

而我们的注释还写着「throws bare `Error`s with no code to match on」——**这句话在 rc.5 已经是假的**。后果不是文档问题：我们给所有拒绝统一回一句"启用 dsh-tool-jobs"，当真实原因是**任务桶满了**时，这句话把调用者指向了错误的修复方向。

已改为按 code 分流，每种 code 给各自的下一步。

### 结论 3：圆桌的缓存主张现在可以被验证了

之前 `dispatch` 的返回值里**没有 usage**，圆桌说"省了缓存"永远无法被证伪。现在：

- `parseClaudeStreamJson` 不再丢弃 `result` 行的 usage
- 映射到 DSH 官方 `TokenUsage` 字段名
- 圆桌每轮报 `strictPrefix` / `sharedPrefixChars` / `basePromptChars`

**关键判断（我差点做错）**：我原计划按官方 disjoint 语义做减法
`inputTokens = input_tokens - cache_read - cache_creation`。查官方源码后确认**不需要**：

```
packages/experimental/claude-code-mods/src/index.ts:148-151
usage.inputTokens += data.usage.inputTokens          ← 直接加，零算术
```

Anthropic 本来就分开报三个计数器，**这已经是 DSH 的 disjoint 约定**。减法会双扣。官方文档里那句减法说明只适用于 DeepSeek 的 `prompt_tokens` 那种"缓存折进总数"的厂商。测试把这个事实钉住了。

### 结论 4：子代理 5/8 失败，但工作没停

失败原因都是网络超时（用户判断正确，「超时只不过是网络问题」）。它们失败时都没有留下半成品改动——工作树干净，测试仍是绿的。**这说明任务边界切得对**：每个子代理的写入范围是隔离的，失败不污染主干。

## 二、实施记录（8 个提交）

| 提交 | 内容 | 净效果 |
|---|---|---|
| `39638e9` | `serviceOf` 5→1，新建 `src/host.js` + 守卫测试 | −97 行 |
| `a555d57` | usage 映射 + 圆桌前缀可验证性 | +6 测试 |
| `68e7dfd` | 按 `JobError.code` 分流，每 code 独立补救 | +2 测试 |
| `0625a4b` | 删 4 个死文件、archive 0.1.0 文档 | −275 行死测试 |
| `76820aa` | `ERROR_CODES` 冻结表 + 守卫测试 | +1 测试 |
| `6d8bbea` | `termuxPrefix` + `withReadOnlyDb` 收敛 | — |
| `bc6b65e` | `probeVersion` 收敛三个 `detect()` | — |
| `a856f40` | 修复 `array` 类型校验的假防护 | +1 测试 |

**测试 231 → 239**，工作树干净，已推送 `f5a8318..a856f40`。

## 三、验证

- 全量 `node --test 'tests/*.test.js'` → **239 pass / 0 fail**
- 真实 Cordis 挂载（0.2.2-rc.5 + ToolRuntime + subprocess + jobs-local）：6 工具注册、1 路由，销毁归零
- fd 泄漏实证：`listSessions` 连跑 40 次，descriptor 增长 **0**（收敛 `withDb` 后仍成立）
- `grep -rn "function serviceOf" src/ index.js` → 恰好 1 处
- 远端 `main` = `a856f40` = 本地 HEAD

## 四、诚实记录：我在这轮犯的三个错

1. **brace-walker 匹配到 JSDoc 的花括号**，把三个 provider 的函数截断了。用 `git checkout` 回退重做。
2. **替换时静默丢掉了 `probeVersion` 的 import**，三个文件都坏。是 factory 测试报 `probeVersion is not defined` 抓到的，不是我自己发现。
3. **`ERROR_CODES` 集中化时把对象自己的字面量也替换成了自引用**，`ReferenceError: Cannot access before initialization`。http 测试立刻失败。

三次都是测试抓住的。**这轮最该记的不是"删了多少行"，而是"每次改动都有东西能立刻说我不对"**。

## 五、仍未做（明确记录）

| 项 | 原因 |
|---|---|
| C1 圆桌 ↔ 官方缓存机制的完整对照报告 | 子代理 audit-orchestration 失败。**结论已通过 `a555d57` 落地成代码**，但没有那份逐条比对文档 |
| C2 rc.5 契约漂移的完整表格 | 子代理 audit-framework 失败。我手工核了 6 项（`resolveConfig` 语义、`tools.register` 行为、`SENSITIVE_ENV_PATTERN`、`jobs.start` 文案已漂移、`SubagentResult` 无 usage 字段、官方仍无 opencode/zcode provider），**未核** `SubagentStartRequest` 字段增删、`WebRoute` prefix、`collected.readFrom` 返回结构、`NO_START_CAPABILITIES` |
| opencode 走 ACP 的可行性 | npm 装 `opencode-ai@1.19.6` 超时（`exit=124`），无法实测其是否支持 ACP。`dsh-subagent-acp` 的配置要求已查到（`providerName`/`command`/`args`，`capabilities` 为空） |
| `tools.js` 剩余可精简处 | 只修了 `array` 假防护；`lossless`/`labelOf`/`resolveCwd` 等 helper 的调用覆盖未逐条核 |
| Client 面板 DOM 渲染 | 一直是视觉验证盲区，需刷新 GUI 确认 |

## 六、下一步建议

1. **补完 C2 的四个未核契约项**（`SubagentStartRequest` 字段、`WebRoute` prefix、`collected.readFrom`、`NO_START_CAPABILITIES`）——这是唯一可能藏着"行为会出错"的漂移的地方
2. **opencode ACP 实测**：装 CLI 后跑 `opencode --help` 看有无 `acp` 子命令。有则走官方 `dsh-subagent-acp`，这是把第三方 agent 正式对齐进官方的唯一路径
3. 子代理重派时**把写入范围切得更细**（这轮证明隔离有效，但任务描述里的验收标准可以更硬）
4. `tools.js` 的其余 helper 逐条核调用覆盖
