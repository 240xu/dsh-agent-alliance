# 第三轮：对抗审计 + 官方对齐 — 总裁段与工程规划

> 日期：2026-11-08
> 基线：`e15fcf8`（0.2.0）→ 本轮末 `0ca8809`
> 本轮派工：2 名对抗型审计（L1 遗留代码 / L2 修复提交）+ 1 名官方行为对齐专家（O1）
> 我（Lead）角色：总裁段结论 + 总工程师实施 + 后续规划

---

## 一、总裁段结论（Executive Summary）

### 结论 1：这一轮的价值来自"对抗"

本轮派出的三条线里，**最有价值的发现全部来自"试图反驳"而非"试图确认"**：

| 专家 | 找到的关键事实 | 我此前的判断 |
|---|---|---|
| L1 | Termux-first 路径探测在 16 个提交里**从未改过**；且 `deps.paths` 覆盖入口在生产路径根本没被传入，只有测试能用 | 我在审计汇总里把它写成"已登记技术债"，误导性地暗示已处理 |
| L1 | `session/title` 修复的**副作用**：无用户文本时返回值谎报一个从未写入的 title | 上一轮我只修了事件流，没检查 `importOne` 的返回/台账 |
| L2 | `detectAll` 超时后**遗弃**底层 `detect()`，孤儿子进程最多活 20 秒 | 我只修了"超时后 hang"，没修"孤儿进程" |
| O1 | `isConcurrencySafe` 未声明 → 所有工具默认 `exclusive`，单条消息里的多次派发被强制串行，我们自己的信号量在单步内**永远用不上** | 完全没意识到调度层的这个机制 |
| O1 | 官方 checkout（alpha.2）与运行时（rc.2）的 seam 定义**不同**（`toolFilter`/`persona` vs `agentPreset`） | 前几轮混用了两个来源 |

**这是第三次证明同一件事**：单向审计会系统性地漏掉「我刚写进去的东西」。本轮 4 个真缺陷里，3 个是我自己的修复引入或遗留的。

### 结论 2：官方对齐的正确边界已经查清

O1 用源码逐行给出了决定性判断：

- **不要**把四家 CLI 注册成 `SubagentProvider`：官方 `codex` 包的默认 `providerName` 就是 `codex`，`registerProvider` 会抛 `DUPLICATE_PROVIDER`，**用户一启用官方 Codex 包，我们插件就崩**。
- **可以**（但需产品决策）注册**一个命名空间 provider**（如 `alliance`）：因为 `delivery` 由 consumer 决定而非 provider，`delivery:'caller'` 的阻塞语义能原样保留；`subagent/start`+`end` 事件与 `maxActiveSubagents` 池化会无条件生效，catalog 行只在 `delivery==='parent'` 时出现。
- **不要**导出 Schemastery `Config`：会丢掉零依赖属性，且仍然校验不了 legacy JSON 文件。
- **不要**改成 `delivery:'parent'`：会为已经内联返回的结果再注入一条重复完成通知。

⇒ **刚定下的"外部 agent 扩展"定位，在官方机制上是站得住的**：它不要求我们伪装成官方 provider，也不与官方工具抢名字。

### 结论 3：产品状态仍有一个硬缺口

代码质量已达标（216 测试全绿），但**功能在这台机器上没有可用目标**：

```
claude / codex / opencode / zcode     → 全部 MISSING
dsh-subagent-codex / -claude-code     → 全部 MISSING
插件未装进 ~/.dsh/profiles/web        → 当前运行的 GUI 没有加载它
21 个提交全在本地，未推送
```

定位收窄为"外部 agent 编排器"后，本机可用派发目标数为 **0**。这需要产品决策，不是代码问题。

---

## 二、总工程师实施记录（本轮 5 个提交）

| 提交 | 内容 | 验证 |
|---|---|---|
| `d2c9b70` | 对齐官方 `SENSITIVE_ENV_PATTERN`（去掉我多加的 `PASSWD\|CREDENTIAL\|SESSION`，`SESSION_NAME` 不再被误删）；去掉 `detectAll` 的 `unref()` 修复挂起 | 独立实测，2 个测试 |
| `90ef1bc` | `config.providers.<id>.paths` 真正生效（生产 wiring 打通 `deps.paths`），并加 config 校验 | 实测 `detect` 报 `/usr/bin/grun` 而非 Termux 路径 |
| `e7da40f` | 超时探测 abort 底层 `detect()`，`spawnCli` 杀掉孤儿子进程 | 真实子进程实测：153ms 返回且 `aborted=true` |
| `85dd0cd` | 4 个工具声明 `isConcurrencySafe`；拒绝未知 config 键；删除死代码 `src/index.js` | 2 个回归测试 |
| `0ca8809` | `importOne` 只报告实际写入的 title | 端到端验证返回值/台账/日志三者一致 |
| `ebf077a` | `readSession` 区分 ENOENT 与 EACCES | chmod 000 实证：不可读报 EACCES，缺失 id 仍报 not-found |

**测试：216 pass / 0 fail**（本轮从 207 增至 216，新增 9 个回归测试）。

### 我对专家结论的独立复核

