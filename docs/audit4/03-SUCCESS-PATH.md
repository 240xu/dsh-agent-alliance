# 成功路径实机验证 —「都试试」

> 日期：2026-11-13
> 授权：用户「好，都试试」+ 此前「全权接手」
> 运行时：`/opt/dsh-0222/`（0.2.2-rc.1），`dsh web` systemd 托管，GUI 127.0.0.1:3080
> 目标：把上一轮留下的「无真实外部 agent，成功派发未验证」全部试掉

## 一、两条路都做了

### A. 真实外部 CLI（npm 包）

第一次装失败：`/opt` 对 dsh 用户不可写，`cd` 没生效导致 npm 实际在
`/home/ova/dsh` 这个大 workspace 里跑，arborist 报 `Cannot read properties of null`；
registry 还是 npmmirror。换到 `/home/dsh/.artifacts-live-test/{claude,codex}`
干净目录 + 显式 `registry.npmjs.org` 后成功：

| 包 | 版本 | 可执行入口 |
|---|---|---|
| `@anthropic-ai/claude-code` | 2.1.322 | `bin/claude.exe`（341MB，postinstall 落地），`--version` → `2.1.322 (Claude Code)` |
| `@openai/codex` | 0.167.1 | `bin/codex.js`，`--version` → `codex-cli 0.167.1` |

`claude` 的 argv 需要 `grun`（Termux glibc runner）。写了个 3 行 shim
（`exec "$@"`）放在 `/home/dsh/.artifacts-live-test/grun`，普通 Linux 上直接透传。
**不改插件一行代码**，纯靠第三轮做的 `config.providers.<id>.paths` 能力接通。

`~/.dsh/dsh-agent-alliance.json` 里配上真实 paths 后，实机 `/state`：
```
claude available:true
codex  available:true
```

### B. 官方 Codex / Claude Code bundle

`plugin_manager install_bundle` 装了
`@deepseek-ai/dsh-subagent-codex@0.2.2-rc.1` 与
`@deepseek-ai/dsh-subagent-claude-code@0.2.2-rc.1`（claude 那次拉了 101 个包）。
两者都报 `application: restart-required` / `restartReason: unmanaged-plugin`，
按官方要求重启后生效。

`Tool.listTools` 实证两个全局工具在位：
```
subagent_codex
subagent_claude_code
```
与 `agent_dispatch` **并存且无名字冲突** —— O1 说的「若把四家注册成同名 provider
会 DUPLICATE_PROVIDER」得到反面印证：只要不抢名字就相安无事。

## 二、成功派发路径（全部实机）

### 前台单派发 — 200 OK

`zcode` 用模板模式接了一个本地 echo fixture（`printf 'ACK:%s\n' {prompt}`），
用来验证「命令 → stdout → 解析 → HTTP 200」整条链路，**不冒充真实 agent 回答**：

```
POST /__agent-alliance/dispatch {"provider":"zcode","prompt":"LIVE-PONG"}
→ 200 {"ok":true,"provider":"zcode","backend":"cli","text":"ACK:LIVE-PONG",
        "stopReason":null,"externalSessionId":null,"durationMs":17}
```

### 圆桌 — 2 轮 / 3 轮均 200

```
POST /roundtable {"prompt":"compare please","providers":["zcode","claude"],
                  "rounds":2,"background":false}
→ 200，zcode 每轮产出 ACK:compare please，
  claude 失败为 `External CLI failure (...; category: access-policy; exit code: 1)`
  不泄露原始输出
```

### 官方 subagent backend（真实工具调用） — 打通

在 legacy 配置里显式 `codex.subagentProvider = "codex"` 后：
- **面板路径**（无 live parent Agent）：`/state` 显示 `kind: cli` 并附
  `detail: 'official subagent provider "codex" registered but this call has no live parent Agent'`
  —— 正是第四轮按 J1/D1 加的「为什么官方路径没生效」说明，实机证明有用
