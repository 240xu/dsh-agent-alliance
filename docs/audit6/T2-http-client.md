# T2 — `src/http.js` + `client.js` 专项对齐审计

目标仓库：`dsh-agent-alliance`（工作目录 `/home/ova/dsh/.artifacts/dsh-plugins/dsh-agent-alliance`）
官方参照：`@deepseek-ai/dsh-*@0.2.2-rc.5`，安装于 `/opt/dsh-0222/node_modules/@deepseek-ai/`
性质：**只读审计**。本文之外未修改任何文件，未 commit。

行数基线：`src/http.js` = 636 行，`client.js` = 1294 行。

---

## 摘要

| 问题 | 结论 | 是否偏离官方 |
|---|---|---|
| A1 `requestRejection` 调用位置 | 语义等价，实现形态不同 | 否（等价） |
| A2 `WebRoute.kind` / `resource` vs `handler` | 选型正确 | 否 |
| A3 `readJson` body 上限 | **有上限，但值不同**：我方 1 MiB，官方 64 KiB | **是（数值缺失，非缺失上限）** |
| A4 `detectRows` promise 缓存 | 官方有同类惯例 | 否（但 TTL 是无对应物的自创） |
| B1 `__ModuleLoader__` / `{inject, apply}` | 形状正确 | 否 |
| B2 slots 注册选项 | 基本正确，`order: 30` 是有意义的偏离 | 轻微 |
| B3 i18n | 已走 `ctx.locale`，但**自带 `localize()` 兜底是多余的** | 轻微 |
| B4 1294 行可否拆分 | **可以拆，且是官方支持的机制** | 否（当前不分是浪费） |

---

# A 节 — HTTP（`src/http.js`）

## A1. `connection.requestRejection` 的调用位置

### 官方

`packages/host/open-in-app/src/index.ts:184-191`：

```ts
const rejected = (req: IncomingMessage, res: ServerResponse): boolean => {
  const rejection = connectionOf(ctx).requestRejection(req)
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}
```

调用点在**每个 route handler 的第一行**，三条路由各调一次：

- `index.ts:197`（apps）、`:210`（icon）、`:245`（open）

即：官方是 `ctx.webServer.register()` 注册 **三条独立路由**，每条自己守门。

### 我方

`src/http.js:614-620`：在**唯一的 prefix handler 顶部**调一次，路由表在之后才查：

```js
handler: async (req, res) => {
  const rejection = rejectionFor(ctx, req)   // :616
  if (rejection !== undefined) { sendRejection(res, rejection); return }
  ...
}
```

### 判决：**语义等价，无需改动**

理由（双侧证据）：

1. **覆盖面**：官方三条路由是 `exact` + `prefix` 混合（`apps` exact、`icon` prefix、`open` exact）。我方把 9 个子路径收进一个 `prefix`，所以"每 handler 调一次"退化成"入口调一次"——因为只有一个 handler。
2. **顺序不变**：两边都是「信任判定 → 方法检查 → 业务」。我方 `:616` 在 `:622`（URL 解析）和 `route()` 的方法检查（`:306`）之前，与官方 `:197` 在 `:198` 方法检查之前一致。
3. **测试已把这条语义钉死**：`tests/http.test.js:310-315` 断言被拒请求 `response.json === undefined`（纯文本）、`content-type: text/plain`，且 `dispatches === 0`、`resolutions === 0`——即拒绝发生在任何业务副作用之前。

**唯一实质差异**：我方 `rejectionFor` 支持两套 API（`admit` / `requestRejection`）并在服务缺失时返回 503（`src/http.js:62,71`），官方只认 `requestRejection` 且服务缺失会直接 throw（`index.ts:85` 的 `Reflect.get` 后立即调用）。我方这是**更严格的 fail-closed**，且 `tests/http.test.js:352,361` 两个测试专门守它。**不要为了"对齐"而改成 throw。**

**契约影响**：无。改与不改都不动状态码/code/JSON。

---

## A2. `WebRoute` 的 `kind` 与 `resource` vs `handler`

### 官方类型

`dsh-host-webserver/lib/types/index.d.ts:36-59`：

```ts
export type WebRouteKind = 'exact' | 'prefix'
export interface WebRoute {
  kind: WebRouteKind
  path: string
  handler: (req, res) => void | Promise<void>
}
export interface WebResourceRoute {
  kind: WebRouteKind
  path: string
  resource: (request: Request, peer?: PeerScope) => Promise<Response>
}
```

`register(route: WebRoute | WebResourceRoute)`（`:193`）——**两种形态都合法**，`handler` 不是遗留写法。

