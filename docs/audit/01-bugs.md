# 审计 A — 缺陷、竞态、资源泄漏、错误路径

**对象**：`dsh-agent-alliance` 0.2.0 @ `e15fcf8`
**方式**：只读取证 + **用真实对象跑竞态脚本**（不是读代码猜测）。凡标注「实测」的都有可复现脚本。

> 说明：本条线原指派给团队成员，两次运行均被网络中断杀死且无落盘。为不拖住整体交付，
> 由 Lead 亲自补齐。因此覆盖广度弱于其他四条线，但关键路径（信号量竞态、监听器泄漏、
> 子进程回收、静默 catch 分类）都做了**实测**，不是纯静态阅读。

## 结论摘要

| 严重度 | 数量 |
|---|---|
| critical | 0 |
| high | 1 |
| medium | 2 |
| low | 2 |

**总体判断**：并发与资源管理这部分写得比我预期扎实——我最担心的三类竞态（排队取消、
同步抛错后槽位泄漏、监听器悬挂）**实测全部正确**。真正的问题集中在一处：**已中止的
signal 没有被前置检查**，导致取消可能白干一次真实的外部调用。

---

## F1 (high) — 已中止的 signal 不会阻止工作启动，取消形同虚设

**位置**：`src/tools.js:75-79`（信号量快路径）+ 所有 dispatch 入口

**代码**：

```js
entry.onAbort = onAbort
if (active < limit) {
  active += 1
  entry.begin()        // ← 完全不看 signal.aborted
  return
}
queue.push(entry)
if (signal) {
  if (signal.aborted) onAbort()      // ← 只有「排队」分支才检查
  else signal.addEventListener('abort', onAbort, { once: true })
}
```

**实测**（`semaphore-race2.mjs`，用插件真实的 `createSemaphore`）：

```
race5 pre-aborted+free slot -> "work executed" | work ran: true
race6 abort-during-run      -> "saw abort"
```

即：**把一个已经 abort 的 signal 传给有空位的闸门，工作照样执行**。

**为什么这是 high 而不是 low**：`begin()` 里立即调用 `fn()`，而 `fn` 是
`() => backend.dispatch({...})`。backend 的 `dispatch` 前置只有：

```js
// src/backend.js:185-193 / :224-232
async dispatch(request = {}) {
  const result = await provider.dispatch({ ..., signal: request.signal })   // 直接下传
```

全仓 grep `throwIfAborted` **零命中**。所以一次"已经取消的派发"仍会：
- CLI 路径：`spawn` 一个真实子进程（随后被 signal 杀掉，但进程创建、CLI 启动开销已发生）
- 官方子代理路径：`startActivation` 会 spawn Codex/Claude 进程并跑 `initialize` 握手

用户按了取消，仍然付一次启动成本。这与 C3（`resumeSessionId` 守卫后置）是同一类问题的两个面：
**可提前判定的失败条件没有前置到副作用之前**。

**修复**（两行，两处都加）：

```js
// src/tools.js createSemaphore.run 开头
if (signal?.aborted) return Promise.reject(new Error('aborted before start'))

// src/backend.js 两个 dispatch 的 await 之前
request.signal?.throwIfAborted()
```

**为什么现有测试没抓到**：`tests/tools.test.js` 覆盖了"排队中取消"（我在 race1/race2 复现了，
那条路径是正确的），但**没有覆盖"有空位时传入已中止的 signal"**。补这条测试即可防回归。

---

## F2 (medium) — 子进程 `/tmp` 硬编码与 Termux 假设在非 Termux 环境静默错配

**位置**：`src/provider/claude.js:24-30`、`codex.js:20-24`、`opencode.js:16-22`、`zcode.js`

四个 provider 的默认路径全部以 `process.env.PREFIX || '/data/data/com.termux/files/usr'` 为基准。
在本机（普通 Linux，无 `$PREFIX`）实测：

```
$ node -e "buildProviders(...).detectAll()"
   claude     available=false spawn /data/data/com.termux/files/usr/bin/grun ENO...
   codex      available=false Function.executeUserEntryPoint ...
   opencode   available=false spawn /home/dsh/.local/share/xucodex/opencode/bin/...
   zcode      available=false 未配置 commandTemplate
```

claude 与 opencode 报的是 **Termux 路径不存在**，而不是"这台机器没装 claude"。
用户看到的是误导性的诊断。

**这不是崩溃**（`detect()` 优雅返回 unavailable，`dispatch()` 会抛清晰错误），
所以是 medium。但它与 [C2](../00-REPORT.md) 叠加后危害放大：状态页本来就谎报可用，
连真实的失败原因都被 Termux 路径掩盖了。

