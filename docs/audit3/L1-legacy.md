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
| L1-4 | 静默 catch → "空会话" | *（待定）* |

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

<!-- APPEND: L1-4 -->