### 官方实际选型

`open-in-app`：`apps` 用 `exact`（`:194`），`icon` 用 `prefix`（`:207`），`open` 用 `exact`（`:242`）。**全部用 `handler`，没有一个用 `resource`。**

`dsh-client-modules` 的 `/plugins` 也全用 `handler`（`lib/index.js` 的 `register({kind, path, handler})`）。

### 我方

`src/http.js:611-613`：一个 `kind: 'prefix'` + `handler`，`path: '/__agent-alliance'`。

### 判决：**选型正确，无偏离**

- `prefix` 对：9 个子路径共享前缀，`tests/http.test.js:242-245` 断言 `routes.length === 1`、`kind === 'prefix'`、`path === ROUTE_PREFIX`——这是被测试固定的契约，改成 9 条 exact 会直接打破 3 个断言。
- `handler` 对：`resource` 的语义是"GET/HEAD 由 Fetch Response 表达，且支持进程内 `readResource`"。我方全是 POST 业务动作 + 需要 `req.headers` 做信任判定，`resource` 拿不到原始 `IncomingMessage.headers` 的同等形态（`request` 只有 Fetch headers），且 `readResource` 的进程内读取对我们无意义。**用 `handler` 是正确选择，不是落后。**

**唯一可考虑的优化**：`prefix` 意味着 `/__agent-allianceanything` 也会进 handler。实测行为：`slice(ROUTE_PREFIX.length)` 得到 `anything`，查 `routes` 表未命中 → 404 `not-found`（`src/http.js:629-631`）。所以**行为安全**，只是多一次 Map 查询。不建议改成 exact×9。

**契约影响**：无。

---

## A3. `readJson` 的 body 上限 —— **这是真缺失（数值层面）**

### 官方

`packages/host/open-in-app/src/index.ts:89`：

```ts
/** Open-route request bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024
```

`readBoundedBody`（`:107-121`）：

```ts
for await (const chunk of req as AsyncIterable<Buffer>) {
  size += chunk.byteLength
  if (size > MAX_BODY_BYTES) {
    req.resume()          // 排空剩余，让拒绝成为可读响应而非断流
    return null
  }
  chunks.push(chunk)
}
```

超限映射为 **413**（`:265-268`）：

```ts
if (text === null) {
  sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' })
  return
}
```

### 我方

`src/http.js:24-25`：

```js
/** Request bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 1024 * 1024
```

注释**逐字抄了官方的**，数值却是官方的 **16 倍**。

`readBody`（`:160-169`）：

```js
for await (const chunk of req) {
  size += chunk.length
  if (size > MAX_BODY_BYTES) return undefined   // ← 没有 req.resume()
  chunks.push(chunk)
}
```

超限映射为 **400 `bad-body`**（`:178` + `:460/470/502/599`）：

```js
if (body === undefined) return { error: 'request body is too large' }
...
throw failure(400, body.error, ERROR_CODES.BAD_BODY)
```

### 判决：**上限存在，但两个维度都偏离官方**

| 维度 | 官方 | 我方 | 性质 |
|---|---|---|---|
| 阈值 | 64 KiB | 1 MiB | 数值宽松 16× |
| 超限状态码 | 413 `payload-too-large` | 400 `bad-body` | 语义不同 |
| 超限后 | `req.resume()` 排空 | **直接 return，不排空** | 可能导致 socket 截断 |

**Lead 的假设部分不成立**：我方**不是"没有上限"**，是"上限比官方宽 16 倍且超限语义不同"。请把这条记为「**实现存在，阈值与状态码偏离**」，而非「缺失」。

### 是否可以对齐？

**阈值可以改（64 KiB），状态码不可以。**

- 改阈值 1 MiB → 64 KiB：安全，但需要同步改 `readJson` 的错误文案不变（`'request body is too large'` 保持），只改常量。**注意**：`tests/http.test.js` 目前**没有任何 body 超限测试**（grep `413`/`too large`/`MAX_BODY` 全无命中），所以改阈值不会打破现有 34 个测试。
- 改状态码 400 → 413：**会破坏对外契约**。`ERROR_CODES` 里没有 413 对应项，`client.js` 的 `request()` 只区分 `ok`/非 `ok`，但 413 是新状态码，属于契约面变更。**不建议在精简任务里做**，应单列一个 P 任务。
- 补 `req.resume()`：这是**纯健壮性修复**，不改任何对外值。**建议做**——否则客户端在超限时可能收到 socket EOF 而不是错误 JSON，正好违反 `client.js` "failed request must render an inline error row" 的约束。