我没有直接采信任何一条：
- `normalizeEnv` 误伤、`detectAll` 挂起 —— 我在专家报告落盘前就自己跑脚本发现并修复
- `isConcurrencySafe`、`config` 拼写静默、`src/index.js` 死代码 —— 逐条用官方源码和真实 `loadConfig` 复核后才改
- O1 的 `DUPLICATE_PROVIDER` 结论 —— 因为它是"不要做"的建议，我按证据采纳为 backlog 条目，没有改代码

---

## 三、审计产出

| 文件 | 内容 |
|---|---|
| [L1-legacy.md](L1-legacy.md) | 0.1.0 遗留残留对抗审计（Termux 路径、v4 合规、旧 API、静默 catch） |
| [L2-fixes.md](L2-fixes.md) | 16 个修复提交的回归审计（7 个 cluster） |
| [O1-alignment.md](O1-alignment.md) | 官方行为对齐深挖（6 节 + backlog） |

**L1 结项状态（4/4 已处置）**：

| L1 项 | 判决 | 处置 |
|---|---|---|
| L1-1 Termux 路径 + arm64 硬编码 | PARTIALLY | `90ef1bc` 打通 `config.providers.<id>.paths`；Termux 默认值与 arm64 包名保留为显式文档化的可配置项（改动默认路径属行为变更，留 backlog） |
| L1-2 importOne 谎报 title | PARTIALLY → FIXED | `0ca8809` |
| L1-3 0.1.0 API 残留 / 死入口 | FIXED | `85dd0cd` 删除 `src/index.js`；API 层 0 命中 |
| L1-4 权限错误误报"不存在" | SURVIVES → FIXED | `ebf077a`（本轮最后一条），chmod 000 实证 |

L1 总结论：**重写替换了契约，但没有替换"出生环境"** —— Termux/ARM64 假设从 0.1.0 原封不动活到 0.2.0，并一度被误记为"已登记技术债"。这是本轮最值得记住的一条。

**未完成**：L2 的 C4–C7 与 verdict table 在成员最后一段工作中被网络中断，C1–C3 已有实质结论。C2/C3 涉及的缺陷我已独立修完；C1（withDb）、C4（startJob 字符串匹配）、C5（single-flight）、C6（jobHooks 竞态）、C7（辩论头位置）**尚未被完整复核**，见下节规划。

---

## 四、后续执行规划（按优先级，含工作量与阻塞项）

### P0 — 需要你的产品决策（阻塞其他工作）

| # | 决策 | 选项 | 影响 |
|---|---|---|---|
| D1 | **是否装进当前运行的 web profile** | 装 / 不装 | 装会重启 GUI（`dsh web` 实例），我会在动手前再确认一次 |
| D2 | **至少一个外部 agent** | 安装 CLI / 启用官方 vendor 包 / 都不做 | 不做则插件功能为空壳；启用官方包后才有真实派发目标 |
| D3 | **圆桌范围** | A 严格只对外部 CLI（当前） / B 允许扇出到官方 `subagent*` | B 会让圆桌在无 CLI 时仍可用，但变成"官方工具封装"，与定位有张力 |
| D4 | **命名空间 `alliance` provider** | 现在做 / 进 backlog | O1 证据充分但属架构变更，会引入 catalog/池化语义，需你拍板 |

### P1 — L2 未完成的复核（S，无阻塞）

补齐 C1/C4/C5/C6/C7 五个 cluster 的对抗复核。这几条都针对已上线的修复，且历史上"对抗复核"命中率约 70%，值得做完。我可以在下一轮用同一批成员续跑，或自己补。

### P2 — 工程收尾（S）

| 项 | 说明 |
|---|---|
| 推送 21 个提交 | 需要 `240xu/dsh-agent-alliance` 的授权/凭据，我没有 |
| CLI 原始 stderr 泄露 | O1 提到：我们把未脱敏的 400 字节 stderr 回给模型，而官方 seam 要求 diagnostic 不含凭据/原始协议。M 工作量 |
| 官方 checkout 版本偏差 | O1 发现 alpha.2 与 rc.2 seam 不同；后续所有引用必须以**已安装 rc.2** 为准，SPEC 需注明 |

### P3 — 明确不做（有证据）

- 四家 CLI 注册成独立 `SubagentProvider`（`DUPLICATE_PROVIDER` 会让官方 Codex 包启用时崩）
- 导出 Schemastery `Config`（丢零依赖 + 校验不了 legacy JSON）
- 改 `delivery:'parent'`（重复完成通知）
- 把 `enabled:false` 过滤放进 `providerIds()`（会误杀官方派发路径，A3 已警告）

---

## 五、风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| 本机无任何外部 agent，定位收窄后功能空转 | 高 | P0-D2 决策 |
| 插件未装进 profile，所有"真实运行时验证"都是临时 Context | 高 | P0-D1；装前需重启 GUI |
| 21 提交未推送，本地磁盘是唯一副本 | 中 | P2 |
| `startJob` 用字符串 `'no job controller serves'` 匹配异常，下个 rc 改文案即失效 | 中 | P1-C4 复核，建议改判 `code`/结构化错误 |
| runtime 与 checkout seam 版本不一致导致后续误判 | 中 | 文档注明以 installed 为准 |
