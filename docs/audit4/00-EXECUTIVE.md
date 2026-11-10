# 第四轮：以官方为绝对准则的对齐 — 总裁段与工程结论

> 日期：2026-11-10
> 基线：`6c22b47` → 本轮末 `15edd71`
> 编制：J1（jobs/controller）、J2（全机制偏离扫描）、J3（Codex/Claude Code 行为准则）三位专家子代理
> 我（Lead）角色：总裁段结论 + 总工程师实施

---

## 一、总裁段结论

### 结论 1：这一轮纠正的是**方向**，不只是代码

用户明确指出「开发绝对以官方为中心，以官方行为为准则，codex/claude code 相关功能也要朝官方化对齐」。
我先犯了一个典型错误并当场被纠正：为绕开 `jobs.start()` 的"无 controller"拒绝，我让插件自己调用
`ctx.jobs.attachController('agent-alliance')`。**这能让代码跑通，但它让第三方插件冒充官方 controller 提供者**——
方向完全错了。该改动未提交即撤销。

J1 用源码确认了这一点：`attachController` 是**能力声明**（`dsh-jobs/lib/types/index.d.ts:138-145`），
官方唯一生产调用方 `dsh-tool-jobs` 同时提供 `job_output`/`job_kill` 工具、`settled` 订阅和 system-prompt section。
我们从外部挂一个 controller，只把 `servesOwner` 翻成 true，却让「启动了没人能收集或停止的任务」通过准入
（`docs/subsystems/jobs.md:397`）。

⇒ **判据从"能不能跑"改成"官方机制由谁拥有"**。这是本轮最重要的一条，写进这里防止后续回退。

### 结论 2：三位专家各自推翻了一条我或前一轮的错误结论

| 专家 | 推翻了什么 | 证据 |
|---|---|---|
| J1 | 我未提交的自挂 controller | `dsh-tool-jobs` 是唯一生产 controller；官方 `dsh-tool-bash` 用动态 `ctx.inject(["jobs"], ...)` |
| J2 | O1 说"零依赖插件不该导出 Config" | 官方契约是 `StandardSchemaV1`，`resolveConfig` 无条件读 `~standard.validate`；8 行包装即可，零依赖 |
| J2 | O1 说 raw `ctx.tools.register` 是偏离 | 它是官方 Service Definition 方法，`structured.ts:83` 也在用；真正的问题是**缺参数校验** |
| J3 | 我自己在前几轮把"官方 provider 优先"写进文档 | 官方 `subagent`/`subagent_fork` 是每个会话自带的；本插件不该与之竞争 |

**四轮下来，对抗/官方审计连续推翻既有结论，包括我自己的**。继续保留这个编制是必要的。

### 结论 3：官方化对齐 ≠ 复制官方行为

J3 明确给出了最重要的边界判断：**有些官方行为是 category error，照抄会破坏可用能力**。

| 官方行为 | 判定 |
|---|---|
| one-shot / 不可 resume | **N/A**。官方 provider 创建 ephemeral thread，没有可续的东西；我们的 CLI 拥有持久会话存储，正是 `resumeSessionId`/`agent_sessions`/导入器存在的原因 |
| `delivery: 'parent'` | **N/A**。我们已内联返回结果，再加一条完成通知是重复输出 |
| provider 铸造的 child id | **N/A（CLI 路径）**。续聊需要产品自己的 session id |
| `disposeGraceMs` | **N/A**。它是 teardown grace，我们的 `timeoutMs` 是 run budget |
| `permissionMode` 透传 | **禁止**。官方把 mode 固定在实例上就是为了防止模型自我提权；做成 per-call 参数会反转该保证 |
| 把字段名改成与官方一致 | **禁止**。`model` 官方是实例固定、我们是 per-call；同名会造成虚假一致 |

⇒ **"以官方为准则"= 遵循官方的机制所有权、错误处理契约、诊断契约、生命周期语义；不 = 逐字段照抄**。

---

## 二、总工程师实施记录（一个提交 `15edd71`）