### 精简清单项（不动契约）

```js
// src/http.js:160-169
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) { req.resume(); return undefined }   // ← 唯一改动
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}
```

**契约影响**：改 `req.resume()` = 无；改阈值 = 无（无测试覆盖、无客户端分支）；改状态码 = **有，不做**。

---

## A4. `detectRows` 的 promise 缓存与 30s TTL

### 官方有没有"探测缓存"？

**有，而且是 promise 缓存**——正是我方这个形态的出处。

`packages/host/open-in-app/src/index.ts:154-157`：

```ts
/** Lazy once-per-plugin-life resolution; the map is the mutable authority. */
let resolutions: Promise<Map<string, OpenInAppResolvedLaunch>> | undefined
const availability = (): Promise<Map<string, OpenInAppResolvedLaunch>> =>
  resolutions ??= resolveOpenInAppApps(config.probeTimeoutMs, catalogInternals())
```

配套的 icon 缓存也是**promise 缓存**（`:158-167`）：

```ts
const icons = new Map<string, Promise<OpenInAppIcon | null>>()
const iconOf = (app, resolved) => {
  let cached = icons.get(app.id)
  if (cached === undefined) {
    cached = extractAppIcon(app, ...)
    icons.set(app.id, cached)     // 存的是 Promise，不是结果
  }
  return cached
}
```

失效策略（`:173-183` `refreshResolution`）：**显式失效单条**，不做时间过期。

### 我方

`src/http.js:333-362`：同样是 promise 缓存（`detectCache.pending`），但多了 **30s TTL**（`DETECT_TTL_MS`）和失败清除（`:360`）。

### 判决：**promise 缓存是官方惯例，30s TTL 是自创但合理**

| 维度 | 官方 | 我方 | 判决 |
|---|---|---|---|
| 缓存 promise 而非结果 | ✅ | ✅ | **对齐，不要删** |
| 为什么 | 并发首次请求共享一次探测 | 同 | **理由同源** |
| 失效 | 显式逐条 `refreshResolution` | 30s TTL + 失败即清 | 我方是"探测型"，官方是"解析型"，场景不同 |
| 失败处理 | 无（解析不会失败） | `:360` 失败清除 | 我方正确（否则一次抖动锁定 30s 的错误结论） |

**官方没有 TTL 的原因**：`resolveOpenInAppApps` 在 plugin life 内解析一次即可——app 装/卸不会在页面生命周期内频繁发生。而我方探测的是**外部 CLI 的 `--version`**，用户可能在页面开着的时候 `npm i -g @openai/codex`，30s TTL 是为这个场景服务的。

### 精简判断

`detectRows` **不是过度设计，不建议删**。但有两点可以收敛：

1. **TTL 应提取为可配置项**。官方 AGENTS.md 明写「**No hardcoded tunables in plugins**」：`deployment-varying choices are validated Config fields changeable from cordis.yml; a DEFAULT_* constant or test hook is not configurability`。`DETECT_TTL_MS = 30_000` 是硬编码的部署策略，按官方规范应进 `src/config.js` 的 `defaults`。**但**这是 `src/config.js` 的改动，超出本任务边界，列为后续项。
2. `detectCache = { at, pending }` 这个双字段对象可以简化为一个 `{ at, pending }` 局部闭包，收益极小，**不值得动**。

**契约影响**：无（`/state` 的 JSON 结构不变）。

---

## A5. 附：`sendJson` / `sendError` / `sendRejection` 的重复

任务描述提到「三个函数都在设 header」。实测：

| 函数 | 行 | 设置 |
|---|---|---|
| `sendJson` | `:105-113` | `content-type: application/json`, `content-length`, `cache-control: no-store` |
| `sendError` | `:133-139` | **不设 header**，委托 `sendJson` |
| `sendRejection` | `:87-95` | `content-type: text/plain`, `content-length`, `cache-control: no-store` |

**`sendError` 已经复用 `sendJson`，没有重复。** `sendRejection` 必须独立，因为官方 `open-in-app` 的拒绝路径是 `res.end()` 空体（`index.ts:189`），而我方给纯文本——这是**我方更好的选择**（`tests/http.test.js:311-312` 明确断言 `content-type: text/plain` 且有 body）。为了"减少一个函数"而合并会导致拒绝响应变成 JSON 信封，**直接打破 2 个断言**。

**判决：无可合并，不动。**

---

## A6. 附：`ERROR_CODES` 的不完整（顺手发现）