**修复**：默认改为「按命令名探测 PATH」优先，显式路径作为覆盖项；Termux 前缀只在
`process.env.PREFIX` 存在时启用。这同时是 `docs/ROADMAP.md` 里已登记的技术债。

---

## F3 (medium) — `provider/*.js` 里 20+ 处静默 catch，其中部分是真实故障的掩体

**位置**：`src/provider/claude.js:84,86,92,96,121,126` 等，四个 provider 合计 20+ 处

已分类：

| 类别 | 例子 | 判定 |
|---|---|---|
| (a) 合法可选 | `readdirSync(projectsRoot)` 失败 → 空列表 | ✅ 正确：目录不存在就是没有会话 |
| (a) 合法可选 | 单行 `JSON.parse` 失败 → 跳过该行 | ✅ 正确：损坏行不应污染整个列表 |
| (b) 可能掩体 | `readFileSync(file)` 失败 → 返回空（`:126`） | ⚠️ 权限错误与文件不存在被混为一谈 |

(b) 类的危害：如果会话文件因权限问题读不到，用户看到"这个会话是空的"而不是"读不了"。
这会把环境问题伪装成数据问题。

**修复**：区分 `ENOENT`（→ 空，合理）与其他错误（→ 上报）。约 10 行。

---

## F4 (low) — `lossless()` 把 `undefined` 静默变成 `null`

**位置**：`src/tools.js:25-27`

```js
function lossless(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}
```

`JSON.stringify(undefined ?? null)` → `"null"`。所以任何 `undefined` 字段都会变成 `null`
出现在 tool result 里。对 `externalSessionId` 这类可选字段，语义上 `null` 与"缺失"不同，
模型可能据 `null` 做出"有会话但没有 id"的错误推断。

**修复**：先剔除 `undefined` 键再做 JSON 往返，而不是整体 coalesce 成 `null`。低优先级。

---

## F5 (low) — 面板 `/roundtable` 在一次 jobs 抛错时返回 500 而非降级

已在 [C1](../00-REPORT.md) 记录根因。此处单列是因为**表现不同**：工具路径有
`if (jobId === undefined) return dispatchForeground(...)` 兜底，而 `src/http.js:434`
直接 `jobs.start(...)`，抛错后被外层 catch 成 `500 dispatch-failed`。

面板用户看到的是"圆桌失败"而不是"后台不可用，已改为前台执行"。
C1 修好后此条自动消失。

---

## 已检查且干净的部分（实测，非推断）

| 检查项 | 方法 | 结果 |
|---|---|---|
| 排队中取消 | `semaphore-race.mjs` race1/race2 | ✅ 立即出队并 reject，不占槽 |
| 取消后槽位是否泄漏 | race3 | ✅ 后续任务正常获得槽位 |
| `fn` 同步抛错后槽位 | race4 | ✅ 抛出正确，槽位释放 |
| abort 监听器悬挂 | race7（`getEventListeners`） | ✅ 中止后监听器数 = 0 |
| `settle` 双重结算 | `src/runner.js:47-51` 静态 + 只读 | ✅ `settled` 标志守卫，`close`/`error` 都过它 |
| 子进程 abort 回收 | `src/runner.js:54-57` | ✅ `onAbort` 里 `child.kill('SIGKILL')` |
| 超时回收 | `src/runner.js:64-70` | ✅ 定时器内 SIGKILL，且 `settle` 里 `clearTimeout` |
| 子进程永不 reject | `src/runner.js:29-31` 契约注释 + 实现 | ✅ 失败也 resolve 成结果对象，不会逃逸成未处理拒绝 |
| 导入 handle 关闭 | `src/importer/persist.js` try/finally | ✅ `close` 在 finally，append/flush 失败也关 |
| 台账原子写 | `src/importer/persist.js:50-58` | ✅ 临时文件 + rename，清理失败不掩盖原始错误 |
| 工具 execute 抛错的归宿 | 见 [02-framework.md](02-framework.md) F4 | ✅ 被框架转为结构化 `isError`，不是未处理拒绝 |

## 未能完成的检查

- **SQLite 句柄生命周期**（`provider/opencode.js`、`provider/zcode.js` 的 `node:sqlite`）：
  未做真实的打开/查询/关闭路径实测。静态阅读显示有 `db()` 惰性打开，但**未验证异常路径是否关闭**。
  这是本报告最大的覆盖缺口。
- **并发导入竞态**：两个 `agent_import` 同时写同一台账未实测（代码用固定 tmp 名 + rename，
  理论上第二次 rename 会覆盖而非损坏，但未验证）。
- **长时间运行的进程泄漏**：未做 soak test。

如需补齐，建议优先 SQLite 句柄这一条——它是唯一可能真正泄漏系统资源的地方。
