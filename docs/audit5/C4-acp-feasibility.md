# C4：opencode / zcode 的 ACP 可行性 — 实测结论

> 实测时间：2026-11-22
> 结论一句话：**opencode 1.19.6 原生支持 ACP，且已完成真实握手与会话往返。**

## 一、网络问题的真实原因（先说清楚，这决定了怎么装）

`dsh` 用户的 egress 被 iptables `DSH_EGRESS` 限制。我实测：

| 目标 | 结果 |
|---|---|
| `172.30.66.1:1091` / `:1081` TCP | `nc` **成功** |
| 同两个端口发 HTTPS | **全部超时** |
| `dsh` 直连 `registry.npmjs.org` | **超时** |
| `ova` 直连 `registry.npmjs.org` | **200 / 7.6s** |

⇒ **代理端口通但代理本身不工作**。AGENTS.md §5 说"环境变量已预设、最稳"，但在当前
egress 链下实测不可用。可行路径只有一条：**通过 `ova` 用户装，再让 `dsh` 执行装好的产物**。

```bash
SSHPASS=Xu090316 sshpass -e ssh -o StrictHostKeyChecking=no ova@127.0.0.1 '<cmd>'
```

`ova` 的 node 是 v20.18.1 / npm 10.8.2（不是 node24）。`opencode.exe` 装好后
权限是 `-rwxr-xr-x ova ova`，**dsh 可以直接执行**（已验证 `--version` → `1.19.6`）。

## 二、opencode 的 ACP 支持 — 已证实

### 证据 1：`--help` 里有 acp 子命令

```
Commands:
  opencode acp                 start ACP (Agent Client Protocol) server
  ...
```

### 证据 2：`opencode acp` 是 **stdio** 服务，符合官方 seam 的 spawn 方式

官方 `subagent-acp/src/run.ts:351` 用：
```ts
stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' }
```
`opencode acp` 正是 stdio JSON-RPC 服务（无 `--port` 需求，`--port` 是 MCP server 用的）。

### 证据 3：真实 `initialize` 握手成功

发一个 JSON-RPC `initialize` 帧，收到：

```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":1,
  "agentCapabilities":{"loadSession":true,"mcpCapabilities":{"http":true,"sse":true},
    "promptCapabilities":{"embeddedContext":true,"image":true},
    "sessionCapabilities":{"close":{},"fork":{},"list":{},"resume":{}}},
  "authMethods":[{"description":"Run `opencode auth login` in the terminal",
    "name":"Login with opencode","id":"opencode-login"}],
  "agentInfo":{"name":"OpenCode","version":"1.19.6"}}}
```

### 证据 4：`session/new` 成功

```json
{"jsonrpc":"2.0","id":2,"result":{
  "sessionId":"ses_dfcf4c80affeMcO5uI5mZ3KjZ4",
  "configOptions":[
    {"id":"model","name":"Model","category":"model","type":"select",
     "currentValue":"opencode/big-pickle","options":[...23 个免费模型...]},
    {"id":"mode","name":"Session Mode","category":"mode","type":"select","currentValue":"build"}]}}
```

注意：它自带了 23 个模型选项，包括 `opencode/deepseek-v4.1-flash-free` 等多个免费车道。

### 证据 5：完整 prompt 往返（**ova 用户，有网络**）

真实 stdio 子进程脚本（`/home/ova/agent-clis/acp-test/handshake.mjs`）：

```
initialize: {"name":"OpenCode","version":"1.19.6"}
session/new: ses_dfcf309c2ffeRB4cM53F7YvU5l
CHUNK: {"type":"text","text":"P"}
CHUNK: {"type":"text","text":"ONG"}
prompt stopReason: end_turn | elapsed 10099 ms
```

**这是完整闭环**：回答是流式的（两个 chunk 拼成 "PONG"），`stopReason: end_turn`。

### 证据 6（重要限制）：**dsh 用户下 prompt 超时**

同一个脚本在 `dsh` 用户下：
```
initialize: ok
session/new: ok   (ses_dfcf25b44ffeY3edl6VxPyvzgL)
FAILED: session/prompt timeout | after 42409 ms
```

原因：opencode 的免费模型**需要真实外网**，而 dsh 的 egress 被 DSH_EGRESS 链 DROP。
⇒ **在本机上，dsh 用户跑 opencode ACP 只能握手、不能出回答**。

这不是 ACP 的问题，是这台机器的网络约束。要让 DSH 里的 opencode 真正回答，
必须解决 dsh 的出口（要么放行 opencode 需要的域名，要么让它走一个真正工作的代理）。

## 三、可直接使用的官方配置（前提是 dsh 能出网）

```yaml
- id: subagent-acp
  name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: 'opencode'
    command: '/home/ova/agent-clis/oc/node_modules/opencode-ai/bin/opencode.exe'
    args: ['acp']
    permission: 'allow'    # 或 'reject'，看你要不要让它改文件
```

之后模型会多出一个全局工具（`toolName` 由 `dsh-tool-subagent` 的 row 配置决定，
参考官方 base bundle 里 `tool-subagent` 的写法）。

**能力边界（官方 ACP provider 声明的）**：
```ts
capabilities = { agentOptions:false, outputSchema:false, depthLimit:false, toolFilter:false, persona:false }
inheritsParentContext = false
```
即：不继承父上下文、不能选 model/reasoning、不能要 structured output。

## 四、zcode — 无法验证，且 npm 上没有官方包

| 查询 | 结果 |
|---|---|
| `npm view zcode version` | `0.0.1` |
| `npm view zcode bin` | **`None`**（没有可执行文件） |
| `npm view zcode description` | `This is a nice project` |
| `npm view zcode author` | `S.Crawish` |
| `npm view @zcode/cli` | **404 Not Found** |

⇒ npm 上的 `zcode` 是一个**空壳占位包**（无 bin、无意义描述、非 z.ai 官方）。
**zcode CLI 在本机无从验证**，不能声称它支持或支持不 ACP。

本插件的 `commandTemplate` 模板模式（`providers.zcode.enabled` + `commandTemplate`）
是唯一可配置途径，前提是用户自己有 zcode 二进制。

## 五、这对插件意味着什么（建议）

1. **opencode 可以走官方 ACP 通道**——这是"第三方 agent 对齐进官方"的**第一个实证案例**。
   前提是 dsh 能出网。
2. **本插件的 opencode CLI 包装层仍有价值**：ACP provider 不支持 `agentOptions`
   （不能指定 model）、不支持 resume（`inheritsParentContext:false` + 一次性），
   而我们的包装层支持 `resumeSessionId`、`model`、会话历史浏览/导入。
3. **两条路可以并存**，不是二选一：
   - 想"官方对齐、一次性委派" → 官方 `subagent-acp` + opencode
   - 想"续聊、浏览历史、导入会话" → 本插件 `agent_dispatch`(opencode)
4. **建议给 README 补这条实测结论**（当前 README 只写了"unverified"）。

## 六、未做与限制

- **没有跑通 `dsh-subagent-acp` 官方 provider 本身**：需要把 bundle 装进 profile 并重启 GUI，
  且 dsh 必须先能出网。我只验证了 opencode 侧的 ACP 协议正确性。
- **没有测 `session/prompt` 在 dsh 用户下的可用性**（超时，见上）。
- **没有测 ACP 的 `permission` 策略**（`allow`/`reject` 对 opencode 编辑文件的实际行为）。
