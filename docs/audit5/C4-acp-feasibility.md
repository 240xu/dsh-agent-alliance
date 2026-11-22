# C4：opencode 的 ACP 支持 — v1 与 v2 双架构实测

> 实测时间：2026-11-23
> **核心结论：v1 与 v2 都支持 ACP，但能力声明不同，不能互相代表。**

## 一、先分清两套架构（这是最容易搞错的地方）

`npm view opencode-ai versions` 给出 **12268 个版本，major 只有 0 和 1，没有任何 2.x**。
v2 根本不在 `opencode-ai` 这个包名下发布 —— **它是另一条产品线**。

| 项 | **v1** `opencode-ai` | **v2** `@opencode/*` |
|---|---|---|
| 安装包 | `opencode-ai@1.19.6`（单包，**0 依赖**，`unpackedSize` 7852） | `@opencode/cli@2.3.2`（`core` 拆包有 **38 个依赖**：zod/effect/undici/bun-pty/jose…） |
| 二进制位置 | 直接内置：`bin/opencode.exe`（**215 MB ELF**） | `bin/opencode.exe` 只是 **275 字节启动脚本**；真二进制在 `@opencode/cli-linux-x64/bin/opencode`（**252 MB**），另有 `baseline` / `musl` / `baseline-musl` 四个变体 |
| `bin` 名 | `opencode` | **`opencode` 和 `opencode2` 两个名字指向同一个 exe** |
| postinstall | 不需要（二进制随包发） | **必须跑**。跳过会留一个只打印「postinstall script was not run」的占位脚本 |
| `--version` | `1.19.6` | **`opencode v2.3.2`**（前缀不同，脚本解析要注意） |

**安装踩的坑**：v2 的 252 MB 二进制经代理下载极易中断。第一次 600s 超时只拿到 40 MB，
第二次直接 truncated（跑起来报 `Part of its embedded program is missing`）。
最终用 `fetch_retries=5` + 50 分钟超时才完整（校验：文件大小 === npm `unpackedSize` 252848539）。

## 二、ACP 实测（两边都是真实 stdio 握手）

### v1 @ 1.19.6

```json
initialize → {"protocolVersion":1,
  "agentCapabilities":{
    "loadSession":true,
    "mcpCapabilities":{"http":true,"sse":true},
    "promptCapabilities":{"embeddedContext":true,"image":true},
    "sessionCapabilities":{"close":{},"fork":{},"list":{},"resume":{}}},
  "authMethods":[{"id":"opencode-login",...}],
  "agentInfo":{"name":"OpenCode","version":"1.19.6"}}
```

完整往返：`session/new` → `session/prompt` → 流式 `"P"`+`"ONG"` → `stopReason: end_turn`，**12.4s**。

### v2 @ 2.3.2

```json
initialize → {"protocolVersion":1,
  "agentCapabilities":{
    "loadSession":true,
    "mcpCapabilities":{"http":true,"sse":false},
    "promptCapabilities":{"embeddedContext":true,"image":true},
    "sessionCapabilities":{"additionalDirectories":{},"close":{},"delete":{},
                           "fork":{},"list":{},"resume":{}},
    "_meta":{"opencode/child-session-updates":true}},
  "_meta":{"steering":{"supported":true}},
  "agentInfo":{"name":"OpenCode","version":"2.3.2"}}
```

完整往返：同样拿到 `PONG` + `end_turn`，**5.4s**。

## 三、逐字段差异（只有这三处，但都是实质的）

| 字段 | v1 | v2 | 影响 |
|---|---|---|---|
| `mcpCapabilities.sse` | `true` | **`false`** | v2 不支持 MCP 的 SSE 传输，只用 http |
| `sessionCapabilities.additionalDirectories` | 无 | **有** | v2 支持给会话追加额外工作目录 |
| `sessionCapabilities.delete` | 无 | **有** | v2 能删除会话，v1 不能 |
| `_meta["opencode/child-session-updates"]` | 无 | **`true`** | v2 声明子会话更新能力 |
| `_meta.steering.supported` | 无 | **`true`** | v2 声明支持 steering（中途改向） |

`protocolVersion` **两边都是 1**，未变。
`session/new` 的 `configOptions` **结构一致**：都是 `model` + `mode` 两个选项，model 各 10 个。

## 四、`acp` 子命令的参数差异

| 项 | v1 | v2 |
|---|---|---|
| `acp --help` 独有 | `--port` / `--hostname` / `--mdns` / `--mdns-domain` / `--cors` / `--cwd` | **只有 `--login`** |
| 其余 flag | 同左 | 全部移到 `GLOBAL FLAGS`（`--log-level` 取值从 4 个扩到 10 个） |

对官方 `dsh-subagent-acp` 的影响：它只需要 `command` + `args: ['acp']`，**两者都能直接用**。
但如果将来要用 `--cwd`/`--port` 这类参数，**v2 没有**，不能照抄 v1 的配置。

## 五、代理是硬前提（实测对照）

`dsh` 用户的 egress 被 iptables `DSH_EGRESS` 限制，opencode 的免费模型需要真实外网。

| 代理 | `session/prompt` 结果 |
|---|---|
| `127.0.0.1:19893`（cfhop 的 mihomo） | **`end_turn`，PONG，12363 ms** ✅ |
| `127.0.0.1:9`（故意给死端口） | **timeout，42740 ms** ❌ |

同二进制、同 HOME，只有代理不同 —— **证明代理确实被 opencode 采用**，且它是出回答的硬前提。

顺带纠正一条环境事实：AGENTS.md §5.1 说 `172.30.66.1:1091`「最稳」，
但当前实测 **TCP 通、HTTP 全超时**；`172.30.0.1:13070/fwd` **端口不通**；
真正可用的是 **`127.0.0.1:19893`**（`/home/ova/cfhop` 的 mihomo，`mixed-port: 19893`）。

## 六、给插件的可执行配置

两版都能走官方 `dsh-subagent-acp`，只是 `command` 不同：

```yaml
# v1
- id: subagent-acp
  name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: 'opencode'
    command: '/home/ova/agent-clis/oc/node_modules/opencode-ai/bin/opencode.exe'
    args: ['acp']

# v2
- id: subagent-acp
  name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: 'opencode2'
    command: '/home/dsh/.artifacts-live-test/oc2/node_modules/@opencode/cli-linux-x64/bin/opencode'
    args: ['acp']
```

两者都需要在进程环境里有可用代理（如 `HTTPS_PROXY=http://127.0.0.1:19893`），
否则 `session/prompt` 会超时——这一点必须写在配置旁边，不能假设用户知道。

## 七、能力边界（官方 ACP provider 声明的，两版都受限）

```ts
capabilities = { agentOptions:false, outputSchema:false, depthLimit:false,
                 toolFilter:false, persona:false }
inheritsParentContext = false
```

即：不继承父上下文、不能选 model/reasoning、不能要 structured output。
本插件的 CLI 包装层补齐的正是这些（`resumeSessionId`、`model` 覆盖、会话历史浏览/导入）。

## 八、未做

- **没有装 `dsh-subagent-acp` 进 profile**（需重启 GUI，未获授权）
- **没有测 ACP 的 `permission` 策略**（`allow`/`reject` 对 opencode 编辑文件的实际行为）
- **v2 的 `additionalDirectories` / `delete` / `steering`** 只核对了声明，未逐个实测