`ERROR_CODES`（`:44-53`）有 8 项，但 `:585` 和 `:606` 两处仍用裸字面量：

```js
throw failure(404, String(error?.message || error), 'unknown-job')   // ×2
```

`tests/http.test.js:587` 断言 `code === 'unknown-job'`。**补一个 `UNKNOWN_JOB: 'unknown-job'` 键**是零风险的一致性修复（值不变、测试不变），但收益纯属风格。**列为可选。**

---

## A7. 附：孤儿 JSDoc（发现的真实冗余）

`src/http.js:28-34` 是一段完整的 JSDoc，描述 `rejectionFor`，但 `:35` 紧跟的是**另一个 JSDoc 的开头**（`ERROR_CODES` 的），`rejectionFor` 实际定义在 `:55` 且没有文档。

```js
/**
 * Resolve the connection trust admission result for one request, ...
 * @returns {number|undefined} rejection status, or undefined when admitted
 */
/**                                                            ← :35 孤儿
 * Stable machine-readable failure codes served by the panel.  ← ERROR_CODES 的文档
```

这是合并 `ERROR_CODES` 时把 `rejectionFor` 的文档挤掉的产物。**应把 `:28-34` 移到 `:55` 之前。纯注释移动，零行为影响。**

---

# B 节 — Client（`client.js`）

## B1. `__ModuleLoader__` 契约与 `{ inject, apply }`

### 官方契约

`dsh-client-modules/lib/types/client/manifest.d.ts:196-214`：

```ts
export interface ClientBundleRegistration {
  /** Plugin id (package name) — the registration key; must match the graph row being executed. */
  id: string
  chunk?: string
  factory: (require: ClientBundleRequire) => Record<string, unknown>
}
```

`ClientBundleRequire`（`:186-197`）三个成员：

```ts
export interface ClientBundleRequire {
  (specifier: string): unknown          // 同步
  async(specifier: string): Promise<unknown>   // 包内动态 chunk
  asset(reference: string): string
}
```

插件对象本身（`inject` / `apply`）由 **Cordis Loader** 消费，不是模块系统的要求——模块系统只要求 factory 返回一个 record，Loader 再从里面读 `apply`/`inject`。官方同级包的字面形态（`dsh-client-ui-sidebar/lib/client.js` 尾部）：

```js
exports.apply = apply
exports.inject = inject
return module.exports
```

### 我方

`client.js:1-6` + `:1292`：

```js
window.__ModuleLoader__.load({
  id: 'dsh-agent-alliance',
  factory(require) {
    const React = require('react')
    ...
    return { inject: ['slots', 'locale'], apply }
  },
})
```

### 判决：**形状正确**

- `id` 是包名 `dsh-agent-alliance` ✅（`tests/manifest-guard.test.js` 也钉死）
- factory 返回 `{ inject, apply }` ✅
- 只 `require('react')` ✅（官方 baseline seed 含 react；`dsh-client-ui-sidebar` 还 require 了 `ui-primitives`/`ui-slots`/`react/jsx-runtime`，那些都在 seed 表里）

**唯一值得记录的点**：我方用 `return { inject, apply }`（ESM 风格对象），官方构建产物用 `exports.apply = ...; return module.exports`。两者对 Loader 等价——`module.exports` 就是个普通对象。**不建议为对齐而改**，改了只是把一个字面对象拆成两行赋值。

### `immediately: true` 是否必要？

**不必要，而且是偏离。**

`dsh-client-modules/lib/index.js:729-738`：

```js
compose() {
  const entries = orderByModuleGraph([...])
  const bootstrap = PARSER_PRELOAD_IDS.map(id => this.table.get(id)).filter(...)
  const bootstrapIds = new Set(bootstrap.map(r => r.entry.id))
  const application = entries.filter(entry => !bootstrapIds.has(entry.id))...
  for (const records of partitionComboRecords(bootstrap)) artifacts.push(buildBatch("bootstrap", ...))
  for (const records of partitionComboRecords(application)) artifacts.push(buildBatch("application", ...))
```

**注意**：`bootstrap` 批次的唯一来源是 `PARSER_PRELOAD_IDS`，其定义为（`lib/index.js:512`）：

```js
const PARSER_PRELOAD_IDS = [CLIENT_MODULES_ID]   // 只有 @deepseek-ai/dsh-client-modules
```

**`dsh.client.immediately` 根本没有参与 `compose()` 的批次划分。** 它在 `lib/index.js` 里只被解析、校验（`:93`、`:800`）和写进 graph row（`:466`），没有任何执行路径读取它决定批次。

