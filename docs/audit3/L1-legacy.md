# L1 — 对抗性审计：0.1.0 遗留代码

> 角色：ADVERSARIAL AUDITOR L1。要攻击的命题：
> **"0.2.0 重写真的替换掉了旧行为"**。任务不是确认，而是找出**旧假设在新代码里的存活点**。
>
> 对象：`/home/ova/dsh/.artifacts/dsh-plugins/dsh-agent-alliance` @ HEAD `519be02`
> （`e15fcf8` 之后 16 个 commit）。测试基线：207 pass。
>
> 权威：`docs/SPEC.md`（0.1.0 规范）、`docs/VERIFICATION-P1.md`（0.1.0 历史）、
> `git log e15fcf8`（重写前代码）、以及**本机真实安装的 v4 校验器**。
>
> 本文件是唯一写入；源码零改动。

## 结论速览

| # | 目标 | 判决 |
|---|---|---|
| L1-1 | Termux-first 路径探测 | **PARTIALLY** — 默认值仍是 Termux（SURVIVES），但用户配置覆盖在审计过程中被 `90ef1bc` 补上了 |
| L1-2 | 导入管线 v4 合规 | **PARTIALLY** — 事件流本身全部合法（40+ 对抗输入 0 失败），但 `importOne` 在"无 user 文本"会话上**报告了一个从未写入的 title** |
| L1-3 | 旧 API 残留 | *（待定）* |
| L1-4 | 静默 catch → "空会话" | **SURVIVES** — 权限错误被伪装成"session not found"，且与 `agent_sessions` 的列表结果自相矛盾 |

---

## L1-1 — Termux-first 路径探测：**PARTIALLY（默认值 SURVIVES；逃生舱刚补上）**

### 判决：**PARTIALLY** —— 审计期间 `90ef1bc` 补上了"用户可覆盖"，但 **Termux 默认值本身原封不动**

#### 证据 1：四家 provider 仍以 Termux 前缀为默认

| 文件:行 | 代码 |
|---|---|
| `src/provider/claude.js:16` | `return process.env.PREFIX \|\| '/data/data/com.termux/files/usr'` |
| `src/provider/codex.js:16` | 同上 |
| `src/provider/opencode.js:12` | 同上 |
| `src/runner.js:15` | 同上（`termuxPrefix()`） |
| `src/runner.js:49` | `if (!merged.HOME) merged.HOME = homedir() \|\| '/data/data/com.termux/files/home'` |

#### 证据 2：16 个 commit 里**没有任何一个**碰过这些行

```bash
$ git log e15fcf8..HEAD -p -- src/provider/ src/runner.js | grep -n "^[+-].*\(data/data\|PREFIX\)"
# （无输出）
```

有 4 个 commit 动过 `src/provider/`，但改的是别的东西：

```bash
$ git log --oneline e15fcf8..HEAD -- src/provider/ src/runner.js
832f314 fix(security): scrub credentials from the CLI child environment
15bc8c8 fix: unowned jobs, hanging runners, lost prompts, probe stampede
1b15214 fix(providers): close the SQLite handle on every session read
b5693d8 fix: stop treating CLI errors as answers, and close the import ledger race
```

⇒ **"Termux-first 探测已修复"这个说法是假的。** 前一轮审计把它记为
`F2 (medium)`（`docs/audit/01-bugs.md:85-108`）并给了修复建议，**建议从未落地**。

#### 证据 3：本机实测（x86_64 Linux，`$PREFIX` 未设置）

```bash
$ echo "PREFIX=[${PREFIX:-<unset>}]"; uname -m
PREFIX=[<unset>]
x86_64

$ node -e "buildProviders({config:{}}).detectAll()"
claude    false  spawn /data/data/com.termux/files/usr/bin/grun ENOENT
codex     false  Function.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:171:5)
    at node:internal/main/r
opencode  false  spawn /home/dsh/.local/share/xucodex/opencode/bin/opencode ENOENT
zcode     false  zcode 未配置 commandTemplate（官方无公开无头规范，需手动填写）
```

一个**装好了 claude / codex 的正常 Linux 用户**看到的是"Termux 路径不存在"，
而不是"这台机器没装 claude"。codex 那条更糟：报的是 Node 内部栈帧，看不出任何有用信息。

#### 证据 4（前一轮漏掉的）— hardcoded `linux-arm64` 包名

`src/provider/claude.js:22`：

