# C2（手工补核）：0.2.2-rc.5 契约漂移

> 子代理 audit-framework 因网络超时未能交付，以下由 Lead 手工核对。
> 基线：对齐是照 **0.2.1-rc.2** 做的；运行时现在是 **0.2.2-rc.5**（跨 4 个 rc）。

## 已漂移（会导致行为出错）— 1 项，已修

### `dsh-jobs-local` 抛错从裸 `Error` 变为 `JobError` + 稳定 code

```
0.2.1-rc.2:  throw new Error("background jobs unavailable: no job controller serves ...")
0.2.2-rc.5:  throw new JobError("...", "JOB_CONTROLLER_UNAVAILABLE")
```

`JobErrorCode` 全集（`dsh-jobs/lib/types/error.d.ts`）：
`JOB_BACKGROUND_DISABLED` / `JOB_CONTROLLER_UNAVAILABLE` / `JOB_NOT_FOUND` /
`JOB_FOREIGN_SESSION` / `JOB_OWNER_NOT_LIVE` / `JOB_OWNER_REGISTRY_UNAVAILABLE` /
`JOB_LIMIT_REACHED`

**影响**：我们的注释写着「throws bare Errors with no code to match on」，且对所有
拒绝统一回一句"启用 dsh-tool-jobs"。当真实原因是**任务桶满**（`JOB_LIMIT_REACHED`）
时，这句话把调用者指向了错误的修复方向。

**已修**（`68e7dfd`）：按 code 分流，每种 code 给各自的下一步；`error.code` 透传给调用者。

## 逐项核对：仍成立（7 项）

| 契约 | rc.5 现状 | 我们的假设 | 结论 |
|---|---|---|---|
| `resolveConfig` 用 `value` **替换** row config | `cordis/lib/index.js:246-249` `if (result.issues) throw ... else return result.value` | 我们上一轮据此修了 validate bug | **仍成立** |
| `defineTool` 包装 `execute` 校验 args | `dsh-tools/lib/index.js:338-341` `validate(args)` → `ToolArgsError` | 我们因此自建 `withArgValidation`（用的是 raw `register`） | **仍成立**（raw register 仍不校验 args） |
| `SENSITIVE_ENV_PATTERN` | `dsh-subprocess/lib/index.js:102` `/KEY\|PASSWORD\|SECRET\|TOKEN/i` | 我们的 `CREDENTIAL_NAME` 逐字对齐 | **仍成立** |
| `SubagentStartRequest` 字段 | `cwd?` / `agentPreset?` / `label?` / `prompt` / `parent` / `signal` / `agentOptions?` / `outputSchema?` | 我们只传 `prompt`/`parent`/`cwd?` | **仍成立**，未传任何 capability-gated 字段 |
| `NO_START_CAPABILITIES` | `{agentOptions:false, agentPreset:false, outputSchema:false, depthLimit:false}` | 我们传 `maxDepth`/`agentOptions` 会被拒 | **仍成立**，我们一个都没传 |
| `WebRoute` prefix 语义 | `index.d.ts:36` "'prefix' p matches p and p/<anything>" | 我们依赖 `/__agent-allianceX` 不匹配 | **仍成立**（实机验证过 404） |
| `collected.readFrom(0)` 返回 | `{text, nextOffset, lossy, spillPath?}` | 我们读 `.text` | **仍成立** |
| `SubagentResult` 是否带 usage | **没有** usage 字段（仅在注释里出现 "usage-only messages"） | 我们的官方 backend 不透传 usage | **仍成立**，CLI 路径自采 usage 是唯一来源 |

## 可用未用（官方新能力，我们该考虑）

| 能力 | 现状 | 建议 |
|---|---|---|
| `agentPreset` 参数 | 我们从不传（`NO_START_CAPABILITIES.agentPreset=false` 对 codex/claude 生效） | **不该用**——官方 vendor provider 不支持 |
| `outputSchema` / `structured` | 同上，官方 vendor provider 不支持 | **不该用** |
| `dsh-subagent-acp` | 官方给"non-Harness ACP agent"的通用通道，`capabilities` 为空、配置要 `providerName`/`command`/`args` | **该用**——这是把 opencode/zcode 正式对齐进官方的唯一路径，但需先确认 CLI 支持 ACP |

## 未核（无法在没有 CLI 的情况下确认）

- opencode/zcode 是否支持 ACP：npm 装 `opencode-ai@1.19.6` 超时（`exit=124`），
  无法跑 `opencode --help` 看有无 `acp` 子命令。`npm view` 的 metadata 无 keywords/description，
  无法从包信息判断。
- 官方是否给 opencode/zcode 做了 provider：**没有**。npm 上与安装版里的官方 subagent 包全集为
  `subagent` / `-fork-in-process` / `-spawn-in-process` / `-in-process-driver` /
  `-codex` / `-claude-code` / `-acp` / `-dsh-sdk`，**无第三方 CLI 专属 provider**。
