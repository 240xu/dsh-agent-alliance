# S1 — 范围界定与官方化对齐计划

**仓库：** `dsh-agent-alliance` at HEAD **`150646e`**（工作树干净，262 tests 绿）
**运行时权威：** `/opt/dsh-0222/node_modules/@deepseek-ai/` = **`0.2.2-rc.5`**
（`/opt/dsh-0222/package.json` → `"@deepseek-ai/dsh": "0.2.2-rc.5"`）

**基线实测（本轮）：** `node --test tests/*.test.js` → **262 pass / 0 fail**
（4.2s）。runtime 版本实测：`/opt/dsh-0222/package.json` → `0.2.2-rc.5`。

**这是规划文档，不是执行文档。** 它界定「什么算官方化对齐」「什么不算」，给出
精简候选与优先级，并明确列出**不该做**的事。全部判定都带官方 `path:line` 或实测输出。

---

## 0. 判定框架：三种「不同」，只有一种是问题

任务书特别提醒「看到不同就判偏离」是最容易犯的错。先把判据固化，A 节每项都落到这三类之一：

| 分类 | 含义 | 处置 |
| --- | --- | --- |
| **必要自建**（necessary own-build） | 官方没有等价物，或用了官方机制会**引入缺陷** | 保留，并在代码注释里写明「为什么不用官方」 |
| **多余自造**（redundant re-invention） | 官方有等价物，我们的版本更差或纯重复 | 对齐或删除 |
| **命名/形态不一致**（cosmetic divergence） | 行为等价，只是形状不同 | 低优先；除非妨碍官方工具链（catalog、配置校验） |

**关键判据一句话**：*官方机制是否提供了我们没有的保证？* 提供 → 偏离；不提供（或提供得更差）
→ 必要自建。文档不一致本身不是本任务的靶子（用户明确要「会导致行为出错的」），但
**注释里写着与 rc.5 相反的事实**属于会导致后续误改的隐患，单列。

---

## A. 范围界定

七个子项。每项给：位置 → 官方对应物 → 偏离性质 → 建议动作。
标 **【已对齐】** 的是上一轮官方化已完成、本轮只需复核确认的。

---

### A1. 工具注册：raw `register` + `withArgValidation` vs `defineTool`

**位置：** `src/tools.js:246` `withArgValidation`；6 处
`ctx.tools.register(withArgValidation({...}))`（`:364,469,574,608,638,711`）。

**官方对应物（rc.5 实测三重确认）：**

1. 注册入口仍是 `ToolsService.register(definition, options?)`
   —— `dsh-tools/lib/types/index.d.ts:50`。**这是 Service Definition 公开方法**，
   不是内部 API，官方生产代码也在用（`subagent/src/structured.ts:83`）。
2. `register` 的实体（`dsh-tools/lib/index.js:433-445`）只做三件事：校验
   `output` 形状、`assertSupportedJsonSchema(output.schema)`、校验 `timeoutMs` 正数，
   然后 `layers.effect(...)` 插入。**全程不调 `validate(args)`。**
3. 参数校验只存在于 `defineTool`（`dsh-tools/lib/index.js:338-342`）：
   ```js
   async execute(args, exec) {
       const violations = validate(args);
       if (violations.length > 0) throw new ToolArgsError(violations);
       return userExecute(args, exec);
   }
   ```
   —— 即「`defineTool` 把校验包进 `execute`」，`register` 本身从不校验。

**实测（rc.5 真实 `ToolsService`）：**

```
registered OK, disposer type: function
register with options.when OK
```

注册路径在 rc.5 完好，`options.when`（rc.5 新增）也可用。

**偏离性质：必要自建。** `withArgValidation` 正是补 `register` 缺的那一半，与官方
`structured.ts` 的做法同构（那里也是手写 `validateJsonSchemaValue` 后抛
`ToolArgsError`）。少了它，`required: ['prompt']` 就是**假广告**：模型传 `{}` 会
直接进 tool body。这不是「自造」，是「补齐官方机制在本入口不提供的保证」。

**建议动作：保留，并做两点收敛。**

- (a) `withArgValidation` 的 JSDoc 已写明理由（很好），但**没有引用官方行号**。
  建议补成 `dsh-tools/lib/index.js:338-342`（`defineTool` 的校验位置），
  让后来者一眼看到「官方也是这么补的」。
- (b) **可选**：rc.5 的 `register(definition, options)` 支持 `options.when`。
  我们的 6 个工具全部无条件注册。若将来要做「jobs 缺失时隐藏后台类工具」，
  这是官方入口；当前**不需要动**，仅登记为「可用未用」。