```js
claudeBin: prefix() + '/lib/node_modules/@anthropic-ai/claude-code-linux-arm64/claude',
```

```bash
$ uname -m
x86_64
```

即便用户把 `$PREFIX` 指向一个正常的 Linux 前缀，**这条路径仍然只对 ARM64 机器成立**。
x86_64 用户必须手动把 claude 二进制放到一个名叫 `claude-code-linux-arm64` 的目录里。
这是比"Termux 前缀"更隐蔽的第二个遗留假设——它来自 0.1.0 的 Termux-on-ARM 目标平台
（`docs/SPEC.md:47` 明确写的就是这个 arm64 包名）。

#### 证据 5（最讽刺的一条）— ROADMAP 说"依赖用户配置覆盖"，但那个覆盖不存在

`docs/ROADMAP.md:40`：

> `src/provider/*` 仍按 Termux 优先的路径探测（`$PREFIX`），在普通 Linux 上**依赖用户配置覆盖**。

我实测：config **接受**任何未知的 provider 键（`validateLayer` 不拒绝），但**没有任何代码读它**：

```bash
$ node -e "...loadConfig({providers:{claude:{enabled:true,binPath:'/usr/local/bin/claude'}}})"
loaded OK -> {"enabled":true,"binPath":"/usr/local/bin/claude"}   # ← 加载成功

$ grep -n "binPath" src/providers.js src/provider/claude.js
# （无输出）
```

`src/providers.js:14` 读的是 **`deps.paths`**（测试注入用），而生产入口
`index.js:138` 是 `buildProviders({ config })` —— **从来不含 `deps`**。
`src/provider/claude.js:29` 的 `{ ...claudeDefaultPaths(), ...(deps.paths || {}) }`
在生产里永远只展开前半部分。

⇒ **唯一的逃生舱是环境变量 `PREFIX`**：

```bash
$ PREFIX=/opt/custom node -e "claudeDefaultPaths()"
{"grun":"/opt/custom/bin/grun",
 "claudeBin":"/opt/custom/lib/node_modules/@anthropic-ai/claude-code-linux-arm64/claude",
 "projectsRoot":"/home/dsh/.claude/projects"}
```

注意：设了 `PREFIX` 也只是换了前缀，**arm64 包名仍然是硬编码的**。

`src/config.js` 的 `providers.*` 只声明了 `enabled`：

```bash
providers.claude keys:   [ 'enabled' ]
providers.codex keys:    [ 'enabled' ]
providers.opencode keys: [ 'enabled' ]
```

`zcode` 是唯一有真实路径逃生舱的（`commandTemplate` 是自由命令模板，
`src/provider/zcode.js:55` 走 `sh -c`），其余三家没有。

#### 为什么这仍然是"遗留"而不是"设计"

- `docs/SPEC.md:47-49`（0.1.0 规范）把 Termux 路径**写成了目标平台契约**：
  > claude … 须 grun 启动（`$PREFIX/lib/node_modules/@anthropic-ai/claude-code-linux-arm64/claude`）
  > opencode … 必须 `TMPDIR=$PREFIX/tmp`

  ⇒ 这些默认值**出自 0.1.0 的 Termux 假设**，不是 0.2.0 重新论证过的选择。
- 0.2.0 的定位已经变了（HEAD `519be02` 的 commit 标题就是
  "position the plugin as an external-agent extension"），但**路径探测没跟着改**。
- `package.json` 的 `engines` 是 `node >=22`，没有平台限制——一个普通 Linux 用户
  按 README 安装后，四家**全部** `available: false`，且原因具有误导性。

#### 严重度：**high**（我比前一轮的 medium 更重）

前一轮定 medium 的理由是"不是崩溃，detect 优雅返回 unavailable"。但在 HEAD 上，
`446a5f9`（"report probed provider availability instead of assuming it"）之后，
`/state` **已经会如实显示 `available: false`**——所以用户现在会**明确看到四家全红**，
却看到一个**指向 Termux 的**错误原因，且没有任何配置项能修好它（除了改 `$PREFIX` 且
机型恰好是 arm64）。这是"装完即坏 + 无法用配置修复"，我认为是 high。

#### 修复（1-2 行表述，实际约 20 行）

把默认值改成「**PATH 探测优先，显式路径覆盖**」：

