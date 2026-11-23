# C5：ACP permission 策略实测 —— opencode 根本不发权限请求

> 实测时间：2026-11-23
> **结论：官方 `subagent-acp` 的 `permission: 'allow'|'reject'` 对 opencode 完全无效，因为 opencode 从不发 `session/requestPermission`。**

## 一、官方 ACP provider 的权限机制（源码为准）

`packages/subagent/subagent-acp/src/run.ts:430-455`：

```ts
.onRequest(methods.client.session.requestPermission, ({ params }) => {
  if (spec.permission === 'allow') {
    const allow = params.options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
    if (allow !== undefined) { … return { outcome: { outcome: 'selected', optionId: allow.optionId } } }
  }
  latestPermission = { … decision: 'denied' }
  return { outcome: { outcome: 'cancelled' } }
})
```

即：**只有当子 agent 主动发 `session/requestPermission` 请求时**，`allow`/`reject` 才有意义。
`reject` 的语义是回答 `cancelled`，让子 agent 不要继续。

## 二、实测：opencode 一次都没发

用真实 stdio 子进程，把所有 server→client 请求都记下来并拒绝：

```
mode=build  stopReason: end_turn | server->client requests: 0 (none)
mode=plan   stopReason: end_turn | server->client requests: 0 (none)
```

**两种模式下都是 0 个请求**，但文件都写出来了：

```
mode=build → /tmp/acp-mode-build.txt 内容 "MODE_build"
mode=plan  → /tmp/acp-mode-plan.txt  内容 "MODE_plan"
```

## 三、这意味着什么（两条都重要）

### 1. `permission: 'reject'` 给不了任何保护

官方 provider 的默认是 `reject`，但**对 opencode 完全不生效** —— 不是"拒绝了操作"，
而是"根本没有请求可拒"。任何依赖 `permission: 'reject'` 当作沙箱的假设都是错的。

在 `docs/audit5/C4-acp-feasibility.md` 的配置块里，我写过 `permission: 'allow'  # 或 'reject'，看你要不要让它改文件`。
**这句话需要更正**：那个开关对 opencode 无效。

### 2. `mode: 'plan'` 也没有阻断写入

opencode 自己把 `plan` 模式描述为 "Plan mode. Disallows all edit tools."（见 `session/new` 的
`configOptions.mode.options[1].description`），但实测它仍然写出了文件。

可能原因（未逐一验证）：
- `session/select_config_option` 的调用方式可能不对（我用了 `configId:'mode'`，若字段名不同则静默未生效）
- 或 `plan` 只约束它自己的内置 edit 工具，不约束 `bash`/`write` 之类的直接写文件路径

**我没有进一步验证 mode 是否真的切换了**——这一点必须诚实标注：如果

## 四、给用户的诚实结论

| 手段 | 对 opencode 是否有效 |
|---|---|
| `permission: 'reject'`（官方默认） | **无效**（0 个权限请求） |
| `permission: 'allow'` | 无意义（没有请求需要允许） |
| `mode: 'plan'` | **实测未阻断写入**（但 mode 是否真的切过去了未确认） |

⇒ **把 opencode 接进官方 `subagent-acp` 时，它会在 cwd 里读写文件且没有任何审批环节。**
这跟官方 codex 的 `never` 模式（有原生沙箱）和 claude 的 `dontAsk`（拒绝未授权）都不同。

这不是本插件的缺陷，是 opencode 作为 ACP agent 的实现选择。但**必须在文档里说清楚**，
否则用户会以为设了 `permission: 'reject'` 就安全了。

## 五、本插件的 CLI 路径对比

本插件 `agent_dispatch` 走 opencode CLI 时同样没有审批环节（`-p` 非交互模式）。
所以**两条路都不提供审批**，区别只在：

- 官方 ACP 路径：Cordis 管理的生命周期、`maxActiveSubagents` 池化、`inheritedParentContext:false`
- 本插件路径：支持 `resumeSessionId`、`model` 覆盖、历史浏览

## 六、未验证

1. `session/select_config_option` 的正确调用方式（mode 到底切没切）
2. opencode 是否有别的开关能真正禁用写文件（例如 `--pure` 或配置项）
3. v2 的 `additionalDirectories`/`delete`/`steering` 声明与实际行为（C4 里也只核对了声明）
