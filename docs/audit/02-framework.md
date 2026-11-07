# Audit B — DSH framework contract alignment

**Subject:** `dsh-agent-alliance` 0.2.0 at commit `e15fcf8`
**Framework:** DSH `0.2.1-rc.2`, installed at
`/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
(authority for what actually runs); source checkout `/home/ova/dsh/packages/`
used only to read intent/JSDoc.

**Method.** Every claim below is grounded in a path + symbol of the installed
`lib/`, plus the plugin's own `file:line`. Behaviour marked *verified* was
reproduced against the real installed class, not inferred.

Severity scale: **critical** = the feature cannot work at all as shipped;
**high** = a documented main path breaks under normal composition;
**medium** = works today but on undocumented ground, or degrades a contract;
**low** = polish / documentation drift with no runtime consequence.

---

## Summary

*(filled at the end)*

---

## F1 — `jobs.start()` throws before the plugin's "no jobs service" fallback can run

**Severity: high.** Plugin cannot start *any* background job in a composition
that mounts `ctx.jobs` but no job controller.

**Plugin:**
- `src/tools.js:123-127` — `startJob()` returns `undefined` only when
  `serviceOf(ctx,'jobs')` is missing or `jobs.start` is not a function. It does
  not `try`/`catch` the call.
- `src/tools.js:312` (`agent_dispatch`), `src/tools.js:405`
  (`agent_roundtable`) — `startJob(...)`, then `if (jobId === undefined) return
  dispatchForeground(...)` as the inline fallback.
- `src/http.js:434` (`POST /roundtable`) — calls `jobs.start({...})` directly
  with no guard at all.

**Framework authority:**
- `dsh-jobs/lib/types/index.d.ts` `JobRegistry.start` — "Preflight access,
  validation, owner cleanup, and implementation-owned admission before starting
  and atomically registering work. **Any preflight rejection leaves no job id or
  execution resource.**"
- `dsh-jobs/lib/types/index.d.ts` `JobRegistry.attachController` — "Attach an
  effect-scoped controller that can read and stop jobs. It serves the owners its
  registering context's scope covers, and **`start` refuses an owner no attached
  controller serves.**"
- `dsh-jobs-local/lib/index.js:412-414` `LocalJobRegistry.start` — the refusal is
  a synchronous `throw`, not a return value:
  `if (!this.servesOwner(owner)) throw new Error("background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)")`.
- `dsh-jobs-local/lib/index.js:553-556` `servesOwner` — returns `true` for the
  global layer, otherwise scans the owner's scope chain. For an **unowned** start
  (`owner === undefined`) the chain is `chainLayers(undefined)`, which is empty
  (`dsh-scope/lib/index.js:162-169` `chainLayers` returns `[]` for
  `scope === undefined`), so an unowned start also throws unless a global
  controller is attached.
- `dsh-tool-jobs/lib/index.js:256` `ctx.jobs.attachController("tool-jobs")` —
  the only production caller in the installed tree.

**Failure scenario.** A profile mounts `@deepseek-ai/dsh-jobs-local` plus the
plugin but not `@deepseek-ai/dsh-tool-jobs` (a headless/SDK composition). The
plugin sees `ctx.jobs` and therefore takes the background branch; every
`agent_dispatch {background:true}` throws the registry error out of `execute`,
and every panel `POST /__agent-alliance/roundtable` returns
`{ok:false,error:"background jobs unavailable…",code:undefined}` with status
500 instead of running inline.

**Fix.** Attach a controller for the plugin's own lifetime, or catch the
preflight throw and fall back. Both are one line:

```js
// index.js, inside apply(), before registerTools/registerPanel:
ctx.inject(['jobs'], (jobCtx) => {
  jobCtx.effect(() => jobCtx.jobs.attachController('agent-alliance'), 'agent-alliance: job controller')
})
```

and additionally treat a throwing `start` as "no jobs service" in
`startJob()`/the `/roundtable` route, because `attachController` is not
guaranteed to precede the first call in every composition. Note the controller
must be attached from the **same scope the owner lives in** (or the global
layer) — see `dsh-jobs-local/lib/index.js:553-556`: a plugin-level
`attachController` in the global layer serves every owner, which is what this
plugin wants.

> Checked: `attachController` is effect-scoped
> (`dsh-jobs-local/lib/index.js:528-531` returns `this.layers.effect(...)`), so
> wrapping it in `ctx.effect()` is correct and the disposable detaches it.

<!-- SECTIONS BELOW ARE FILLED IN PROGRESSIVELY -->

---

## F2 — `output.schema` values are in the supported subset — **CLEAN**, verified

The plugin declares every output as
`{ type: 'object', additionalProperties: true }` (`src/tools.js:182-185`
`openOutput`) and every `parameters` block as
`{ type:'object', additionalProperties:false, properties:{…}, required:[…] }`
(`src/tools.js:169-176` `params`).

**Framework authority:** `dsh-tools/lib/types/json-schema.d.ts`
`assertSupportedJsonSchema` — the enforced subset is "any JSON root, an
annotation-only schema for unconstrained JSON, one scalar `type`, object
`properties`/`required`/boolean `additionalProperties`, array `items`,
type-correct scalar `enum`/`const`, and exact-one `oneOf`".

**Verified** against the installed validator:

```
OK  assertSupportedJsonSchema: {type:'object',additionalProperties:true}
OK  assertSupportedJsonSchema: {type:'object',additionalProperties:false,properties,required}
OK  assertSupportedJsonSchema: properties carrying description + default
OK  rejects unsupported keyword -> schema.minProperties is not a supported keyword
```

`validateJsonSchemaValue` returned `[]` (no violations) for every value shape
the plugin actually returns — `{kind:'background',jobId}`, the dispatch
envelope, and `{text,rounds}`. So `ToolOutputDefinition.schema`
(`dsh-tools/lib/types/index.d.ts`) is satisfied and
`createSuccessResult` → `validateJsonSchemaValue(tool.output.schema, …)`
(`dsh-tools/lib/index.js:3637-3641`) will not raise `ToolOutputError` for any
normal return value.

Note the subset requires **object-rooted** schemas only for consumers that opt
in via `assertObjectJsonSchema`; `register` calls the *unconstrained*
`assertSupportedJsonSchema` (`dsh-tools/lib/index.js:2974-2982`), which is why a
non-object output root would also have been accepted. The plugin's uniform
object root is stricter than required — correct, not a defect.

**But** see F3: `parameters` are *never validated* on this registration path,
so the schema is honest only about outputs.

---

## F3 — raw `ctx.tools.register` skips model-argument validation entirely

**Severity: medium** (silent wrong-argument acceptance; not a crash).

**Plugin:** `src/tools.js:251, 340, 427, 454, 477, 524` — six
`ctx.tools.register({…, parameters: params({…}, ['prompt'])})` calls. The
`required` arrays and `additionalProperties:false` look enforced but are not.

**Framework authority:**
- `dsh-tools/lib/index.js:838-887` `defineTool` — argument validation lives
  *only* in the `defineTool` wrapper: it builds `validate` from
  `parameterSchemaSpecToJsonSchema` and its `execute` throws
  `new ToolArgsError(violations)` before calling the body
  (`lib/index.js:866-870`).
- `dsh-tools/lib/index.js:2974-2982` `ToolRuntime.register` — validates
  `output.schema` and `timeoutMs`, then inserts the definition. It never
  inspects or validates `definition.parameters`.
- `dsh-tools/lib/types/index.d.ts` `ToolDefinition.execute` — "Tool and
  listener failures resolve as materialized error results"; `parameters` is
  the model-facing contract (`ToolSchema.parameters`, `dsh-llm/lib/types/types.d.ts`),
  and the registry treats arguments as already-parsed
  (`dsh-tools/lib/types/index.d.ts` `ToolExecutionInput.arguments`:
  "Losslessly JSON-serializable parsed arguments (**tools validate their own
  schema**)") — an explicit statement that validation is the definition's job.

**Verified** against a real `ToolRuntime` with the plugin's exact raw
registration shape:

| model call | result | body ran? |
| --- | --- | --- |
| `{}` (missing required `prompt`) | `isError: false` | yes, `args = {}` |
| `{prompt:'x', bogus:1}` (undeclared key, `additionalProperties:false`) | `isError: false` | yes, extra key preserved |
| `{prompt:123, rounds:'two'}` (wrong types) | `isError: false` | yes |

**Consequence.** `agent_dispatch({provider:'claude'})` with no prompt reaches
`src/tools.js:234` `String(args.prompt)` → the literal string `"undefined"` is
sent to the external agent, and `src/tools.js:312-315` sends
`owner: exec?.agent?.sessionId` with a `"undefined"` label. Same for
`agent_roundtable({})` (`prompt` becomes `"undefined"`) and
`agent_session_read` (`sessionId` becomes `"undefined"`).

**Compliant form.** Either switch to `defineTool` from
`@deepseek-ai/dsh-tools` (impossible here — the plugin deliberately ships with
zero `@deepseek-ai/*` imports) **or** validate explicitly at the top of each
`execute` before touching `args`, e.g. a local `requireArgs(args, ['prompt'])`
that throws a message the registry will materialize. Minimum viable: assert
`typeof args.prompt === 'string' && args.prompt !== ''` and throw otherwise —
the throw becomes a structured tool error (F4), so the model gets a usable
correction instead of a dispatch of the literal text "undefined".

---

## F4 — a throwing `execute` *is* contained: structured `isError` result, no unhandled rejection — **CLEAN**, verified

The task brief asks whether tools that throw produce a structured tool error or
an unhandled rejection. **They produce a structured tool error.**

**Framework authority:**
- `dsh-tools/lib/index.js:3390-3414` `dispatchToolBody` — the whole body call
  (`await tool.execute(...)`) is inside `try { … } catch (error) { return
  toolErrorResult(error) }`.
- `dsh-tools/lib/index.js:3712-3726` `toolErrorResult` — returns
  `{ content:[{type:'text',text:'Error: '+message}], isError:true, error:{message, info?} }`.
- `dsh-tools/lib/types/index.d.ts` `ToolDefinition.execute` — "Tool and
  listener failures resolve as materialized error results".

**Verified** with the real registry: a body throwing
`new Error('boom: jobs unavailable')` produced
`isError: true`, `content: [{"type":"text","text":"Error: boom: jobs unavailable"}]`,
`error: {message:"boom: jobs unavailable"}`. No rejection escaped
`rt.execute(...)`.

Two adjacent verified facts:
- A **non-lossless** return value becomes `isError: true` with
  `error.info.name === 'ToolOutputError'` (`lib/index.js:3637-3641`,
  `snapshotToolValue`).
- A **throwing `output.render`** becomes
  `isError: true`, `"Error: tool \"x\" returned invalid output: output.render failed: renderer broke"`
  (`projectionError`, `lib/index.js:2657-2659`).

So F1's failure mode is *loud but contained*: the model sees
`Error: background jobs unavailable: no job controller serves this agent…` and
the turn continues. That is why F1 is **high**, not critical — the plugin does
not crash the agent; it just never runs background work, and the panel route
returns a 500 envelope (F5) instead of falling back.

**Plugin-side gap that makes this worse.** `src/tools.js:312` and
`src/tools.js:405` compute `startJob(...)` inside `execute` with no
`try`/`catch`, and the fallback is `if (jobId === undefined)`. A throw never
yields `undefined`, so the documented inline fallback (`src/tools.js:335`,
`src/tools.js:419-421`) is unreachable precisely in the case it exists for.

---

## F5 — panel `/roundtable` returns a 500 envelope instead of falling back, because `jobs.start` throws

**Severity: high.** Same root cause as F1, different surface; listed separately
because the fix differs.

**Plugin:** `src/http.js:431-457`. The guard is
`if (jobs !== null && typeof jobs.start === 'function')` — a shape check, not a
liveness check — then `const jobId = jobs.start({…})` at `src/http.js:434`
with no `try`. The inline fallback at `src/http.js:455-457` is therefore
unreachable whenever `jobs.start` throws.

**Framework authority:** same as F1 —
`dsh-jobs/lib/types/index.d.ts` `JobRegistry.start` ("Any preflight rejection
leaves no job id or execution resource"), `dsh-jobs-local/lib/index.js:414`
(the throw), `dsh-jobs-local/lib/index.js:553-556` `servesOwner`.

**Worse than F1:** `src/http.js:313-320` `route()` maps any thrown error to
`sendError(res, Number(error?.status) || 500, …)`. A `jobs` preflight failure has
no `status`, so the panel receives HTTP 500 `{ok:false,error:"background jobs…
"}` — a spurious "server error" for what is really a deploy-shape issue, and the
panel cannot distinguish it from a bug in the plugin.

**Fix.** `try { jobId = jobs.start(...) } catch { return { jobId: null, text:
formatRoundtableText(await produce(new AbortController().signal)) } }`, or attach
a controller (F1's fix) so the preflight passes.

---

## F6 — `timeoutMs` is never declared on any tool, so no deadline is enforced

**Severity: medium** (unbounded tool calls; `exec.signal` handling is fine).

**Plugin:** none of the six `register({…})` calls sets `timeoutMs` (grep: 0
occurrences as a definition field). Instead the plugin passes a *model-supplied*
number into its own CLI timeout (`src/tools.js:238`,
`src/tools.js:267`, `src/tools.js:324`, `src/tools.js:397`).

**Framework authority:**
- `dsh-tools/lib/types/index.d.ts` `ToolDefinition.timeoutMs` — "Cooperative
  tool-call timeout budget in milliseconds. Omit for no deadline. Enforced by
  `@deepseek-ai/dsh-tool-call-timeout-policy` (a `tools/execute` wrapper); it is
  NEVER sent to the model — `schemas()` whitelists only
  name/description/parameters. Declaring it asserts this tool forwards
  `exec.signal` to a cooperative implementation that can reach quiescence when
  the signal aborts."
- `dsh-tools/lib/index.js:2979-2980` `register` — rejects a non-positive or
  non-finite `timeoutMs`.
- `dsh-tool-call-timeout-policy/lib/index.js` — the enforcer maps its own expiry
  to the structured `TOOL_TIMEOUT` code; the tool must honor `exec.signal`.

**Assessment.** Absence is *legal* (omit = no deadline) and the plugin does
forward `exec.signal` correctly (F7), so this is not a contract violation. It is
a **missed framework capability with a real consequence**: a hung external CLI
that ignores SIGKILL-able child death, or a backend whose `spawnCli` promise
never settles, leaves the tool call open indefinitely with no `TOOL_TIMEOUT`
result. The plugin's own `defaultTimeout` (300 s) only bounds the *child
process*, not the tool call.

**Compliant form.** Declare `timeoutMs` on `agent_dispatch` and
`agent_roundtable` (e.g. `timeoutMs: defaultTimeout * 2`), which is honest
because the body forwards `exec.signal` all the way to `spawnCli`
(`src/runner.js:71-88` kills the child on abort and settles).

---

## F7 — `isConcurrencySafe` absent on every tool: correct and required here — **CLEAN**

**Severity: none.** Absence is the *safe* default, and for this plugin it is
also the *correct* one.

**Framework authority:**
- `dsh-tools/lib/types/index.d.ts` `ToolDefinition.isConcurrencySafe` — "Only
  `true` opts in; omission, exceptions, non-`true` returns, and invalid
  `defineTool` arguments are exclusive. This metadata is never model-visible.
  Opted-in executions must not mutate parent-owned state."
- `dsh-tools/lib/index.js:3423-3446` `dispatchScheduledExecution` +
  `dsh-agent-loop/lib/index.js:520-527` — the loop groups calls by
  `ctx.tools.executionMode`, which is `exclusive` unless a classifier returns
  exactly `true`.

**Assessment.** These tools spawn external processes, mutate the session via
imports (`agent_import` writes a ledger file and creates a session), and
allocate job slots against a shared semaphore plus the registry's per-owner
concurrency cap (`dsh-jobs-local/lib/index.js:419`,
`maxConcurrentJobsPerOwner`, default 10). Declaring `true` would let two
`agent_import` calls race the read-modify-write ledger
(`src/importer/persist.js` `loadLedger` → `saveLedger`) and could exceed the
registry's owner cap. **Omission is the correct contract use.** No change
wanted; flagged as clean so its absence is not mistaken for an oversight.

---

## F8 — `presentCall`/`presentResult` partially present; absence elsewhere is a UI regression, not a contract violation

**Severity: low** (no runtime contract; product-visible only).

**Plugin:** `presentCall` exists on 3 of 6 tools (`src/tools.js:276`,
`src/tools.js:365`, `src/tools.js:540`); `presentResult` exists on 1 of 6
(`src/tools.js:294`). The remaining tools fall back to the framework default.

**Framework authority:** `dsh-tools/lib/types/index.d.ts`
`ToolDefinition.presentCall` / `presentResult` — both are *optional*
("Optional: how to present…"), each returning `ToolCallView | undefined`
(`dsh-tools/lib/types/presentation.d.ts`). Omission is explicitly supported:
`dsh-tools/lib/types/index.d.ts` says an omitted method "falls back to a generic
presentation (title = tool name, raw args as input)".

So **no contract violation**. Two real observations:

1. `presentResult` (`src/tools.js:294-302`) hard-codes
   `card:'terminal'` + `exitCode: 0` for `agent_dispatch`, including for the
   *background* variant. A background dispatch returns
   `{kind:'background',jobId}`, has no exit code, and the card claims a
   successful terminal run that never happened. `TerminalResultView.exitCode` is
   documented as "Process exit code, when the run ended by exiting"
   (`presentation.d.ts:151-164`) — a fabricated `0` is a lie to the UI, and the
   same `presentResult` will be shown for the truncated-string branch of
   `renderDispatch`. Guard on `args.background !== true` and on
   `result.isError === false` before setting `card:'terminal'`.
2. `presentCall` for the background branch returns `kind:'execute'` with
   `rawInput = prompt` (`src/tools.js:278-285`) and the card never mentions the
   job id the user must use to collect output; `rawInput` is documented as "the
   salient input to show in a detail/expanded view (e.g. a background job id)"
   (`presentation.d.ts`). Minor, but the framework already has the right slot
   for it.

**No action required for correctness.** Recorded because the brief asked
whether the missing presenters matter: they do not, but the one that *is*
present is inaccurate.

---

## F9 — `lossless()` reimplements framework normalization, and makes `null` out of nothing

**Severity: low** (belt-and-braces, but a silent-coercion smell).

**Plugin:** `src/tools.js:25-27` — `JSON.parse(JSON.stringify(value ?? null))`
before every return.

**Framework authority:** `dsh-tools/lib/index.js:3637-3641`
`createSuccessResult` → `snapshotToolValue` rejects non-lossless JSON with
`ToolOutputError` (verified: `{when: new Date()}` → `isError:true`,
`error.info.name === 'ToolOutputError'`).

**Assessment.** The round-trip duplicates what the registry already does and
adds two behaviours the framework does *not*: (a) it turns `undefined` return
values into `null` instead of failing loudly, and (b) it silently drops
`undefined` object members, so a shape bug in the plugin becomes a smaller JSON
object rather than a `ToolOutputError`. Not a violation — the schema still
validates — but it converts a would-be loud failure into a quiet one, which is
the opposite of the repo's "misconfiguration fails loud" rule. If kept, also fix
the JSDoc: it claims it strips "undefined, functions, symbols", but
`JSON.stringify` *throws* on BigInt and turns `NaN`/`Infinity` into `null`.



---

## F10 — `delivery: 'caller'` is the correct mode for this plugin, and it is what makes the result reachable — **CLEAN**

**Severity: none** (correct choice), with one important caveat documented in F11.

**Plugin:** `src/backend.js:241` — `delivery: 'caller'`.

**Framework authority:** `dsh-subagent/lib/types/types.d.ts`
`SubagentActivationSpec.delivery` — "Parent delivery notifies the model; caller
delivery only returns the result. Local children always enter the parent
catalog." And `dsh-subagent/lib/index.js:2049`
`notifySettlement` — `if (!activation.announced || activation.delivery ===
"caller") return;` i.e. caller delivery suppresses the parent notice.

**Why `caller` is right here.**
- `parent` delivery injects a `subagent-settled` user message into the calling
  agent's inbox (`dsh-subagent/lib/index.js:516-540`
  `createSettlementMessage`). For a *tool* that is about to hand the same text
  back as its own tool result, that double-delivers the child's answer.
- The official `dsh-tool-subagent` uses `delivery: "parent"` because it ends
  the turn at dispatch and lets the settlement notice carry the answer
  (`dsh-tool-subagent/lib/index.js:475-481`). The plugin instead *awaits*
  `activation.result` inline and returns it, so `caller` is the matching
  choice.
- The other first-party precedent is `dsh-workflow-ptc/lib/index.js:333`, which
  also uses `delivery: "caller"` because a script consumes the child result
  itself.

**Caveat (see F11):** `caller` changes *which* services must exist. In
`startLocal`, persistence is downgraded from required to optional only for
caller delivery: `const persistence = spec.delivery === "caller" ?
this.ctx.get("sessionPersistence") : this.requirePersistence()`
(`dsh-subagent/lib/index.js:1395`). For **external** providers (which is what
`dsh-subagent-codex`/`-claude-code` are) `startExternal` is used instead
(`lib/index.js:3047`), so this branch does not apply — but the plugin should
not assume that, see F11.

---

## F11 — the official subagent path is *unreachable in practice* because the plugin requires `parent` but tool dispatch supplies `exec.agent` only sometimes

**Severity: high** (the "official subagent first" feature silently never
activates in the compositions the plugin's README targets; it is also the
finding most likely to break on the next rc, see F20).

**Plugin:** `src/tools.js:305` — `resolver.resolve({ provider: providerId,
parent: exec?.agent })`. `src/backend.js:31-44` `isLiveAgent` returns `false`
unless `parent.id` is a non-empty string, and `src/backend.js:75-82`
`subagentRoute` then returns `undefined` → CLI path. In `src/http.js:275`
`backendOf()` passes **no** parent at all, by design (documented in
`src/http.js:270-273`).

**Framework authority:**
- `dsh-tools/lib/types/index.d.ts` `ToolExecutionInput.agent` — "The agent on
  whose behalf the call runs (set by the agent loop)." It is **optional**
  (`readonly agent?: Agent`), and the registry itself never fills it: it is
  copied through from the caller (`dsh-tools/lib/index.js:3240-3246`
  `createExecution` spreads the caller's `agent`).
- `dsh-subagent/lib/index.js:3045` `startActivation` —
  `if (this.ctx.get("agents")?.get(spec.request.parent.id) !== spec.request.parent)
  throw new SubagentError("subagent creation requires the exact live parent
  agent", "UNAUTHORIZED")`. The plugin's `isLiveAgent` heuristic duplicates this
  exact check (`src/backend.js:31-44`), so a disagreement is impossible *when
  `parent` is present* — the plugin's check is a weaker-but-compatible prefilter.
- `dsh-agent-loop/lib/index.js:582` `startCall` — the loop builds `call.exec`
  from the model's tool call and does pass the owning agent, so a
  model-dispatched call does carry `exec.agent`.

**Assessment.** The gate is *correct*; the problem is that it is a *silent*
gate. `isLiveAgent` returning `false` produces no log, no diagnostic, and no
difference in `resolver.list()` output (`src/backend.js:348-385` reports
`kind:'cli'` for a provider whose subagent provider is registered but
unreachable — the `detail` string only appears when the CLI provider is *also*
missing). So an operator who configured
`providers.claude.subagentProvider: 'claude-code'` and mounted the official
bundle sees `agent_dispatch` quietly use the CLI, with no signal that the
official path was skipped. That is a "works by accident"-class problem: it is
currently *lucky* that the CLI provider exists; when it doesn't, the user gets
`unknown provider: claude` from `cliOrThrow` (`src/backend.js:114-118`)
instead of "your subagent provider needs a live parent agent".

**Compliant form.** Return the reason from `subagentRoute` and surface it:
`resolver.list(parent)` should report
`kind:'subagent', available:false, detail:'official provider registered but the
call has no live parent Agent'` when `configuredSubagentName` is set,
`usableSubagentService` succeeds, and `isLiveAgent` fails. That is a pure
reporting change inside the existing `list()` contract
(`src/backend.js:348-385`) and it makes the fallback legible.

> Note the framework's own hard requirement is `exact live parent` — the
> plugin's `agents.get(parent.id) === parent` check mirrors it exactly, so no
> change to the *dispatch* logic is needed.

---

## F12 — `activation.result` **can** reject, and the plugin's `.catch(() => {})` guard covers it — **CLEAN**, but the `dispose()` ordering is subtly wrong

**Severity: low** (correct containment, questionable ordering).

**Framework authority:**
- `dsh-subagent/lib/types/types.d.ts` `SubagentRun.result` — "Does NOT reject
  on a child-level failure — a model/transport failure resolves with
  `stopReason: 'error'`… **Rejects on an infrastructure fault the seam cannot
  represent as a stop reason.**"
- `dsh-subagent/lib/types/types.d.ts` `SubagentActivation.result` —
  "Execution result after teardown settles and notifications are sent;
  **capture failures reject**."
- Implementation: `dsh-subagent/lib/index.js:2043-2044` — `if (resultFailure
  === void 0) activation.result.resolve(result); else
  activation.result.reject(resultFailure.error)`, where `resultFailure` is set
  by the `catch` around `captureLocalResult`/`activation.run.result`
  (`lib/index.js:2009-2011`). Also `lib/index.js:1898`
  `rollbackUnpublished` rejects it, and `lib/index.js:1849`
  `activation.result.promise.catch(() => void 0)` already attaches the
  service's own no-op consumer.

**Plugin:** `src/backend.js:247` — `activation.result.catch(() => {})` before
the `resumeSessionId` early-return, with the comment explaining it prevents an
unhandled rejection when the result is discarded. This is exactly the
`dsh-workflow-ptc` `contain()` idiom
(`dsh-workflow-ptc/lib/index.js:289-297` "Attach a no-op rejection consumer
WITHOUT changing what the caller receives"). **Correct.**

The plugin then `await`s `activation.result` inside the same `try`
(`src/backend.js:249`), so a rejection propagates as the dispatch error and
lands in the tool's structured error path (F4). Both paths are covered. **Clean.**

**Subtle ordering issue.** `src/backend.js:263-271` calls
`await activation.dispose()` in `finally`. But `SubagentActivation.result` is
documented as resolving "**after teardown settles** and notifications are
sent" — the manager already disposes on natural settlement
(`dsh-subagent/lib/index.js:1942-1950`: the natural-settlement observer calls
`this.close(activation, () => this.finishDisposal(activation, false))`).
`dispose()` is memoized (`lib/index.js:1707-1713` `close` returns the existing
`activation.closing`), so the double-dispose is harmless and idempotent.

What is *not* harmless: on the `resumeSessionId` early-throw path
(`src/backend.js:248`) the plugin throws **before** awaiting
`activation.result`, then disposes. `dispose()` triggers
`finishDisposal(activation, /* stop */ true)` which aborts the run and settles
`result` — with `stopReason:'error'`/`'aborted'` rather than the child's real
answer. That is the intended behaviour (the caller asked for an unsupported
mode), so no fix needed; but it means the child was started and paid for before
the rejection. Cheap improvement: reject `resumeSessionId` **before**
`startActivation` — the check needs no service call at all:

```js
// src/backend.js, before `const activation = await route.service.startActivation(...)`
if (hasResumeId(request.resumeSessionId)) throw resumeRejection(providerId, providerName)
```

That removes a whole child start (and its cost) from the failure path, which
matters because `COST_WARNING` (`src/tools.js:17`) tells the model every
dispatch spends quota.

---

## F13 — omitting `maxDepth` is exactly right for `NO_START_CAPABILITIES` providers — **CLEAN**

**Severity: none.**

**Plugin:** `src/backend.js:232-242` builds the request as
`{ prompt, parent, ...(cwd?{cwd}:{}) }` — no `maxDepth`, no `agentOptions`,
no `agentPreset`, no `outputSchema`.

**Framework authority:**
- `dsh-subagent/lib/types/out-of-process.d.ts` `NO_START_CAPABILITIES` — "The
  capability advertisement of an out-of-process backend: NONE. A child in
  another process cannot honor parent-enforced start features
  (`agentOptions`/`agentPreset`/`outputSchema`/`maxDepth`), so the service
  rejects a request needing any of them before `start` runs — **never
  accepted-then-ignored.**"
- `dsh-subagent/lib/index.js:3311-3328` `assertCapabilities` — the three
  `needs` entries are `agentOptions`, `outputSchema`, `maxDepth`, each throwing
  `SubagentError(..., "UNSUPPORTED_CAPABILITY")` when requested against a
  provider lacking the flag.

**Assessment.** Because out-of-process providers advertise all four flags
`false`, *any* of them in the request is a hard rejection. The plugin correctly
sends none of them, and the comment at `src/backend.js:216-218` states the
reason ("passing them as start capabilities would be rejected by the seam").
This is a **correct, exact** use of the contract — the plugin's `model` and
`timeoutMs` are silently dropped on the subagent path, which is the only
possible behaviour and is documented in the same comment.

**One documentation gap:** `src/tools.js:255` tells the model "The official
subagent provider is preferred when the deployment registers one for a live
parent agent", but nothing tells the model that `model` and `timeoutMs` are
ignored on that path. A model that passes `model:'gpt-5'` gets a silently
different model. Low severity; the fix is one clause in the tool description.

---

## F14 — `SubagentError` codes are not surfaced: the plugin flattens every failure into a plain `Error`

**Severity: medium** (loses machine-routable failure identity).

**Plugin:** `src/backend.js:159-170` `stopFailure()` and
`src/backend.js:230` (`"no longer registered"`) construct plain `Error`s;
`src/backend.js:152-157` `resumeRejection()` also a plain `Error`.

**Framework authority:**
- `dsh-subagent/lib/types/error.d.ts` (via `export { SubagentError } from
  './error.ts'`) — a `HarnessError` subclass with a stable `code`:
  `dsh-subagent/lib/index.js:3295` `NO_PROVIDER`, `lib/index.js:3300`
  `CONTINUATION_UNAVAILABLE`, `lib/index.js:3327` `UNSUPPORTED_CAPABILITY`,
  `lib/index.js:3045` `UNAUTHORIZED`, `lib/index.js:3038`
  `UNSUPPORTED_CAPABILITY`.
- `dsh-tools/lib/index.js:2709-2718` `errorInfo` — "Structured `{name, code}`
  for a thrown **`HarnessError`**, else undefined." A non-`HarnessError` throw
  produces `error.info === undefined` in the tool result.
- `dsh-llm/lib/types/*` `HarnessError` — "Stable machine-routable failure class
  (e.g. `RATE_LIMIT`); **route on this, never by parsing `message`**."

**Assessment.** The plugin's own errors are plain `Error`s, so the registry's
`errorInfo` yields nothing and the model/user only ever sees text. If the
*seam* throws (`UNAUTHORIZED`, `UNSUPPORTED_CAPABILITY`, `NO_PROVIDER`), the
plugin lets it propagate — good, because that preserves `HarnessError` and
`errorInfo`. But the plugin's *own* re-wraps (`stopFailure`, `resumeRejection`,
"no longer registered") destroy any identity the underlying provider had: in
`stopFailure` the original `result.diagnostic` string is copied onto a fresh
`Error`, and in the dispose failure path
`primary.disposeError = disposeError` (`src/backend.js:269`) an ad-hoc property
is used instead of an error taxonomy.

**Compliant form.** Without importing `@deepseek-ai/dsh-llm` (the plugin is
deliberately dependency-free) the minimum is to preserve the *shape* the
registry looks for: attach `code` and `name` to the thrown object and give it
the standard `HarnessError` prototype chain — or, more practically, keep
propagating the seam's own error untouched for the `startActivation` call
(already the case) and only wrap `resumeSessionId`/`stopFailure`, attaching a
documented `code` (e.g. `SUBAGENT_UNSUPPORTED_RESUME`,
`SUBAGENT_STOPPED_NOT_COMPLETED`) so callers can route without parsing prose.