实测 11 个设了 `immediately: true` 的包全部是基础设施：`dsh-client-modules`、`dsh-client-locale`、`dsh-client-ui-renderer`、`dsh-client-ui-theme`、`dsh-client-hmr`、`dsh-client-connection`、`dsh-client-file-upload`、`dsh-api-remotes`、`dsh-api-gateway`、`dsh-typert-registry`、`dsh-experimental-inspector`。

**对照：所有 UI 特性包都不设**——`dsh-client-ui-sidebar`、`dsh-client-ui-plugin-manager`、`dsh-client-ui-schedule` 的 `dsh.client` 里**没有 `immediately` 字段**（已逐一读取 package.json 确认）。

`client.js` 的 `WebBootEntry.immediately` 文档（`manifest.d.ts:52-56`）写的是「**Stage-one prefetch mark: load the script for factory registration during module-face boot**」——语义是"提前注册 factory"，不是"parser 阻塞加载"。我方设 `true` 的唯一效果是让 factory 更早进 `pendingQueue`，对一个**用户点击才打开的面板**毫无收益，反而增加启动期 JS 体积。

**判决：应删除 `dsh.client.immediately`。** 这是纯 `package.json` 一行删除，无契约影响（`manifest-guard.test.js` 只断言 `dsh.client` 存在，不断言 `immediately`）。

---

## B2. Slots 注册选项

### 官方 register 选项全集

`dsh-client-ui-slots` 的 `BaseOptions`（见 `packages/client/ui-slots/src/index.ts` 的 `BaseOptions` 类型）：

```ts
type BaseOptions<K, EntryKey, D, H, M, N> = {
  name: K                    // 必填
  children?: D               // 声明的子槽
  store?: H                  // 声明的 store
  locale?: N                 // 字典命名空间 → 注入 t 座位
  registrant?: string        // 诊断标签
} & KindOptions<K, EntryKey, M>
```

`KindOptions` 按 cardinality 决定：

- **`main`（keyed）**：`key`（必填）、`priority`（禁止手写，facade 自动分配）
- **`sidebar.panellist`（list）**：`id`（必填）、`order`（可选，默认 0）、`label`（可选，`string | () => string`）

### 我方

`client.js:1278-1289`：

```js
ctx.slots.inject('main', () => ctx.slots.register({
  name: 'main', key: 'agent-alliance', locale: NS,
}, Panel))

ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist', id: 'agent-alliance', order: 30, locale: NS,
  label: () => t('panel'),
}, Icon))
```

### 判决：**全部合法，且 `label` 用 thunk 是官方推荐**

对照官方 `dsh-client-ui-plugin-manager/src/client/index.ts` 的侧栏注册：

```ts
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist',
  id: PANEL_ID,
  order: 0,
  label: () => t('panel'),      // ← 同样是 thunk
  locale: NS,
}, PluginsPanelIcon))
```

**逐字段一致**（除 `order` 值）。

`label: () => t('panel')` 的 thunk 形式有官方文档支撑（`ui-slots/src/index.ts` 的 `resolveSlotLabel`）：

> `Display text where the owner projects one (nav rows, tabs). A thunk is re-read on every projection, so localized text follows the active locale without re-registering.`

**`order: 30` 的偏离是合理的**：官方 shipped 占用者是 `plugins`（order 0）与 `schedules`；我方 30 排在它们之后，符合"第三方面板靠后"的直觉。**不是问题。**

**唯一可选改进**：`ctx.slots.inject('main', ...)` 与 `ctx.slots.inject('sidebar.panellist', ...)` 是两次独立注册，官方 `ui-plugin-manager` 用**生成器**把多个贡献装进同一个事务：

```ts
ctx.slots.inject('main', function* () {
  yield ctx.slots.register({...}, PluginManagerPage)
  yield ctx.layout.panelInfo.subscribe(...)
  yield () => { void disposeNavigation() }
})
```

我方两个注册分别属于两个不同 slot 的 inject，**本来就该分开**（`inject` 的回调在各自声明存活期独立运行）。**不需要合并。**

**契约影响**：无。`tests/manifest-guard.test.js` 断言 `name`/`key`/`locale`/`id`/`order`/`label` 的类型，全部保持。

---

## B3. i18n —— 走了 `ctx.locale`，但多了一个不该有的兜底

### 官方要求

`packages/client/AGENTS.md`（Styling and localization 节）：

> Every product-visible string—including text, accessibility names, tooltips, placeholders, status/unit formatters, and primitive chrome—lives in a typed locale dictionary and reaches components through the standard `t` seat or an already-localized prop.