---

### A2. 配置：手写 `loadConfig` + `~standard` 适配 vs Schemastery

**位置：** `index.js:43-56` 导出 `Config`（`~standard` 形态）；
`src/config.js:221` `loadConfig`。

**【已对齐】** 上一轮已把 U2/A2 的结论落地：官方契约是 `StandardSchemaV1` 而非
Schemastery，我们已导出 `~standard` 包装 `loadConfig`。

**官方对应物：** `cordis/lib/types/registry.d.ts:53-54`
`Config?: StandardSchemaV1<any, T>`；`cordis/lib/index.js:956-962` `resolveConfig`
无条件读 `Config['~standard'].validate(config)` 并用返回的 `value` 替换 row config。

**关键细节（我们做对了，值得固化）：** `index.js:35-42` 的注释指出
「validator 必须只校验、原样返回输入」，因为 Cordis 会用 `value` **替换** row config。
若返回 `loadConfig` 的合并结果，`apply` 里的第二次 `loadConfig` 会把默认值盖在
legacy 文件之上，静默丢弃用户设置。这是 rc.2 时代修过的 bug，rc.5 语义未变
（`resolveConfig` 仍是替换）。

**偏离性质：无（已对齐）。** 用 `~standard` 而非 Schemastery 是官方允许的零依赖路径，
不是偏离。

**建议动作：保留。** 唯一可做的是把 `file: '/nonexistent'` 这个哨兵值
换成显式选项名（如 `skipFile: true`），可读性更好——纯命名问题，低优先。

---

### A3. HTTP 路由：自建 prefix route vs 官方 `WebRoute` + `connection`

**位置：** `src/http.js:55` `rejectionFor`；`:262` `registerHttp`；
`index.js:120` `ctx.inject(['webServer'], …)` 挂面板。

**官方对应物：** `dsh-host-webserver/lib/types/index.d.ts` `WebRoute`
（`kind: 'exact' | 'prefix'`，`handler` 拥有完整响应生命周期）；
`dsh-client-connection` 的 `requestRejection(request)`。

**【已对齐的部分】** 上一轮把 fail-open 改成了 fail-closed：
`src/http.js:62` `if (connection === undefined) return 503`，注释明确引用官方
`dsh-host-open-in-app` 的无条件调用。这是正确方向。

**仍存在的偏离（两处，性质不同）：**

1. **`connection` 未进入 inject（命名/形态不一致）。** 官方
   `dsh-host-open-in-app` 的 `inject = ['webServer','connection','subprocess']`，
   依赖缺失时 fiber 根本不激活，所以它的 `connectionOf(ctx)` 可以裸取。
   我们是 `inject: ['tools']` + `ctx.inject(['webServer'], …)`，`connection` 靠
   `serviceOf` 运行期探测，缺了就返回 503。**行为安全了，但把编译期问题推到了运行期。**
   建议：`ctx.inject(['webServer', 'connection'], …)`，让面板只在两者兼备时挂载
   ——这正是官方形态。
2. **自建 `{ok:true,...}` 信封（多余自造，但属产品选择）。** 官方
   `dsh-host-open-in-app` 直接 `sendJson(res, 200, { apps: [...] })`，没有统一信封。
   我们六个路由共用 `{ok, error, code}`。这不是框架要求，是面板客户端的需要。
   **保留**，但应在文件头注明「信封是产品契约，非官方要求」，免得后人误以为是官方规定。

**建议动作：** inject 收紧（对齐）；信封保留并加注（保留）。

---

### A4. 子进程：`runner-seam` 走 `ctx.subprocess` vs raw spawn 兜底

**位置：** `src/runner-seam.js:24` `spawnCliViaSeam`（走官方 seam）；
`src/runner.js:29` `spawnCli`（raw `node:child_process`）。

**【已对齐】** 上一轮 J2-A4 的结论已落地：官方 `ctx.subprocess` 是**服务**不是导入，
零依赖也能用；seam 提供托管范围终止、凭据清洗、平台语义。`runner-seam.js` 的
文件头已准确复述这三点。

**仍存在的偏离：两者共存。** 需要明确判断这算不算问题：

- raw `spawnCli` 作为**兜底**存在（composition 没挂 `dsh-subprocess-local` 时）。
  这在官方视角下是「能力降级」，与官方 `dsh-tool-bash` 的做法一致——它也声明了
  `ctx.inject(['jobs'], …)` 并在缺失时降级为前台工具。**所以兜底本身是官方认可的形态。**