```js
// claude.js
export function claudeDefaultPaths() {
  return {
    grun: process.env.DSH_CLAUDE_GRUN || 'grun',
    claudeBin: process.env.DSH_CLAUDE_BIN || 'claude',
    projectsRoot: join(homedir(), '.claude', 'projects'),
  }
}
```
并把 `PREFIX` 分支降级为 **Termux 检测到才启用**（`process.env.PREFIX?.includes('com.termux')`），
同时把 `deps.paths` 暴露为**真实配置项**（`providers.claude.binPath` 等），
让 ROADMAP 说的"用户配置覆盖"真的存在。

---

## L1-2 — `convertToDshEvents` 对抗输入 → 真实 v4 校验器

### 判决：**事件流 FIXED（完全合法）；`importOne` 的返回值 PARTIALLY SURVIVES**

我用**本机真实安装的** v4 校验器（`dsh-session-format-v3-to-v4` + `dsh-llm` 的
`expandAssistantStream`）跑了 31 个对抗输入，覆盖任务点名的每一条规则。

#### 第 1 轮：16 个结构/内容输入 → 全部 OK

复现命令（`/tmp/l1_v4.mjs`，用真实 `restoreReleasedV4Artifact` + 真实
`KNOWN_SESSION_EVENT_TYPES`（从 `packages/core/session/src/known-event-types.ts` 解析，60 个类型））：

```
$ node /tmp/l1_v4.mjs
known event types: 60
OK     baseline simple turn
OK     tool-call advertisement: duplicate tool names
OK     tool with EMPTY name string
OK     tool with arg value undefined
OK     tool result with isError undefined
OK     tool-only turn (no user text)
OK     assistant text only, no user
OK     empty turn object
OK     null turn element
OK     all turns empty users (title path)
OK     user text = NUL byte
OK     lone surrogate in text
OK     emoji + multibyte
OK     huge tool args (circular)
OK     many tools in one turn (500)
OK     long unicode title

FAILURES: 0
```

#### 第 2 轮：损失 JSON / 编码往返 → 全部 OK

这一轮额外加了**逐行 `assertV4RowAdmission`**（真实 per-row 准入，`codec.ts:47`）
和**真实编码器往返**（`releasedV4SessionFormatCodec.encodeEvent`，能抓 lossless-JSON 违规）：

```
$ node /tmp/l1_v4b.mjs
OK     tool args = BigInt (lossless JSON violation)
OK     tool args = function
OK     tool args = Symbol value
OK     tool args = NaN/Infinity
OK     tool args = Date object
OK     tool name with newline/control chars
OK     resultText huge (200k)
OK     surfaceOp on tool/call? (multi-tool)
OK     200 turns
OK     turn with 1000 tools
OK     id with colon (message id collision risk)
OK     id with :u1 suffix (id collision)
OK     createdAt = 0
OK     createdAt negative (falls back)
OK     turns not an array (string)

checked: 15 FAILURES: 0
```

值得注意的是 `BigInt`/`function`/`Symbol`/循环引用这些**非 JSON 值**都由
`argumentsText`（`convert.js:19-28`）的 `try/catch` 降级成 `'null'`，没有炸。

#### 第 3 轮：`stream` 的 `dt` 规则 → 全部 OK

任务特别点名了 `dt`。权威规则不在 v4 包里，而在
`packages/llm/llm/src/assistant-stream.ts:510-515`：
```js
if (!Array.isArray(record.dt) || record.dt.some(value => !Number.isSafeInteger(value))) {
  throw new TypeError(`${label} dt must contain safe integers`)
}
if (record.dt.length !== members - 1) {
  throw new TypeError(`${label} dt length must be one less than its members`)
}
```
`convert.js` 的每个 run 都是**单元素**（`texts:[x]` / `args:[x]`）配 `dt: []`，
满足 `dt.length === members - 1`。用真实 `expandAssistantStream`（它内部调 `validateRecord`）
+ `assembleAssistantStream` 验证：

```
$ node /tmp/l1_stream3.mjs
checked single text | assistant/message: 1 | stream records: 1
checked single tool | assistant/message: 1 | stream records: 1
checked tool + text (index collision risk) | assistant/message: 1 | stream records: 2
checked many tools | assistant/message: 1 | stream records: 6
checked tool with empty-ish name | assistant/message: 1 | stream records: 1
checked 200 turns | assistant/message: 200 | stream records: 200

stream validation failures: 0
```