`verify-client-ui-i18n` 是源码级 gate，检查的是 `packages/client/` 下的 `.tsx`。**它是仓库内 gate，对我们这个外部插件不运行。**

### 我方实际实现

`client.js:1269-1270`：

```js
const t = ctx.locale.bind(NS)
ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'agent-alliance: dictionaries')
```

`DICT` 是 `client.js:20-240` 的手写字典（zh 105 键 / en 105 键，键集完全一致）。

### 判决：**做法正确，不是偏离**

- 走 `ctx.locale.register(NS, { zh, en })` ✅ —— 与官方 `dsh-client-ui-sidebar` 完全同构（它也是 `ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, ... }), ...)`，字典**内联在 client.js 里**，不是外部 JSON）
- 用 `ctx.locale.bind(NS)` ✅
- `locale: NS` 传给 slot 注册 ✅ —— 这让渲染器把 `t` 座位注入组件 props
- zh/en 键集一致 ✅ —— 官方 `register` 的双语形式在注册时会校验完整性

**「手写字典」不是问题**：官方就是手写内联的。`locale/en.json` / `locale/zh.json` 是**另一件事**——包级 `meta.title`/`meta.description`，用于插件市场的卡片展示（`dsh-client-ui-sidebar/locale/en.json` 只有一个 `{"meta":{"title":"ui-sidebar"}}`）。两者互不替代。

### 真正的问题：`localize()` 兜底是死代码

`client.js:334-345`：

```js
/** Local dictionary fallback: the slot renderer normally supplies `t`. */
function localize(key, params) { ... }

// client.js:1221
const t = props.t !== undefined && typeof props.t === 'function' ? props.t : localize
```

注释自己写了「the slot renderer normally supplies `t`」。而 `client.js:1278-1282` 的 `main` 注册**明确带了 `locale: NS`**，`ui-slots` 的 `BaseOptions.locale` 文档写：