- **工具路径**（有 live Agent）：真实 `agent_dispatch` 调用走了 `ctx.subagents`，
  返回官方 `failureDiagnostic` 形态
  `Product subagent failure (product: Codex; stage: turn; category: product-error)`

### 参数校验（真实工具层）

误传 `description` 给 `agent_dispatch` → `Error: invalid arguments: unknown field "description"`。
第四轮补的 `withArgValidation` 在活工具层生效。

## 三、实机发现的真实缺陷（已修并推送）

### Config.validate 把 legacy 配置反向覆盖了

**现象**：`~/.dsh/dsh-agent-alliance.json` 明明写了 `zcode.enabled: true`，
活 Host 却一直报「zcode 未启用」；重启、热重载都无效。

**根因**：Cordis `resolveConfig` 会用 `Config['~standard'].validate()` 的 `value`
**替换** row config。第四轮我们的 validate 返回的是
`loadConfig(value, {legacyConfigFile:false})` —— 一个已填好默认值的完整对象。
`apply` 再跑一次 `loadConfig(rowConfig)` 时，这个默认值对象作为最后一层
**覆盖了 legacy 文件**，用户设置被静默丢弃。（`claude.paths` 只是碰巧被
deepMerge 保留下来，掩盖了问题。）

**修复**（`index.js`）：validate 只校验、**原样返回 value**。
Loader 校验 ROW，`apply` 里的 `loadConfig` 独占文件读取与默认值合并。

**证据**：修复前两阶段复现 `zcode.enabled:false`；修复后 `true`；
活 Host 重载后 `/state` 出现 zcode 且派发 200。测试锁住「validate 必须返回 row 原样」。

提交 `3e17925`，已推送。

## 四、环境限制（如实记录，未伪造成功）

- **真实 LLM 派发无法完成**。codex CLI 直跑显示它成功启动、建了 session、
  然后连 OpenAI Responses WebSocket 失败（无 API key + 本机需走代理）。
  机器上有 `dsh-our-free-model` 的 Anthropic 兼容网关，但 `chanGateway.relay.enabled: false`
  且未监听；`127.0.0.1:8081` 只是 opencode2api 的静态控制台，不是 API。
  **启用另一个插件的中继超出本插件验证范围，我没动它。**
  所以 zcode 的 echo fixture 是「成功链路」的验证手段，不是真实 agent 回答。
- **`detect(): available:true` ≠ 能调 API**。claude/codex 的 `--version` 能跑，
  但真实派发因无凭据失败并正确归为 `access-policy` / `product-error`。
  探测只验证可执行文件存在，这是设计如此。
- **官方 bundle 派发失败**同样是凭据/网络问题，返回的是官方自己的诊断格式，
  恰好证明插件走对了 seam。
- **Client 面板 DOM 渲染**仍未做视觉验证（`Slots.listSubTree` 无连接页面），
  需要你刷新 GUI 确认。

## 五、清理与最终状态

验证用的 `zcode` echo 模板已从生产配置移除（`enabled:false`），
**保留**有永久价值的设置：两个真实 CLI 的 paths、`codex.subagentProvider: codex`。
清理后 `/state` 只剩 claude / codex / opencode，无假 provider。

```
远端/本地 main: 3e17925（已推送）
测试: 231 pass / 0 fail
工作树: 0
Host: include:agent-alliance enabled/active
官方 bundle: subagent_codex + subagent_claude_code 均已 active
```

## 六、想真正跑通 LLM 派发还差什么

1. 在 `dsh-our-free-model` 设置页启用本地网关中继（Anthropic `/v1/messages`），
   拿到它签发的 key 与端口
2. 把 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` 通过插件的
   `providers.<id>.env`（J3 §3 建议、目前尚未暴露到配置层）或 CLI 自身配置注入
3. 或者给 codex 配 `OPENAI_API_KEY` + 可用的代理出口

这三步都涉及别的插件/账号配置，不在「验证本插件」范围内，等你定。