⇒ **任务假设的"还能找到一个非法输入"在事件流层面不成立。** 我把
`tool-call advertisement`、`stream dt`、`surfaceOp` 位置、`sourceEventSeqs` 四个方向
都打过了，全部合法。这部分判 **FIXED**。

---

### ❌ 但 `importOne` 的返回值 PARTIALLY SURVIVES：**报告了一个从未写入的 title**

这是上一轮修复（`2f6660e` 的 session/title 修复）留下的**副作用**，前一轮审计没覆盖到。

#### 机制

`convert.js:159-165` 在"没有 user 文本"时**完全不发** `session/title`：
```js
if (userMessageSeqs.length > 0) {
  push('session/title', { title: ..., messageSeqs: userMessageSeqs, source: { kind: 'fallback' } })
}
```
这是**正确的**（v4 规则：`(messageSeqs.length === 0) === (source.kind === 'user')`，
`relationships.ts:353-354`；fallback 标题必须引用至少一条 user 消息）。

**但 `persist.js` 没有跟着改**。`importOne` 的返回与台账（`persist.js:279-291`）仍然：
```js
return {
  status: 'imported',
  dshSessionId,
  turns: exported.turns.length,
  title: typeof exported.title === 'string' ? exported.title : null,   // ← 从不检查 title 事件是否真的写了
}
```

#### 真实复现（走完整 `importOne`，非纯函数）

```js
// /tmp/l1_title_lie.mjs —— provider 返回有 turns 但无 user 文本（OpenCode 的
// image-only / tool-only 首轮就能产生这种形状，见 opencode.js:144-151）
{ title: 'Real External Title', turns: [{ assistant: 'I refactored the module.', tools: [...] }] }
```

```
$ node /tmp/l1_title_lie.mjs
importOne returned: {"status":"imported","dshSessionId":"561ae1b2-...","turns":1,"title":"Real External Title"}
events written: turn/start,step/start,assistant/message,tool/call,tool/result,step/end,turn/end
session/title present in stored log? false
ledger title recorded as: "Real External Title"
>>> CALLER IS TOLD title="Real External Title" BUT THE LOG HAS NO TITLE <<<
```

#### 影响

1. **工具返回值说谎**：`agent_import` 的 render（`src/tools.js` 的 `imported` 分支）不显示 title，
   但返回的 JSON 里有；面板 `/import`（`src/http.js`）原样回传 `result`。
2. **台账永久记录了一个假事实**：`imports.json` 里 `title: "Real External Title"`，
   而对应 DSH 会话日志里**没有任何标题事件**。任何后续读台账来展示"导入的会话标题"的
   逻辑都会展示一个会话本身没有的标题。
3. **不会损坏会话**——会话仍可正常打开（我验证过 v4 校验 PASS）。这是**元数据不一致**，
   不是数据损坏。

#### 为什么前一轮没抓到

`docs/audit2/B1-bughunt.md:95-130` 找到的是**修复前**的"写入了非法 title 事件导致会话无法重开"，
修复后它验证的是"事件流合法"，**没有回头验证 `importOne` 的返回值/台账与事件流是否一致**。
`tests/importer.test.js:602` 的新测试（`'a turn stream with no user text still produces a
readable session'`）也只断言"如果有 title 就必须自洽"，**没有断言 `importOne` 的 `title`
字段必须为 null 当没有 title 事件时**。

#### 修复（2 行）

```js
// convert.js 暴露实际写入的标题
export function convertToDshEvents(...) { ... return { events, titleWritten } }  // 或
// 更小改动：persist.js 里判断
const wroteTitle = events.some(e => e.type === 'session/title')
const effectiveTitle = wroteTitle && typeof exported.title === 'string' ? exported.title : null
// 返回与台账统一使用 effectiveTitle
```

#### 严重度：**low–medium**（元数据撒谎，不影响可读性；但会永久污染台账）

---

### L1-1 补记：审计期间落地的修复（`90ef1bc`）与仍然存活的部分

审计进行中，`90ef1bc`（"fix: make configured provider paths actually work on non-Termux hosts"）
采纳了本条的**后半部分**。我复核了它：

**已修（✅）** —— `buildProviders` 现在把 `config.providers.<id>.paths` 合并进 `deps.paths`，
所以用户**终于**能覆盖路径了。实测：