> Declaring it puts the framework-synthesized `t` seat (typed to the namespace's dictionary union) on the component props; **rendering requires an installed locale face — fails loud otherwise.**

即：**`t` 座位要么存在，要么渲染失败，不存在"缺失"的第三种情况。** 所以 `localize` 这个 12 行的降级路径永远不会被执行。

**判决：`localize()` 可以删除**（12 行）。同时 `Panel` 里的三元退化为 `const t = props.t`。

**但注意顺序**：必须先确认 `DICT` 仍然被 `apply` 里的 `ctx.locale.register` 引用（是的，`:1270`），否则删 `localize` 不会影响字典本身。

**契约影响**：无（内部函数，不导出）。

---

## B4. 1294 行的构成，以及"外置"是否可行 —— **这是本节最重要的结论**

### 四块拆分

| 块 | 行范围 | 行数 | 占比 |
|---|---|---|---|
| 样式（CSS 模板字符串） | 241-332 | 92 | 7.1% |
| 字典（DICT zh+en） | 19-240 | 222 | **17.2%** |
| 组件（5 个 tab + primitives + panel + icon） | 509-1266 | 758 | **58.6%** |
| 数据流（helpers + hooks：request/useLoad/useJobOutput/格式化） | 333-508 | 176 | 13.6% |
| 插件对象（apply + slots 注册） | 1-18, 1267-1294 | 46 | 3.6% |

（合计 1294，四舍五入误差在第 18 行 banner。）

按 tab 细分：state 57 / sessions 180 / dispatch 129 / roundtable 162 / tasks 124。

### 官方 client-module 契约**允许**多文件吗？

**允许，而且有两套官方机制。**

#### 机制 1：`require.async('./client.<name>.js')` —— 包内动态 chunk

`dsh-client-modules/lib/types/client/manifest.d.ts:186-197` 的 `ClientBundleRequire.async`：

```ts
/** Load and resolve a package-local dynamic chunk asynchronously. */
async(specifier: string): Promise<unknown>
```

浏览器实现（`lib/client.js`，`makeRequire`）：

```js
require.async = async spec => {
  edges.add(spec)
  if (!spec.startsWith('./')) return await this.import(spec)
  const fileName = spec.slice(2)
  if (!CLIENT_CHUNK.test(fileName)) throw new Error(`invalid relative chunk request ...`)
  return await this.importChunk(ownerId, fileName)
}
```

`CLIENT_CHUNK` 的约束（`lib/index.js:198`）：

```js
const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/
```

即 **chunk 文件名必须是 `client.<something>.js`**。

Host 侧如何找到这个文件？`chunkResponse`（`lib/index.js`）：

```js
const clientPath = join(dirname(record.meta.clientPath), fileName)
if (!existsSync(clientPath)) return void 0
```

**关键**：`dirname(record.meta.clientPath)` —— chunk 必须和 `exports["./client"]` 指向的 **`client.js` 同目录**。

#### 机制 2：`dsh.client.external` —— 跨包模块图边缘

`manifest.d.ts:52-56`（`WebBootEntry.inject`/`external` 的文档）：

> `external` carries exact non-inject module requests

这是**跨包**的，不解决包内拆分。

### 结论：**外置是可行的，但只有一条路径**

| 方案 | 可行性 | 代价 |
|---|---|---|
| 拆成 `client.chunks.js` 等 sibling 文件 + `require.async` | ✅ 官方支持 | 必须是 **异步**（`await require.async(...)`），组件树要处理 loading；文件名必须 `client.*.js`；必须在 `files` 里 |
| 拆成普通 `import`（ESM） | ❌ **不可行** | factory 是 CJS 闭包，`require` 只认 module table；ESM `import` 在 bundle 里不存在 |
| 拆成 `src/` 下的 .js 再打包 | ❌ 当前构建流程不打包 | 没有 tsdown/rollup；`files` 里是裸文件 |
| 字典挪到 `locale/*.json` 再用 fetch 读 | ❌ 破坏性 | `ctx.locale.register` 是同步 API，`fetch` 是异步；且官方就是内联字典 |

**所以 Lead 的问题「如果 exports 只暴露 `./client`，拆文件后怎么引用？」的答案是：**

> `package.json` 的 `exports` **只影响 Host 侧如何定位 `client.js` 这一个文件**（`clientExportOf` 读 `exports["./client"]`）。**chunk 不走 exports**——Host 直接按 `dirname(clientPath) + '/' + fileName` 拼路径读文件（`chunkResponse`）。所以拆文件**不需要**给 `exports` 加条目，只需要：①文件名匹配 `client.*.js`；②和 client.js 同目录；③进 `files` 数组。

### 建议的外置方案（按收益排序）

1. **字典（222 行，17.2%）→ 不值得外置。**
   原因：`ctx.locale.register` 是同步调用，外置只能靠 `require.async` 变成异步，会让"插件 apply"变成"apply 里 await"，与 Cordis 的同步 apply 契约冲突。**保持内联是官方做法。**

2. **样式（92 行，7.1%）→ 可选。**
   `require.async('./client.styles.js')` 返回 CSS 字符串，但它同样要把 apply 变异步。**不划算。**

3. **组件（758 行，58.6%）→ 收益最大，但需要真正异步。**
   把 5 个 tab 各自拆成 `client.tab-state.js` / `client.tab-sessions.js` / …，`Panel` 用 `React.lazy` + `require.async` 按需加载。**这是唯一能实质降低首屏体积的方案**，但代价是：每个 tab 要包一个 Suspense 边界、新增 loading 态、`Panel` 的切换逻辑变复杂。**对一个点击才打开的面板，收益不抵复杂度。**

4. **数据流（176 行，13.6%）→ 与组件同进退，不建议单独拆。**

### 我的建议：**不拆**

理由（证据支撑）：

- **官方同类包也是单文件**：`dsh-client-ui-sidebar/lib/client.js` 是 **25,825 字符**的单 bundle（含 CSS、7 语言字典、十几个组件）；`dsh-client-ui-plugin-manager` 同理。官方没有因为"文件大"而拆 chunk。
- **`require.async` 是给"重依赖按需加载"的**（官方文档：`Load, register, and materialize one package-local dynamic chunk`），不是给"代码组织"的。
- **拆分不改变任何功能性指标**：1294 行里 758 行是 JSX 结构，拆成 5 个文件后总行数不变，只是分散。
- **真正的可维护性问题不是行数，是 `Panel` 的 tab 分发**（`client.js:1222-1228` 的五层嵌套三元）。改成一张 `{ state: StateTab, ... }` 映射表即可，**10 行改动，收益大于拆分**。

**如果 Lead 仍要求外置**，唯一可行的最小方案是：把 5 个 tab 拆成 `client.tab-<name>.js`，`Panel` 用 `require.async` + `React.lazy`。我可以给出 patch，但需要 Lead 明确接受"apply 仍同步、组件层异步"的复杂度。

### 契约影响

**拆分会动 slot 注册形状吗？** 不会——`apply` 仍然注册同样的 `{name, key, id, order, locale, label}`。`tests/manifest-guard.test.js` 的断言全部基于 `client.js` 文本（`__ModuleLoader__.load`、id 字符串、`apply`），拆分后 **`manifest-guard.test.js` 需要新增 chunk 断言**（否则守卫看不到新文件）。**这是拆分唯一的额外成本。**

---

## 精简清单

### 可删（零契约风险）

| # | 位置 | 内容 | 行数 |
|---|---|---|---|
| D1 | `client.js:334-345` | `localize()` 死代码 + `Panel:1221` 的三元退化 | -12 |
| D2 | `package.json` `dsh.client.immediately` | 官方 UI 特性包都不设，且 `compose()` 不读它 | -1 |

### 可合并（零契约风险）

| # | 位置 | 内容 |
|---|---|---|
| M1 | `src/http.js:28-34` | 孤儿 JSDoc 移到 `:55` 的 `rejectionFor` 之前 |
| M2 | `src/http.js:585,606` | 裸字面量 `'unknown-job'` → `ERROR_CODES.UNKNOWN_JOB` |
| M3 | `client.js:1222-1228` | 五层三元 → 映射表 `{ state: StateTab, ... }` |

### 可修（零契约风险，推荐做）

| # | 位置 | 内容 |
|---|---|---|
| F1 | `src/http.js:165` | 超限时补 `req.resume()`，避免 socket 截断 |

### 应改但**会动契约**（单列，不在精简任务内）

| # | 位置 | 改动 | 风险 |
|---|---|---|---|
| C1 | `src/http.js:25` | `MAX_BODY_BYTES` 1 MiB → 64 KiB | 无测试覆盖，**安全**，但属行为变更 |
| C2 | `src/http.js:178` | 超限 400 `bad-body` → 413 `payload-too-large` | **新增状态码 + 新 code**，对外契约 |
| C3 | `src/http.js:333` | `DETECT_TTL_MS` 硬编码 → `config.defaults.detectTtlMs` | 触及 `src/config.js`，超出边界 |

---

## 保留的对外契约清单（**任何改动都不得触碰**）

### HTTP 状态码

| 场景 | 状态码 |
|---|---|
| 成功 | `200` |
| 方法不匹配 | `405` + `allow` header |
| 未知路由 | `404` |
| 非法 URL | `400` |
| body 超限 / 非法 JSON / 缺字段 | `400` |
| 派发失败 | `502` |
| jobs 服务缺失 / 拒绝 | `503` |
| job 不存在 | `404` |
| 信任拒绝 | `401` / `403` / `503`（纯文本） |

### 错误 `code` 值（8 + 1 个裸字面量）

`method-not-allowed`、`bad-url`、`bad-body`、`missing-field`、`not-found`、`dispatch-failed`、`jobs-unavailable`、`jobs-refused`、`unknown-job`

### 响应 JSON 结构

- 成功：`{ ok: true, ... }`
- 失败：`{ ok: false, error: string, code?: string }`
- 信任拒绝：**纯文本**，`content-type: text/plain`，JSON body 为 `undefined`

### 各路由的 payload 字段

| 路由 | 字段 |
|---|---|
| `/state` | `providers[{id,label,kind,available,detail?}]`、`recentDispatches[]` |
| `/sessions` | `total`、`sessions[{provider,id,title,cwd,createdAt,imported}]`、`scanned[]`、`failed?[]` |
| `/session-content` | `content{title?,messages[]}` |
| `/import` | `result{status,dshSessionId?,turns?,reason?}` |
| `/dispatch` | `provider`、`backend`、`text`、`stopReason`、`externalSessionId`、`durationMs` |
| `/roundtable` | `jobId`；无 jobs 服务时 `{jobId:null,text}` |
| `/tasks` | `tasks[{id,kind,label,status,owner?,progress?,detail?,startedAt,finishedAt?}]` |
| `/tasks/output` | `chunks[]`、`next`、`lossy`、`job` |
| `/tasks/kill` | `outcome` |

### 路由注册形状

`kind: 'prefix'`、`path: '/__agent-alliance'`、单个 `handler`、`routes.length === 1`

### Slot 注册形状

`main`: `{name:'main', key:'agent-alliance', locale:'agentAlliance'}`
`sidebar.panellist`: `{name:'sidebar.panellist', id:'agent-alliance', order:30, locale:'agentAlliance', label:()=>t('panel')}`

---

## 附：本次审计的验证基线

```
$ node --test tests/http.test.js
ℹ tests 34   ℹ pass 34   ℹ fail 0
```

（任务描述里的"31 个测试"是旧数字；当前 `tests/http.test.js` 实为 **34** 个 test，全部通过。）