- 真正的风险不是「共存」，而是**两条路径的行为不等价**：seam 路径杀进程组，
  raw 路径只杀单 pid（J2 已实测孙进程存活）。降级发生时，用户不会被告知
  「你现在没有进程组终止保护」。

**偏离性质：必要自建（兜底合理）+ 缺失（降级未告知）。**

**建议动作：**
- 保留双路径；
- 在「走了 raw 兜底」时**记一次 warn**（`ctx.logger`），并在 `official-coverage.js`
  里把「subprocess seam」列为一个可显示的覆盖项，让用户看到降级；
- 长期：评估把 raw 兜底限制为「仅当 `ctx.subprocess` 缺失且用户显式允许」，
  避免静默弱化。

---

### A5. 服务读取：`src/host.js` `serviceOf` vs 官方 `ctx.get` 语义

**位置：** `src/host.js:26` `serviceOf`。

**【本轮新发现：注释被重构写反了 —— 不是 rc 漂移】** `host.js` 的文件头与
`index.js:22-26` 都写着：

> `ctx.get(name)` answers for a registered service, but it **throws** for a name
> outside this plugin's injected set

**这个前提在 rc.5 是错的。** 实测：

```
{ "jobs":     { "viaGet": "undefined", "viaProp": "THREW: cannot get property "jobs" without inject" },
  "webServer":{ "viaGet": "undefined", "viaProp": "THREW: ..." },
  "connection":{ "viaGet": "undefined", "viaProp": "THREW: ..." } }
```

`ctx.get(name)` 对未注入的服务**返回 `undefined`，从不抛错**；只有 `ctx[name]`
属性读才会抛 `cannot get property ... without inject`。再测「已挂载但未注入」：

```
{ "jobs": { "viaGet": "SERVICE", "viaProp": "THREW: cannot get without inject" } }
```

即 `ctx.get` 能读到未注入但已挂载的服务。

**这意味着 `serviceOf` 的结构可以简化：** `try { ctx.get(name) } catch {}` 的
catch 分支永远不触发；后半段 `ctx[name]` 兜底只对「假 context」（测试里的普通对象）
有用，对真实 Cordis context 是死代码。

**偏离性质：多余自造（部分）。** 不是行为错误（结果仍然正确），但是**基于错误前提的
防御代码**，会误导后来者以为 `ctx.get` 不可靠。

**归因（重要，避免误判为 rc 漂移）：** 我查了引入历史。这个说法**不是 rc.5 才失效的**，
而是 `39638e9`（"one serviceOf instead of seven hand-rolled copies"）重构时写反的。
重构前 `src/tools.js` 的注释是**正确**的：

```
* `ctx.get(name)` returns undefined for a service this plugin did not inject.
* A bare property read would throw "cannot get property ... without inject", so
* it is only attempted as a fallback for fake contexts (tests, plain objects).
```

即：**合并七份拷贝时，把「ctx.get 返回 undefined」误写成「ctx.get 抛错」**，
并在 `serviceOf` 里加了一个永远不会触发的 `catch`。所以这是本仓库自己的
重构回归，rc.5 语义与 rc.2 相同（本会话早期在 rc.2 树上跑同一探针，
结果同样是「viaGet: undefined / viaProp: THREW」）。

**建议动作：**
- **必做**：修正 `host.js` 与 `index.js` 的注释，写明 rc.5 的真实语义
  （`ctx.get` 返回 undefined；属性读才抛）。这是本轮**唯一一处「注释与官方相反」**，
  属于会诱导后续改错的隐患。
- 可选：把 `try/catch` 收敛为「仅在 `typeof ctx.get !== 'function'` 时走属性兜底」，
  保留对假 context 的兼容，同时删掉永不触发的 catch。**低优先**，因为当前写法
  虽然冗余但无害。

---

### A6. 诊断：`src/diagnostic.js` 分类 vs 官方 `failureDiagnostic`

**位置：** `src/diagnostic.js`（七分类 + 4096 字节截断）。

**【已对齐，且做法正确】** 上一轮 J2-A7 的违规已修：不再把 raw stderr 塞进
模型可见的错误文本，而是收敛成官方形态。

**官方对应物：**
- 契约：`dsh-subagent/lib/types/types.d.ts` `SubagentResult.diagnostic`
  ——「free of tool inputs, file contents, environment values, credentials, and raw
  protocol payloads」，上限 4096 UTF-8 字节；
- 实现参照：官方 provider 只从固定字段构造 `Product subagent failure (…; stage: …;
  category: …)`，`cause` 藏在内部。