```bash
$ node -e "buildProviders({config:{providers:{claude:{enabled:true,
    paths:{grun:'/usr/bin/grun',claudeBin:'/usr/bin/claude'}}}}}).get('claude').detect()"
with configured paths -> available: false
detail: spawn /usr/bin/grun ENOENT          # ← 不再是 Termux 路径，覆盖生效
```

`ROADMAP.md` 里"依赖用户配置覆盖"的错误陈述也被纠正了。

**仍然存活（❌ 未修）** —— **默认值一个字都没改**：

```bash
$ node -e "buildProviders({config:{providers:{claude:{enabled:true}}}}).get('claude').detect()"
no config -> detail: spawn /data/data/com.termux/files/usr/bin/grun ENOENT
```

以及 `src/provider/claude.js:22` 的硬编码 arch 仍然在：

```js
claudeBin: prefix() + '/lib/node_modules/@anthropic-ai/claude-code-linux-arm64/claude',
```

⇒ **开箱即用仍然是坏的**：一个没读过 README、没配 `paths` 的普通 Linux 用户，
装完插件后四家全 `available: false`，且诊断指向一个他机器上不可能存在的 Termux 路径。
现在他能自救了（改配置），但**默认体验仍然是 0.1.0 的**。

**所以判决维持 PARTIALLY**：逃生舱 ✅，默认值 ❌。真正把"Termux-first"改成
"PATH-first"（默认 `'grun'` / `'claude'` / `'opencode'`，`$PREFIX` 只在检测到 Termux 时启用）
**仍未做**。

---

## L1-3 — 旧 API 残留 grep

### 判决：**PARTIALLY** —— API 层面全干净（FIXED），但发现一个**整份文件级的遗留**

#### 3a. API 残留：全部 FIXED（0 命中）

逐项 grep 了 `package.json` 声明会发布的文件（`index.js`、`client.js`、`src/`、`locale/`、`docs/`）：

| 旧 API | grep 目标 | 结果 |
|---|---|---|
| `defineTool` | `src/ index.js client.js` | **0 命中** ✅ |
| `@deepseek-ai/*` 运行时 import | `src/ index.js client.js` | **0 命中** ✅ |
| `sessionPersistence.append(id, events)`（旧服务级 API） | `src/ index.js` | **0 命中** ✅ 现在只有 `handle.append(events)`（`persist.js`） |
| `owner: Agent`（对象而非 SessionId） | `src/*.js` | **0 命中** ✅ 现在是 `owner: exec?.agent?.id`（`tools.js:384`、`:493`） |
| `react-dom` | `src/ index.js client.js` | **0 命中** ✅ |
| `MutationObserver` | 同上 | **0 命中** ✅ |
| `ACP` / `acp` bridge | 同上 | **0 命中** ✅ |

`owner` 这一项值得单独说：`docs/audit2/A1-adversarial.md` 的 N1 曾指出
`exec?.agent?.sessionId` 读的是**不存在的字段**（DSH 的 `Agent` 只有 `id`），
现在已改成 `exec?.agent?.id`（`src/tools.js:384`、`:493`），**这条确认 FIXED**。

`inject` 纪律也正确：`index.js:27` `export const inject = ['tools']`，
其余服务（`jobs`/`webServer`/`connection`/`sessionPersistence`/`agents`/`subagents`）
**全部**通过 `ctx.get(...)` 读，没有任何裸 `ctx.subagents` 属性访问
（`backend.js` 里的 `ctx.subagents` 只出现在注释与错误文案里，见 `:342-346`、`:437`）。

#### 3b. 但发现一个整份文件的遗留：`src/index.js`（旧入口的陈旧副本）

**这一项已在本轮审计期间被别人删除**（`e7da40f` 之后 `git status` 显示 `D src/index.js`），
但它是真实存在过的 0.1.0 遗留，且**活了 16 个 commit**，我记录证据：

```bash
$ ls -l src/index.js          # 审计开始时
-rw-rw-r--+ 1 dsh dsh 3316 Nov  6 19:39 src/index.js

$ git log -1 --format="%h %ad %s" --date=short -- src/index.js
e15fcf8 2026-11-06 feat!: 0.2.0 rewrite aligned with DSH 0.2.1-rc.2   # 之后再没动过

$ git log -1 --format="%h %ad %s" --date=short -- index.js
e15fcf8 2026-11-06 feat!: 0.2.0 rewrite aligned with DSH 0.2.1-rc.2   # 同样
```

**为什么它是"遗留"而不是"备份"**：

