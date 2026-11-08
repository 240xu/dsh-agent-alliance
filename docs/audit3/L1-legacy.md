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
| L1-1 | Termux-first 路径探测 | **SURVIVES（完全未动，16 个 commit 零改动）** |
| L1-2 | 导入管线 v4 合规 | *（待定）* |
| L1-3 | 旧 API 残留 | *（待定）* |
| L1-4 | 静默 catch → "空会话" | *（待定）* |

---

## L1-1 — Termux-first 路径探测：**SURVIVES（原封不动）**

### 判决：**SURVIVES**，且比前一轮审计描述的更严重（多一个 arch 硬编码 + 一个不存在的"用户覆盖"）

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

<!-- APPEND: L1-2 -->