**我们的实现核对：**
- `CLI_FAILURE_CATEGORIES` 七项与官方 codex wire 分类一致；
- `MAX_DIAGNOSTIC_BYTES = 4096` 与 `dsh-subagent/lib/index.js:2738`
  `MAX_SUBAGENT_DIAGNOSTIC_BYTES = 4096` 一致；
- `limitDiagnostic` 在 UTF-8 边界截断，避免劈开多字节序列——比单纯 `slice` 正确。

**偏离性质：命名不一致（轻微）。** 我们叫 `CLI_FAILURE_CATEGORIES`，官方叫
`ClaudeCodeFailureCategory` / codex 的 wire category。分类集合是同一套，名字不同。

**建议动作：保留**（这是本仓库最干净的一处官方化）。可选：在 JSDoc 里补
`dsh-subagent/lib/index.js:2738` 这个 4096 的来源行号，当前只写了类型文件。

---

### A7. 生命周期：`ctx.effect` vs 官方 `registerProvider` / `tools.register`

**位置：** `index.js:142` `ctx.effect(() => registerTools(...))`；
`index.js:120-122` `ctx.inject(['webServer'], webCtx => webCtx.effect(() => registerHttp(...)))`。

**官方对应物：** `SubagentRuntime.registerProvider(provider)` 返回 effect disposer
（`dsh-subagent/lib/types/index.d.ts`）；`ToolsService.register` 返回 effect disposer
（`dsh-tools/lib/types/index.d.ts:49`）。

**评估：对齐。** 两类注册都包在 `ctx.effect` 里，disposer 由 fiber 拥有；
`registerTools` 内部按逆序释放 6 个工具 disposer。与官方
「registration is an effect」一致。

**偏离性质：无。** 一处小 gap（J2-A6 提过）：`registerHttp` 闭包里的 `recent`
与 `detectCache` 不在 disposer 里清理，HMR 重载瞬间可能读到上一 fiber 的
`recentDispatches`。**低优先**，只在 HMR 场景可见。

**建议动作：保留；HMR 清理列为可选项。**

---

## B. 精简候选清单（按收益排序）

判据三列：**调用点**（grep 计数）、**测试覆盖**（对应 `tests/*.test.js` 是否存在）、
**是否对外契约**（模型可见的工具描述/参数、面板 HTTP 信封、`package.json` exports —— 
是则不能随意改）。

总量：`client.js 1294 / src/tools.js 749 / src/http.js 636 / src/backend.js 497 /
persist.js 308 / config.js 232 / roundtable.js 193 / 四个 provider ~840`。

---

### B1. `src/tools.js`（749 行）— 收益最高

结构：11 个顶层函数 + `registerTools` 内 6 个工具定义（`register` 出现 8 次，含
`withArgValidation` 包裹）。

| 候选 | 判据 | 收益 | 风险 |
| --- | --- | --- | --- |
| **六个工具定义抽成声明表** | 6 段结构高度相似（name/description/params/output/presentCall/execute）；`params` 7 次、`openOutput` 7 次、`withArgValidation` 7 次 | 预计 −150~200 行，且让「六工具同一形状」变得可检查 | 中：`execute` 之间差异大（dispatch 有后台/前台分支，roundtable 有 registry 适配层），抽过头会变成参数化地狱 |
| `renderDispatch`（2 调用点）并入 `openOutput` 的 render | 仅 dispatch 家族使用 | −15 行 | 低 |
| `lossless`（14 处）保留 | 每处都在「返回值过 registry 前」这一语义点 | — | 删除会让 `ToolOutputError` 从「静默」变「响亮」，属行为变更，不在精简范围 |

**建议：只做第一项，且限定为「抽出 description 与 parameters 常量表」**，
不动 `execute` 分支。收益 ~80–120 行，风险低。

### B2. `src/http.js`（636 行）— 收益次高

16 个函数。`failure` 24 次、`route` 23 次、`sendError` 5 次、`jobsOf` 5 次、
`requestUrl` 5 次、`intParam` 4 次。