1. `package.json` 的 `files` 包含 `"src"` ⇒ **它会被打进 npm 包**，用户能 require 到它。
2. 它**能成功加载**并**注册全部 6 个工具**——所以它不是显然坏掉的死文件：
   ```
   $ node -e "import('./src/index.js').then(m=>console.log(Object.keys(m)))"
   src/index.js loaded OK; exports: apply,inject,name
   ```
3. 但它**与 `index.js` 已经分叉**，最关键的一行：
   ```js
   index.js:140      const options = { ctx, io: importContext(ctx), resolver, registry, config, home }
   src/index.js:86   const options = { ctx, resolver, registry, config, home }   // ← 没有 io
   ```
   `io` 是给 importer 的 **`ctx.get` 门面**（`index.js:74-89`）。缺了它，
   `tools.js` 的 `agent_import` 会退化成 `importOne(io ?? ctx, ...)` = 直接传原始 Cordis ctx，
   而原始 ctx 上裸读未注入的服务会抛。实测：

   ```
   $ node /tmp/l1_io.mjs
   stale entry (no io -> raw ctx) -> THREW: 宿主缺少 sessionPersistence.create，无法落库
   ```

   （在真实 Cordis ctx 上，第一次裸读 `ctx.sessionPersistence` 就会抛
   `cannot get property "sessionPersistence" without inject`；我这里用 proxy 复刻了该行为。）
4. **没有任何测试覆盖它**：`grep -rn "src/index" tests/` → 0 命中。

⇒ 一个用户若误按 `src/index.js` 作为入口（例如手工把 `main` 指过去、或从 tarball 里
require `dsh-agent-alliance/src/index.js`），会得到一个**工具注册成功但导入功能坏掉**的插件，
且没有任何测试或错误提示会拦住他。

**修复**：直接删除 `src/index.js`（**本轮审计结束时已被删除**），
或在 `package.json` 的 `files` 里排除它。根本问题是"重写时复制了一份入口而没有删旧的"。

#### 严重度

**medium**（需要用户误用才会触发；但它是纯粹的 0.1.0 残留，且会静默地部分失效）。
已被删除 ⇒ 当前 HEAD 上不再可复现，判决按"曾经 SURVIVES 16 个 commit、现已 FIXED"记录。

---

## L1-4 — `readSession` 的静默 catch：权限错误 → "session not found"

### 判决：**SURVIVES（具体 repro 已复现）** —— 前一轮把它归为"合法可选"是误判

前一轮审计（`docs/audit/01-bugs.md` F3）把这些 catch 分成 (a) "合法可选" / (b) "可能掩体"，
并把 `readFileSync` 失败归到 (b) 但**没有给 repro**，只写了"约 10 行修复"。
我用真实文件系统权限复现了，**它是 (b)，而且后果比"空会话"更糟——是"谎报不存在"**。

#### 相关代码

`src/provider/claude.js:121`（`readSession`）：

```js
try { projects = readdirSync(paths.projectsRoot, { withFileTypes: true }) } catch { return { messages: [] } }
...
try { raw = readFileSync(file, 'utf8') } catch { continue }        // :126  ← 吞掉 EACCES
...
throw new Error('claude session not found: ' + id)                  // :154  ← 走到这里
```

`EACCES` 与 `ENOENT` 在 `:126` 被同一个 `catch { continue }` 合并，于是**"读不了"
被翻译成"不存在"**。

#### 具体 repro（不是推断）

```bash
$ mkdir -p /tmp/l1perm/projects/myproj
$ printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello world"}]}}' \
    > /tmp/l1perm/projects/myproj/sess1.jsonl
$ chmod 000 /tmp/l1perm/projects/myproj/sess1.jsonl
$ cat /tmp/l1perm/projects/myproj/sess1.jsonl
cat: /tmp/l1perm/projects/myproj/sess1.jsonl: Permission denied     # ← 确认 EACCES 真实存在
```

```js
// /tmp/l1_perm.mjs
const p = makeClaudeProvider({ deps: { paths: { projectsRoot: '/tmp/l1perm/projects' } } })
await p.readSession('sess1')
```

```
$ node /tmp/l1_perm.mjs
readSession THREW: claude session not found: sess1
```

**文件是存在的、可 stat 的、只是不可读**，但错误说它不存在。

#### 更糟：与 `listSessions` / `exportSession` 互相矛盾

同一个 provider、同一个文件：