| 领域 | 修复 | 官方依据 |
|---|---|---|
| jobs | 撤销自挂 controller；`startJob` 不再字符串匹配错误文案，拒绝一律上抛并点名 `@deepseek-ai/dsh-tool-jobs`；`http.js` 删除把全部 5 种拒绝吞成前台的宽泛 catch | `dsh-tool-bash/lib/index.js:675,720`；`dsh-error-handling/SKILL.md:12` "Never route handling by parsing messages" |
| trust fence | `connection` 缺失从 fail-open（放行 `/dispatch`、`/roundtable` 这类烧额度的路由）改为 fail-closed 503 | `dsh-host-open-in-app/src/index.ts:84,186` 无条件 `connectionOf(ctx).requestRejection` |
| 诊断 | 新增 `src/diagnostic.js`：官方七分类 + 固定字段构造 + 4096 UTF-8 边界截断；四个 provider 不再把 raw stderr 抛给模型，原文只留在 `error.cause` 供 Host 日志 | `subagent-codex/src/run.ts:86-105`；`subagent/src/out-of-process.ts:19,30-41`；`types.d.ts:255-260` |
| Config | 导出 `StandardSchemaV1` `Config`，8 行 `~standard` 包装 `loadConfig`，恢复 fail-at-load 校验，仍零依赖 | `cordis/lib/types/registry.d.ts:53-54`；`cordis/lib/index.js:956-962` |
| 工具参数 | 六个工具统一 `withArgValidation`，`{}`/`{prompt:123}`/多余键现在 `INVALID_ARGS` | `dsh-tools/lib/index.js:850,868`（`defineTool` 包装 `execute` 做校验）；`structured.ts:83` 手动等价 |
| subprocess | 新增 `src/runner-seam.js` 走官方 `ctx.subprocess.spawn`，`buildProviders` 优先采用；raw spawn 降为服务缺失时的兜底 | `dsh-base` 无条件挂 `dsh-subprocess-local`；`SubprocessSpawnSpec` 显式 cwd/stdio/graceMs/signal |
| env scrub | `DSH_` 前缀改为大小写不敏感，与官方谓词一致 | `dsh-subprocess/src/index.ts:69` |

**实测（真实 Cordis Context，非 mock）**：
- 官方 seam 能杀掉超时后的非 detached 孙进程；raw `child.kill` 留活它 —— J2 的 money bug 得到证实并修复
- `Config` 校验行内配置通过；6 个工具注册；`agent_dispatch` 声明 `required: ["prompt"]`；销毁后工具/路由归零
- **229 测试全绿**（本轮从 222 增至 229，新增 7 个回归测试）

---

## 三、明确不做（有证据，不是遗漏）

| 项 | 理由 |
|---|---|
| 插件自己 `attachController` | 冒充官方 controller 提供者（J1 结论 1） |
| 四家 CLI 注册成独立 `SubagentProvider` | `codex` 是官方包默认 `providerName`，`registerProvider` 抛 `DUPLICATE_PROVIDER`，用户一启用官方 Codex 包我们就崩（O1 结论） |
| 改 `delivery: 'parent'` | 重复完成通知（J3） |
| 导出 Schemastery `Config`（O1 版） | 已用官方 `StandardSchemaV1` 做到，无需引入依赖（J2 纠正） |
| `permissionMode` 做成工具参数 | 反转官方"实例固定、模型不能自我提权"的保证（J3 §5） |
| 把字段名改成与官方一致 | 语义不同，同名会造成虚假一致（J3 §3） |
| one-shot / 禁 resume | category error，会删掉可用能力（J3） |

---

## 四、仍待办

### P0 产品决策（一直挂着，非代码问题）
1. 是否把插件装进运行中的 `~/.dsh/profiles/web`（会重启 GUI）
2. 装哪个外部 agent —— 本机四个 CLI、两个官方包仍全部 MISSING，定位收窄后可用派发目标为 0
3. 圆桌是否允许扇出到官方 `subagent*`
4. 是否做命名空间 `alliance` provider（O1 建议，架构变更）

### P1 工程
- **25 个本地提交未推送**（`240xu/dsh-agent-alliance` 无凭据）
- `dsh-tool-jobs` 在 web profile 的 host plane 被禁用（J1 发现 preset scope 与 host plane 不一致），这是"面板无主 job 失败"的根因；按官方范式应在 patch 行启用，属部署决策
- runtime `0.2.1-rc.2` 与 checkout `0.2.1-alpha.2` 的 seam 定义不同（`agentPreset` vs `toolFilter`/`persona`）；所有引用一律以**已安装 rc.2** 为准，后续不要从源码 checkout 反推

### P2 复核
- L2 的 C1/C4–C7 五个 cluster 的对抗复核仍未完成（第三轮网络中断遗留），但 C4（字符串匹配）已在本轮按 J1 证据修复
- A6 的 HMR 状态保留小问题（J2 标为 minor）

---

## 五、风险登记

| 风险 | 等级 | 状态 |
|---|---|---|
| 本机无任何外部 agent，插件装上去是空壳 | 高 | 待 P0-2 |
| 25 提交仅在本地磁盘 | 中 | 待推送 |
| 官方包未安装，J3 全部结论基于源码而非运行验证 | 中 | 报告已声明 method limits |
| `tool-jobs` 在 host plane 被禁用 | 中 | 部署决策 |
| runtime 与 checkout 版本偏差导致误判 | 中 | 已注明以 installed 为准 |