| 候选 | 判据 | 收益 | 风险 |
| --- | --- | --- | --- |
| **`route()` 包装与 `failure()` 错误码体系合并** | 两者都是「把 handler 异常映射成 `{ok:false,code}`」，`failure` 已在做状态+码，`route` 又包一层 try/catch | −40~60 行 | 中：`route` 还负责 405 与日志，需保留职责 |
| **`sendRejection`(2) / `sendJson`(3) / `sendOk`(2) / `sendError`(5) 合并为 2 个** | 都是 `writeHead+end` 的薄封装 | −25 行 | 低 |
| **`taskRow`(3) / `jobsOf`(5) / `backendOf`(2) / `cwdOf`(3) / `remember`(3) 保留** | 每个都有独立语义（投影/服务查找/解析/记忆），合并会降低可读性 | — | — |
| **`detectRows`(2) 与官方 seam 对齐** | 目前自建 TTL 缓存 + `detectAll`；audit3-C2 已发现 orphan child 问题 | 不是精简，是**修缺陷** | 见 C 节 P1 |

**建议：做前两项（−65~85 行）。`detectRows` 归入缺陷修复，不归精简。**

### B3. `client.js`（1294 行）— 收益最大但风险最高

30 个函数：14 个 UI 组件（`StateTab 568`…`TasksTab 1096`）、11 个工具函数、
2 个 hook（`useLoad`/`useJobOutput`）、`Panel`/`Icon`/`apply`。
单个浏览器 bundle，无构建步骤，`window.__ModuleLoader__` 加载。

| 候选 | 判据 | 收益 | 风险 |
| --- | --- | --- | --- |
| **五个 Tab 组件按「加载态/错误态/空态」抽公共壳** | 每个 Tab 都是 `useLoad` + `loading?Loading:error?ErrorRow:content` 同一骨架 | −100~150 行 | 中：各 Tab 的 refresh/retry 绑定不同 |
| **`queryString`/`instantText`/`durationText`/`stampOf` 等格式化函数集中** | 11 个工具函数散在组件之间 | −20 行（主要是可读性） | 低 |
| **`locale` 字典（`:94` 与 `:201` 两处）核对是否重复** | 有 zh/en 两份 dict | 若重复可合并 | 低 |
| **不拆文件** | 单 bundle 是 `package.json` `dsh.client` 契约的一部分（`exports: './client'`） | — | 拆分会破坏加载契约 |

**建议：只做「Tab 公共壳」一项，且先用 1 个 Tab 试点再推广。**
不做文件拆分（会破坏 client-module 契约）。

### B4. 其余文件 — 低收益，不建议动

| 文件 | 行数 | 结论 |
| --- | --- | --- |
| `src/backend.js` | 497 | 23 个函数，每个对应一个解析分支；`annotatePoolRejection` 等都有测试。**不动** |
| `src/importer/persist.js` | 308 | 落库 + 台账，audit 反复确认正确（原子写、幂等、finally close）。**不动** |
| `src/config.js` | 232 | 校验逻辑密集但每行都在防一种错误配置。**不动** |
| `src/roundtable.js` | 193 | audit5-C1 刚改过缓存前缀。**不动** |
| `provider/*.js` ~840 | — | 四个 provider 结构相似但 argv/env 差异真实存在；`shared.js` 已抽出公共部分。**不动** |
| `src/host.js` | 39 | 见 A5，改注释即可 |

---

## C. 优先级与依赖图

工作量：**S** ≤ 半天、**M** 1–2 天、**L** ≥ 3 天。
风险：**低** = 有测试护栏且行为不变；**中** = 行为可能变化，需补测试；**高** = 触及对外契约。

### P0 — 先做，且互相独立（可并行）

| # | 项 | 出处 | 工作量 | 风险 | 阻塞关系 |
| --- | --- | --- | --- | --- | --- |
| P0-1 | 修正 `host.js` / `index.js` 关于 `ctx.get` 的**错误注释** | A5 | **S** | 低 | 无。**这是全文档唯一的「注释与官方相反」**，不修会诱导后人删掉必要兜底或反之 |
| P0-2 | HTTP 面板 `inject` 收紧为 `['webServer','connection']` | A3 | **S** | 中 | 依赖 P0-1 先澄清 `serviceOf` 语义（否则容易顺手也改 `serviceOf`） |
| P0-3 | `detectAll` 超时后未取消底层 `detect()` → orphan child | audit3-C2 | **M** | 中 | 独立。收益：进程不泄漏、关停不延迟 |

P0-1 与 P0-3 完全独立，可并行；P0-2 建议排在 P0-1 之后（同文件语义澄清先行）。

### P1 — 紧随其后

| # | 项 | 出处 | 工作量 | 风险 | 阻塞关系 |
| --- | --- | --- | --- | --- | --- |
| P1-1 | raw spawn 兜底时**记录降级 warn** + `official-coverage` 增加 subprocess 项 | A4 | **S** | 低 | 无 |
| P1-2 | `http.js` 合并 `route()`/`failure()` 与四个 `send*` | B2 | **M** | 中 | 依赖 P0-2（同文件，避免两次改同一段） |
| P1-3 | `tools.js` 抽出 description/parameters 常量表 | B1 | **M** | 低-中 | 无 |
| P1-4 | `official-coverage.js` 的 `@type` 补 `ready` 字段 | A6 周边 | **S** | 低 | 无 |