```js
// /tmp/l1_perm2.mjs
listSessions()  -> [{"id":"sess1","cwd":"myproj","createdAt":null,"messageCount":null}]
exportSession() -> THREW: EACCES: permission denied, open '/tmp/l1perm/projects/myproj/sess1.jsonl'
```

- `listSessions` **列出了它**（因为 `readdirSync` 成功，只有 `readFileSync` 失败，
  且 `headLines` 的 catch 返回 `[]`，于是标题为 `undefined` 但条目仍在）。
- `exportSession`（`:168` 的 `readFileSync` **没有** catch）**正确地抛出 EACCES**。
- `readSession` 却**谎报不存在**。

#### 模型看到的自相矛盾（走真实工具）

```js
// /tmp/l1_perm3.mjs —— 真实 registerTools + 真实 claude provider
agent_sessions      -> {"sessions":[{"id":"sess1","cwd":"myproj","createdAt":null,...}]}
agent_session_read  -> THREW: claude session not found: sess1
```

⇒ 模型先被 `agent_sessions` 告知"有 sess1"，再被 `agent_session_read` 告知
"claude session not found: sess1"。**它最自然的推断是"这个 id 拼错了"或"会话被删了"，
于是可能去重试、去猜别的 id，而不是报告"权限问题需要人来处理"。**

而 `docs/audit/01-bugs.md` 对 (a) 类（目录不存在 → 空列表）的判定是**正确的**
——目录不存在确实等于没有会话。错的是把 `:126` 的**文件读取**也归进了同一类。

#### 其余 provider 的同一形状

| 文件:行 | catch | 性质 |
|---|---|---|
| `claude.js:84` | `readFileSync` in `headLines` → `[]` | 同问题（列表里标题静默为空） |
| `claude.js:92` | `readdirSync(projectsRoot)` → `[]` | ✅ 合法（目录不存在 = 无会话） |
| `claude.js:126` | **`readFileSync(session)`** → `continue` | ❌ **本条目主缺陷** |
| `claude.js:165` | `statSync` 探测候选文件 → 继续扫描 | ✅ 合法（探测就是允许失败） |
| `codex.js:71` | `readdirSync(dir)` in 递归 walker → `continue` | ⚠️ 权限错误会让**整棵子树消失**，但已扫到的仍返回 |
| `codex.js:84` | `readFileSync` in `headObjs` → `[]` | 同问题（`readSession` 的 `metaOf` 失配后落到 "not found"） |
| `codex.js:135`/`:165` | `readFileSync` → `break` | ❌ **同问题，且更糟**：`break` 直接退出整个搜索循环，于是 `throw 'codex session not found'` |
| `opencode.js:117` | `db()` 打开失败 → 包装成 `listSessions 失败` | ✅ 会抛，不吞 |
| `zcode.js:110` | `title` 列不存在 → 回退最小列集 | ✅ 合法的 schema 兼容 |

`codex.js:165` 的 `break`（而非 `continue`）尤其值得指出：它把一个**单个文件**的读取失败
升级成**放弃整个搜索**，于是即便目标 session 在后面的目录里，也会报 "not found"。

#### 修复（~10 行，逐处）

```js
// claude.js:126 等
try { raw = readFileSync(file, 'utf8') }
catch (err) {
  if (err.code === 'ENOENT') continue          // 真的不存在
  throw new Error('claude: cannot read session file ' + file + ': ' + err.code)
}
```
`codex.js:135`/`:165` 同类问题要把 `break` 改成 `continue`，并只在**全部候选都试完**后
才抛 "not found"。目录级 catch（`claude.js:92` 一类）保持原样——那才是真正的"可选"。

#### 严重度：**medium**

不损坏数据、不影响正常路径；但它让"权限/IO 故障"伪装成"数据不存在"，
且**与同插件的其它接口相互矛盾**，会把用户/模型引向错误的排查方向。
前一轮定 medium 的结论对，但**理由（"空会话"）不准确**——真实后果是"谎报不存在"，
且前一轮**没有给出 repro**，我这条补上了。

---

## 检查且干净（逐项列出，避免下轮重复劳动）