### P2 — 可选，收益递减

| # | 项 | 出处 | 工作量 | 风险 |
| --- | --- | --- | --- | --- |
| P2-1 | `client.js` Tab 公共壳（先试点 1 个 Tab） | B3 | **L** | 中 |
| P2-2 | `registerHttp` 在 disposer 里清理 `recent`/`detectCache`（HMR） | A7 | **S** | 低 |
| P2-3 | `serviceOf` 删掉永不触发的 `catch`（保留假 context 兼容） | A5 | **S** | 低 |
| P2-4 | `diagnostic.js` JSDoc 补 4096 来源行号 | A6 | **S** | 低 |

### 依赖图（文字版）

```
P0-1 (host 注释)
   └─> P0-2 (inject 收紧)  ──> P1-2 (http 合并)
P0-3 (detectAll 取消)      [独立]
P1-1 (降级 warn)           [独立]
P1-3 (tools 常量表)        [独立]
P1-4 (coverage 类型)       [独立]
P2-*                       [全部独立，可任何时候做]
```

**并行度：** 除 `P0-1 → P0-2 → P1-2` 这一条链外，其余全部可并行。

**不建议做的顺序反例：** 先做 P1-2（http 合并）再回头做 P0-2（inject），
会在同一文件产生两次冲突解决。

---

## D. 明确不做

这些**看起来该做**（因为「官方没有 / 官方不一样」），但做了会**引入缺陷或删除功能**。
每条都给出实测或源码依据。

### D1. 不把我们的 provider 注册成官方 `SubagentProvider`

**为什么看起来该做：** 「官方化」似乎意味着「用官方接口」，而 `registerProvider`
是官方的 provider 注册入口。

**为什么不能做：** 官方对重名直接抛错，没有覆盖/合并语义：

```js
// dsh-subagent/lib/index.js:3236
if (this.providers.has(name)) throw new SubagentError(
  `a subagent provider named "${name}" is already registered`, "DUPLICATE_PROVIDER");
```

`codex` / `claude-code` 这些名字已被官方 bundle 占用。再注册一次的结果不是
「我们的实现生效」，而是**插件激活失败**（`DUPLICATE_PROVIDER` 从 effect 里抛出）。
即使改用私有名字（如 `alliance-codex`），也只是造了一个官方工具看不见的平行 provider，
用户还得手动改 `subagentProvider` —— 比现状更差。

**正确形态：** 保持现状。`official-coverage.js` 已经用「名字已存在」这一事实来做
「优先用官方」的判定，这正是官方数据的正确用法。

---

### D2. 不把 `delivery: 'caller'` 改成 `'parent'`

**为什么看起来该做：** 官方 `dsh-tool-subagent` 用 `delivery: 'parent'`
（`dsh-tool-subagent/lib/index.js` 的 `delivery: "parent"`），我们的是 `'caller'`。

**为什么不能做：** `parent` delivery 会在子任务结束时向父 Agent 的 inbox 注入
一条 `subagent-settled` 消息（官方 `notifySettlement`：
`if (!activation.announced || activation.delivery === 'caller') return;`）。
我们的 `agent_dispatch` 是**同步等待 `activation.result` 并把文本作为 tool result
返回**的；改成 `parent` 会让同一个答案**到两次**——一次在 tool result 里，
一次在随后的 settle 通知里。模型会看到重复内容并可能重复行动。

**正确形态：** `'caller'` 就是为「调用方自己消费结果」设计的。官方
`dsh-tool-subagent` 用 `parent` 是因为它**立即返回 child id 不等待**。
两者形状不同是**必然**，不是偏离。（这条在 J2/F 已论证过，此处固定为「不做」。）

---

### D3. 不因为「官方有 `subagent` 全局工具」就删掉 `agent_dispatch`

**为什么看起来该做：** DSH `dsh-base` 自带 `subagent` / `subagent_fork`，
启用 vendor bundle 还有 `subagent_codex` / `subagent_claude_code`。重复了。

**为什么不能做（至少不能全删）：**
1. `official-coverage.js` 已用 `dispatch: false` 让 codex/claude **默认不再作为
   本插件的派发目标**——重复已在默认配置层面消除，且测试固定（`ready` 字段）。
2. `agent_dispatch` 仍承担的**不可替代**职责：`zcode` 无任何官方路径；
   `resumeSessionId` 续聊只有 CLI 路径能做；`agent_sessions` / `agent_session_read` /
   `agent_import*` 四个能力官方 seam **完全未提供**（历史浏览与导入）。
3. 删掉 `agent_dispatch` 会让 `dispatch: true` 的 opencode/zcode 失去入口。

**正确形态：** 保留工具，靠 `dispatch` 开关与 `official-coverage` 提示做引导
（现状）。若未来官方覆盖全部四家，再删工具才是对的——那时是一行 config 改动，
`official-coverage.test.js` 会提醒。

---

### D4. 不把 `client.js` 拆成多文件

**为什么看起来该做：** 1294 行是仓库最大文件。

**为什么不能做：** `package.json` 的 `dsh.client` 与 `exports['./client']` 指向
**单个** `client.js`，且它靠 `window.__ModuleLoader__.load({ id, factory })` 自注册。
拆成多文件要么需要构建步骤（本项目零构建是刻意约束），要么需要运行时二次加载
——两者都会破坏 client-module 契约。`tests/manifest-guard.test.js` 正是钉这个的。

**正确形态：** 只在文件内部抽组件（B3 的 Tab 公共壳），文件边界不动。

---

### D5. 不把 `withArgValidation` 换成 `defineTool` 依赖

**为什么看起来该做：** 官方推荐 `defineTool`。

**为什么不能做：** `defineTool` 来自 `@deepseek-ai/dsh-tools`，引入即产生
**运行时依赖**，与本项目「零依赖、可被任意 profile 加载」的设计冲突
（`package.json` 无 `dependencies`）。而 `register` + 自建校验正是官方
`subagent/src/structured.ts:83` 的既有做法。

**正确形态：** 现状（A1）。若哪天项目接受依赖，再用 `defineTool` 改写是一行级替换。

---

### D6. 不为「统一错误信封」去改官方 `WebRoute` 用法

**为什么看起来该做：** 官方 `dsh-host-open-in-app` 直接返回 `{apps:[...]}`，
没有 `{ok:...}`。

**为什么不能做：** 我们的面板客户端（`client.js` 的 `request()`）**统一依赖**
`payload.ok !== true` 来判失败（`client.js:383` `failureMessage` 读 `payload.error`）。
去掉信封要同步改 6 个路由 + 客户端所有调用点，收益仅是「更像官方」，
而官方从未要求统一信封。

**正确形态：** 保留，但在 `http.js` 文件头注明「信封是产品契约，非官方要求」（A3 已建议）。

---

## E. 验收标准

原则：**「看起来对齐」不算对齐。** 每项给出「能反证自己的证据」——
一个在没有真正对齐时会失败的检查，而不是一个在写完后必然为真的断言。

### E1. A5（`ctx.get` 注释修正）

**反证检查：** 用一个**未注入**的服务名跑真实 Cordis context，断言
`ctx.get(name) === undefined` 且不抛错。

```js
// 必须能在 rc.5 上通过；注释若写「会抛错」，这条就与该注释矛盾
await root.plugin({ name:'p', inject:['tools'], apply(ctx) {
  assert.equal(ctx.get('jobs'), undefined)            // 不抛
  assert.throws(() => ctx.jobs?)                       // 属性读才抛（语法示意，用 try/catch）
}})
```

**判定：** 注释里出现的每一个行为断言，都必须有一条对应测试或在注释中引用实测输出。
本仓库当前**没有**这条测试 → 建议随注释修正一起补 `tests/host.test.js`。

### E2. A3（面板 inject 收紧）

**反证检查：** 两个 composition 各跑一次。

| composition | 期望 |
| --- | --- |
| 挂 `webServer` + `connection` | 面板注册成功，`/state` 200 |
| 只挂 `webServer`（无 `connection`） | **面板根本不注册**（`ctx.inject` 未满足），而不是注册后 503 |

第二条是关键：现在的实现是「注册了但每个请求 503」，收紧后应该是「不注册」。
**证据形式：** 断言 `webServer` 上不存在 `/__agent-alliance` 前缀路由。

### E3. P0-3（`detectAll` 取消）

**反证检查：** 注入一个永不 settle 的 `detect()`，`budgetMs: 100`，
断言**进程能在 500ms 内自然退出**（orphan 不再持有 event loop）。