| 检查项 | 方法 | 结果 |
|---|---|---|
| `defineTool` 残留 | `grep src/ index.js client.js` | ✅ 0 命中 |
| `@deepseek-ai/*` 运行时 import | 同上 | ✅ 0 命中（`package.json` 也无 dependencies） |
| `sessionPersistence.append(id, events)` 旧服务级 API | `grep src/` | ✅ 0 命中；只有 `handle.append(events)` |
| `owner: Agent`（对象） | `grep "owner:" src/*.js` | ✅ 已改为 `owner: exec?.agent?.id`（`tools.js:384`、`:493`） |
| 裸 `ctx.subagents` 属性读（未 inject） | `grep "ctx\.subagents"` | ✅ 只出现在注释与错误文案；实际读走 `ctx.get`/`serviceOf` |
| `react-dom` | `grep src/ index.js client.js` | ✅ 0 命中 |
| `MutationObserver` | 同上 | ✅ 0 命中 |
| ACP bridge | 同上 | ✅ 0 命中（`docs/SPEC-v2.md` 也明确已移除） |
| `inject` 声明最小化 | 读 `index.js:27` | ✅ 只有 `['tools']`，其余走 `ctx.get` |
| v4 事件流：`tool-call` 前置广告 | 真实 `restoreReleasedV4Artifact`，含重复工具名/空名/1000 工具 | ✅ 全部合法 |
| v4 事件流：`stream` 的 `dt` 长度 | 真实 `expandAssistantStream`（内部 `validateRecord`） | ✅ `dt: []` 配单元素 run，恒满足 `dt.length === members - 1` |
| v4 事件流：`surfaceOp` 位置 | 真实 per-row `assertV4RowAdmission` | ✅ 只出现在 `user/message`/`assistant/message`/`tool/result`，均为 `append` |
| v4 事件流：`sourceEventSeqs` | 同上 + `restoreReleasedV4Artifact` | ✅ 只出现在 `tool/result`，引用的 seq 早于自身 |
| 非 JSON 值（BigInt/function/Symbol/循环引用） | `argumentsText` + 真实编码器往返 | ✅ 降级为 `'null'`，不抛、不产生非法 JSON |
| 消息 id 唯一性（含刻意构造 `x:u1` 等 session id） | 遍历所有 `message.id` | ✅ 无碰撞（所有 id 共享同一 sessionKey 前缀） |
| `src/index.js`（陈旧入口副本） | 加载 + 行为对比 | ⚠️ **曾是遗留**（缺 `io` 导致 import 坏）；**审计期间已被删除** |
| SQLite 句柄关闭 | 读 `opencode.js:94`/`zcode.js:99` 的 `finally { database.close() }` | ✅ `1b15214` 已修，异常路径也关 |

---

## 结论：命题"0.2.0 重写真的替换掉了旧行为"

**部分成立，但不成立的部分正好在"默认体验"上。**

- **API 契约层**：确实替换了。五个破坏性契约（`defineTool`、`jobs` owner/handle、
  v4 session format、client module、ACP）**全部**看不到旧形状，grep 全绿。
- **导入管线**：事件流层面确实 v4 合规，我用真实校验器打了 31 个对抗输入，0 失败。
- **但"默认值/默认路径"层是 0.1.0 的**：Termux 前缀 + `linux-arm64` 包名原封不动活了
  16 个 commit，直到本轮审计才补上"用户可覆盖"（默认值仍未改）。
- **而且旧代码的"身子"还留在仓库里**：`src/index.js` 是一份能加载、能注册工具、
  但**功能已坏**的陈旧副本，活了 16 个 commit 且被打进 npm 包。

⇒ 重写替换的是**契约**，没有替换**诞生环境**。这是"重写"最常见的盲区：
新代码是照着新规范写的，但**默认常量、平台假设、文件布局**是从旧版抄过来的，
抄的时候没人问"这还是我们想要的默认吗"。

## 最严重的存活项

**L1-1 的默认值部分**（Termux-first 路径 + 硬编码 `linux-arm64`）：
它决定了**每一个新用户的第一次体验**，四家全红，且诊断指向一个该机器上不可能存在的路径。
虽然现在有配置能救，但**默认仍然是坏的**，且 `ROADMAP` 把它当作"已知技术债"而不是"缺陷"。

探针脚本均写在 `/tmp`（`l1_v4.mjs`、`l1_v4b.mjs`、`l1_stream3.mjs`、`l1_ids*.mjs`、
`l1_perm*.mjs`、`l1_title_lie.mjs`、`l1_notitle.mjs`、`l1_l1verify.mjs`），用后已删除；
`/tmp/l1perm/` 权限测试目录也已清理。插件源码零改动。