audit3-C2 实测的失败形态是：
```
PROCESS EXITED at 3154 ms after detectAll returned   // 预算 100ms，关停延迟 3s
```
对齐后的期望：`PROCESS EXITED at < 500 ms`。**这条必须是真的计时断言，不能只看返回值。**

### E4. A4（降级 warn + coverage）

**反证检查：** 两张表驱动测试。

1. `ctx.subprocess` 存在 → 断言 `spawnCliViaSeam` 被调用、raw `spawnCli` **零调用**。
2. `ctx.subprocess` 缺失 → 断言 raw `spawnCli` 被调用**且** `ctx.logger.warn` 收到一次降级消息。

只测 (1) 不够——那证明不了降级路径有提示。

### E5. A6（诊断）

**反证检查：** 构造 4097 字节与含多字节字符的诊断，断言：

- `Buffer.byteLength(out) <= 4096`；
- 末尾是 `[diagnostic truncated]`；
- **解码后不含替换字符 U+FFFD**（证明没有劈开多字节序列）。

`diagnostic.test.js` 已存在；核对它是否覆盖「恰好截在多字节中间」这一例。
（audit 未验证该用例是否存在——执行阶段第一步应确认。）

### E6. B1/B2（精简）

**反证检查：** 精简类改动的验收**不是行数**，而是：

1. `node --test tests/*.test.js` 全绿（262 基线不降）；
2. **工具/路由的对外形状零变化**：
   - 六工具的 `name`/`parameters` JSON **逐字节**不变（可 snapshot 断言）；
   - 六个 HTTP 路由的 `{ok, code}` 响应**同形**（可用现有 `http.test.js` 断言加强）；
3. `git diff --stat` 只减不增（除测试补充）。

**只报「少了多少行」是无效验收。**

### E7. D 节（不做项）的守护

**反证检查：** D1–D6 每一条都应有一条**失败即报警**的测试，防止后来者「顺手官方化」：

| 项 | 守护测试 |
| --- | --- |
| D1 不注册 provider | 断言插件激活 `apply()` 执行后 `ctx.subagents.list()` 不含我们新增的名字 |
| D2 不改 delivery | 断言 `backend.js` 源码里 `delivery: 'caller'` 存在（或行为测试：一次 dispatch 只产生一条 tool result，无重复 settle 通知） |
| D3 不删 agent_dispatch | `tools.test.js` 已覆盖六工具注册；再加一条「`official-coverage` 有 officialPath 的 provider 默认 `dispatch: false`」 |
| D4 不拆 client | `manifest-guard.test.js` 已钉 `exports['./client']` 指向单文件 |
| D5 不引 defineTool | `package.json` 断言 `dependencies` 为空/不存在 |
| D6 不改信封 | `http.test.js` 断言每个路由 `payload.ok === true` |

### E8. 全局回归门

任何一项合并前：

```
node --test tests/*.test.js        # 262 基线，不得下降
git diff --stat                    # 确认只动了目标文件
```

**不接受**「本地跑过」而无输出。验收证据必须贴出实际命令与结果行。

---

## 附：本轮的诚实边界

- **未做的验证：** `diagnostic.test.js` 是否覆盖「截断劈开多字节」这一具体用例（E5），
  以及 `official-coverage.test.js` 是否覆盖 `ready` 的每种组合 —— 这两项留给执行阶段第一步。
- **已观察且已证明不影响的 rc.5 变化：** rc.5 把工具**执行**拆成独立
  `ToolExecutor` seam（`dsh-tools/lib/types/executor.d.ts`，
  `TOOL_EXECUTOR_UNAVAILABLE`）。我们是纯注册方，**从不调用 `tools.execute`**：

  ```
  $ grep -rn "tools.execute|TOOL_RUNTIME_SCHEDULER|executor" src/ index.js
  (无输出)
  ```

  且 `ToolsService.register`（`dsh-tools/lib/types/index.d.ts:50`）在 rc.5 实测注册成功。
  所以本次拆分对我们零影响。**登记为「已观察、不影响当前代码」**，不列入计划；
  若将来要做 PTC / 自定义 executor，那才是新入口。
- **未安装的包：** `dsh-subagent-codex` / `-claude-code` 在本机 `/opt/dsh-0222` 中
  **不存在**（`ls | grep subagent` 只有 `dsh-subagent`、`-fork-in-process`、
  `-spawn-in-process`、`tool-subagent`、`tool-subagent-control`）。
  因此 A6 对官方 provider 实现的引用来自源码 checkout，不是本机运行时。
  `official-coverage.js` 声称的 `subagent_codex` / `subagent_claude_code` 是
  「启用 bundle 后才会出现」，与安装现状一致。
