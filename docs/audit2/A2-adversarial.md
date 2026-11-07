# Adversarial Audit A2 — refutation pass and fix stress-test

**Subject:** `dsh-agent-alliance` 0.2.0
**Baseline re-verified at:** `b5693d8` (HEAD when this report was finalized)

> **Staleness note, important.** I began this audit at commit `2d68e3f`. While I
> was working, two fix commits landed: `2f6660e` ("close the five money- and
> data-losing defects") and `b5693d8` ("stop treating CLI errors as answers").
> `2f6660e` independently fixed claims **D** and **E** and applied patches
> **P1** and **P2**. Every section below is re-verified against `b5693d8` and
> states explicitly whether it is *still live* or *already fixed*. Two of my
> four Part-1 verdicts therefore describe historical state; I say so rather than
> quietly rewriting them, because the interesting result is **that the landed
> P1 is the naive version whose defect I predict.**
**Framework:** DSH `0.2.1-rc.2` installed at
`/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`

**Stance.** I am instructed to *refute*. Every verdict below starts from the
assumption the prior audit is wrong, and only survives when I fail to break it.
Verdicts: **REFUTED** (claim is wrong), **OVERSTATED** (mechanism real, impact
or reachability wrong), **CONFIRMED** (I tried and could not break it).
Every verdict states *what I attempted*, so a reader can judge the strength of
the attempt rather than trusting the conclusion.

Read-only. Nothing in the plugin was modified.

---

## Part 1 — Refutation attempts

### (D) "resumeSessionId is rejected only after startActivation spawns a billed child"

**VERDICT: CONFIRMED AT `2d68e3f` — NOW FIXED at `2f6660e`.**
As of `b5693d8` the guard sits at `src/backend.js:232`, above
`await route.service.startActivation(...)` at `:237`. I verified the guard is
now genuinely pre-spawn:

```
resolved kind: subagent
resume error: resumeSessionId is not supported on the official subagent path …
startActivation was called: 0 (0 = guard runs first)
```

The analysis below describes the defect as it existed, because it is the
evidence base for patch **P2**.

**What I attempted.**

1. *Does the official provider validate resume before spawning?* There is no
   resume parameter anywhere in the seam. `SubagentStartRequest`
   (`dsh-subagent/lib/types/types.d.ts`) has `cwd`, `agentPreset`, `label`,
   `prompt`, `parent`, `signal`, `agentOptions`, `outputSchema`, `maxDepth` —
   **no session-resume field exists**, so a provider cannot validate one. The
   Codex README states it explicitly: "Each external activation executes once
   and accepts no follow-up input or resume"
   (`/home/ova/dsh/packages/subagent/subagent-codex/README.md:73`), and
   "Every run spawns a fresh app-server, creates one ephemeral thread, and
   executes exactly one turn; there is no continuation, resume, or pooling"
   (`README.md:95`). Refutation attempt fails: nothing upstream can reject it.

2. *Does the plugin's guard run first in some path?* At `2d68e3f`, only in the
   HTTP path, trivially, because `src/http.js` passes `resumeSessionId` straight
   through to a **CLI** backend and never reaches the subagent branch —
   `backendOf()` supplies no parent (`src/http.js:274-276`). So the subagent
   path and the resume parameter could only meet through `agent_dispatch`. In
   that path the order was fixed: `await route.service.startActivation(...)`
   ran at the old `src/backend.js:232`, and only at the old `:248` did
   `if (hasResumeId(request.resumeSessionId)) throw resumeRejection(...)` fire.

3. *What does `startActivation` actually do before returning?* I traced it to
   the end. `SubagentRuntime.startActivation`
   (`dsh-subagent/lib/index.js:3036-3048`) → `manager.startExternal`
   (`:1483-1521`) → `materialize` → `materializeTracked`
   (`:1764-1776`), which does `const run = await inputs.start(controller.signal)`
   — and `inputs.start` is
   `this.host.startExternal(spec.provider, {...})` (`:1498-1503`). For Codex
   that is `startCodexRun`, which **spawns the app-server before returning**:
   `child = spec.spawn({ argv: codexAppServerArgv(), … })`
   (`subagent-codex/src/run.ts:236-241`), then `wire.initialize()` and
   `wire.startThread()` (`run.ts:320-324`). `startActivation` resolves only
   after that — so the `await` at `src/backend.js:232` is a *billed process
   launch plus a JSON-RPC handshake*, and the resume rejection happens strictly
   afterwards.

**Two findings beyond the original claim.**

- **The child is not merely spawned, it is *run to completion*.** Because the
  guard throws inside the `try` whose `finally` awaits
  `activation.dispose()` (`src/backend.js:263-271`), and because
  `SubagentActivation.result` is documented to settle "after teardown settles"
  (`dsh-subagent/lib/types/types.d.ts`), the rejection path *must wait for the
  manager to tear the run down*. `finishDisposal(activation, /* stop */ true)`
  (`dsh-subagent/lib/index.js:2002-2012`) aborts the run and then
  `await activation.run.result` — i.e. it awaits the Codex run's settled result,
  which under `settleRunResult` (`:2849-2873`) resolves `stopReason:'aborted'`
  only after the abort propagates. So the caller pays the spawn, the handshake,
  *and* the teardown round-trip before seeing an error that was knowable from
  the arguments alone. **Original claim understates the cost.**
- **A thrown `startActivation` leaks nothing but also delivers nothing.** If
  `startActivation` itself rejects, the prompt was never submitted, so it is a
  cheap failure — the plugin is only vulnerable on the path where start
  *succeeds*.

**What would have refuted it (and does not exist):** a precheck inside
`SubagentRuntime.startActivation` before `provider.start`, or a
`resumeSessionId` field in `SubagentStartRequest` that a provider could
validate. Neither is in the installed lib — which is why the fix had to live in
the plugin, and does now.

---

### (E) "an already-aborted signal still executes dispatch"

**VERDICT: OVERSTATED — mechanism real, reachability wrong.** I found a
framework-level mitigation the prior audit missed for the *normal* tool path.
**Additionally, the plugin-side gap is now fixed at `2f6660e`**: the semaphore
fast path gained an up-front check (`src/tools.js:58-60`). Verified at `b5693d8`:

```
58:      if (signal?.aborted === true) {
59:        return Promise.reject(new Error('aborted before start (maxConcurrent=' + limit + ')'))
```

Note the landed form rejects with a bare `Error`, not the `AbortError` the
registry classifies as `ABORTED` — that is the flaw I describe at the end of
this section, and it is now live code.

**What I attempted.** I built a real `ToolRuntime`, registered a tool exactly
the way the plugin does (raw `ctx.tools.register`, no `defineTool`), and called
`rt.execute()` with a signal aborted **before** entry:

```
A already-aborted at execute() -> isError: true | code: ABORTED_BEFORE_DISPATCH
                               | body ran: false
                               | msg: tool call aborted before dispatch
```

**Framework authority for the mitigation:**
`dsh-tools/lib/index.js:3390-3400` `dispatchToolBody` —
`const fused = fuseToolSignals(state.callerSignal, wrapperSignal); … if
(isAborted(signal)) { fused.dispose(); return toolAbortedBeforeDispatchResult(); }`
— executed **before** `resolveExecution` and before `tool.execute(...)`.
`toolAbortedBeforeDispatchResult` (`:3791-3805`) sets
`error.info.code = TOOL_ABORTED_BEFORE_DISPATCH` (exported constant,
`dsh-tools/lib/index.js` exports `TOOL_ABORTED_BEFORE_DISPATCH`).

So for a call that arrives already cancelled, **the tool body never runs** and
no CLI is spawned. The prior audit's reproduction (`semaphore-race2.mjs`)
exercised `createSemaphore` **in isolation**, bypassing the registry — a real
artifact of the test harness, not of production dispatch.

**Where the claim survives (narrowed).** The semaphore is still entered with an
unchecked signal on two paths that the registry does *not* pre-screen:

1. **Inside a background job.** `src/tools.js:317-333` `run(job)` calls
   `gate.run(controller.signal, …)`. The controller is created fresh at
   `src/tools.js:309`, so it is never pre-aborted — *but* a kill arriving in the
   window between `jobs.start()` registration and the `run()` body's first tick
   aborts the controller while `active < limit`, and `entry.begin()` runs the
   work anyway (the free-slot fast path at `src/tools.js:76-79` never reads
   `signal.aborted`). The same shape applies to the panel path
   (`src/http.js:433-457`).
2. **`agent_roundtable`'s fan-out.** `runRoundtable` calls
   `provider.dispatch` for every member with no abort check
   (`src/roundtable.js:30-38`); each `provider.dispatch` → `spawnCli`
   (`src/runner.js:29`) only checks `signal.aborted` **after** `spawn()` at
   `src/runner.js:59-62`. So N children can be spawned for a roundtable that was
   already cancelled.

**Corrected severity: low** (was high). The window is microseconds, requires a
cancel in a very specific interleaving, and the framework already covers the
common "user cancels before the call" case. The proposed hardening is still
correct — it is just not a high-severity defect.

**Note on the fix as proposed.** `if (signal?.aborted) return
Promise.reject(new Error('aborted before start'))` in `createSemaphore.run`
would be **wrong for the queue path**: it rejects with a bare `Error`, so the
result loses the `AbortError`/`ABORTED` identity the registry uses to classify
cancellation (`dsh-tools/lib/types/index.d.ts` `ToolErrorInfo`,
`TOOL_ABORTED`). Prefer `signal.throwIfAborted()` so the DOMException survives.

---

### (F) "agent_dispatch duplicates the official global tool with opposite semantics"

**VERDICT: OVERSTATED — the duplication is real and dangerous, but the specific
"opposite semantics" framing is wrong, and in this install the official tool is
**not present at all**.

**What I attempted.**

1. *Is the official tool installed by default?* **No.** Neither
   `dsh-subagent-codex` nor `dsh-subagent-claude-code` is in the installed
   tree (`ls /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
   | grep subagent` → `dsh-subagent`, `-fork-in-process`, `-spawn-in-process`,
   `dsh-tool-subagent`, `dsh-tool-subagent-control`), and neither is a
   dependency of the installed `dsh` package
   (`grep subagent-codex`/`subagent-claude` in
   `/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json` → no match).
   Only the **source checkout** has them
   (`/home/ova/dsh/packages/subagent/subagent-codex`,
   `.../subagent-claude-code`, version `0.2.1-alpha.2` — note: *alpha*, not a
   matched rc).
   So the "two tools with the same job" collision is **opt-in**: it requires the
   user to install an alpha bundle. Refutation partially succeeds.

2. *Can they coexist?* When both are installed, **yes, harmlessly at the
   registry level** — the names differ (`agent_dispatch` vs `subagent_codex`
   from `cordis.patch.yml:6-7` `toolName: subagent_codex`). There is no
   duplicate-name error; `ToolRuntime.register`
   (`dsh-tools/lib/index.js:2974-2982`) only rejects the reserved `run_code`.
   So there is no *technical* conflict — only a model-facing choice between two
   tools.

3. *Are the semantics opposite?* I checked the load-bearing differences against
   the installed contracts:

   | dimension | `agent_dispatch` | official `subagent_codex` |
   | --- | --- | --- |
   | delivery | `delivery:'caller'`, awaits `activation.result`, returns text in the tool result (`src/backend.js:241-259`) | `delivery:'parent'`, returns a child id, answer arrives as a settlement notice (`dsh-tool-subagent/lib/index.js:475-481`; README `:73-77`) |
   | resume | accepts `resumeSessionId` (and rejects it on the official path) | no such parameter |
   | model override | forwards `model`, silently dropped on the subagent path (`src/backend.js:232-242`) | `model` is a bundle config (`cordis.patch.yml` + provider config), not per-call |
   | permission mode | n/a | `permissionMode` bundle config |

   "Opposite" is the wrong word: they are **different execution models**
   (inline-awaiting vs fire-and-forget-with-notice). The dangerous part is not
   that they are opposite — it is that `agent_dispatch`'s **description promises
   the official provider is preferred** (`src/tools.js:255`) while its shape
   (inline await) does not match the official tool's fire-and-forget shape. A
   model that learns the fire-and-forget ergonomics from `subagent_codex` and
   then uses `agent_dispatch` will mis-plan, but it will still get an answer.

**Real residual risk (kept from the original claim, re-worded):** two
model-visible tools with overlapping purpose and *different result-arrival
semantics* is a genuine ergonomics hazard, and the plugin does not tell the
model which to prefer. The fix is not to remove `agent_dispatch` but to name
the distinction in its description ("this one blocks and returns the answer; the
official `subagent_*` tool returns an id and notifies later").

**Corrected severity: low** (was medium/high), because the collision requires
an alpha bundle to be installed, and when it is installed nothing breaks.

---

### (G) "roundtable bypasses maxConcurrent"

**VERDICT: CONFIRMED**, and it is worse than the original claim: **the
roundtable gate does not exist in any form**, and the *default* member set is
four providers that are **all unavailable** on this host.

**What I attempted.**

1. *Is it bounded by the subagent pool?* No. The `maxActiveSubagents` pool
   (`dsh-subagent/lib/index.js:1046-1053` `ActivationPool.reserve`) applies only
   inside `materialize`, i.e. only to the official subagent path. Roundtable
   fans out through `registry.get(id).dispatch(...)`
   (`src/roundtable.js:30-38`), which on the CLI path is `cliBackend.dispatch`
   (`src/backend.js:185-202`) → `provider.dispatch` → `spawnCli` — **it never
   touches the subagent service**, so `maxActiveSubagents` cannot bound it.

2. *Is it bounded by provider-internal limits?* No. Each provider is an
   independent `spawn` (`src/runner.js:36-42`); there is no shared pool, no
   queue, no token. `maxConcurrent` from `config.defaults` is consumed only by
   `createSemaphore` in `src/tools.js:220`, which `runRoundtable` never receives
   (it is constructed with `{ registry, prompt, rounds, providerIds, cwd,
   timeoutMs, signal }`, `src/tools.js:405-412` / `src/http.js:421-429`).

3. *Is `Promise.all` a bound?* No — it is the opposite. `Promise.all(tasks)`
   (`src/roundtable.js:41`) starts **every** task immediately. Measured with the
   plugin's real `runRoundtable` and 8 members:

   ```
   8 providers, rounds=1 -> peak concurrent dispatch: 8 | wall 61 ms | entries 8
   ```

   Peak concurrency equals the member count exactly. With the default config
   (`src/config.js:17-22`) that is 4 for round 1; round 2 re-fans to every
   member that succeeded, so the peak is `members × (1 for each round)` — small
   in absolute terms, but **unbounded in the variable that matters**: it scales
   with the number of configured providers and ignores `maxConcurrent: 3`.

**A mitigating fact I found (this is why the impact is smaller than implied):**
`maxConcurrent` is *itself* largely decorative on the foreground path, because
`agent_roundtable`'s inline branch (`src/tools.js:400-403`) never consults the
gate either — only `dispatchForeground` does (`src/tools.js:233`). So the
inconsistency is "roundtable has no gate" rather than "roundtable escapes a
gate that otherwise applies to it."

**Corrected severity: medium**, not high. Four concurrent `spawn`s is not a
thundering herd; the real cost risk is *rounds × providers* against a
rate-limited API, which `rounds` clamps to 3 (`src/roundtable.js:23`) and the
provider list bounds.

---

## Part 2 — Stress-testing the proposed fixes

Each patch below is evaluated for **new defects it would introduce**, assuming
it is applied naively (the way a report's "fix" block would be copy-pasted).

### P1 — `try/catch` around `jobs.start()` returning `undefined`

**Verdict: DANGEROUS AS WRITTEN — and it has ALREADY BEEN APPLIED in exactly
that form (commit `2f6660e`), so the defect below is live at `b5693d8`.**

The shipped code is `src/tools.js:130-141`:

```js
function startJob(ctx, spec) {
  const jobs = serviceOf(ctx, 'jobs')
  if (jobs === undefined || jobs === null || typeof jobs.start !== 'function') return undefined
  try {
    return jobs.start(spec)
  } catch (error) {
    const logger = serviceOf(ctx, 'logger')
    if (logger !== undefined && typeof logger.warn === 'function') {
      logger.warn('agent-alliance: background job unavailable, running inline: ' + String(...))
    }
    return undefined
  }
}
```

and the panel equivalent at `src/http.js:449-463`. Both catch **everything**.

**The patch.** Wrap `startJob()` (`src/tools.js:123-127`) and the panel's
`jobs.start` (`src/http.js:434`) in `try { … } catch { return undefined }`, so
the existing `jobId === undefined` fallback runs inline.

**Why it is wrong — the catch is not selective.** `LocalJobRegistry.start` has
(at least) **four** distinct preflight throws before registration
(`dsh-jobs-local/lib/index.js:412-419`):

```
413  resolveOwner(spec.owner)      -> "background job ownership requires the agent registry…"
                                     or  'session "…" has no live agent (background job owner must be live)'
414  servesOwner(owner)           -> "background jobs unavailable: no job controller serves this agent…"
415  spec.kind.length === 0       -> "invalid job kind…"
419  activeJobCount(owner) >= cap -> "background job limit reached for this owner (limit: N)…"
```

I verified the last two are indistinguishable by shape — both are plain
`Error` with no `code` and no `name` set by the registry — and re-verified that
against the **shipped** `startJob` at HEAD:

```
second start threw  : background job limit reached for this owner (limit: 1); use
                      job_kill to stop an unneeded job, wait for it to finish, then retry
no-controller threw : background jobs unavailable: no job controller serves this agent
                      (load @deepseek-ai/dsh-tool-jobs in its composition)
Both are plain Error; no .code, no .name discriminator
```

So the naive catch swallows **the concurrency cap** too. Verified with the
patched function against a real registry configured `maxConcurrentJobsPerOwner:
1`:

```
job 1 (cap=2): agent-alliance-44eee8580ee84e58
job 2 (cap=2): agent-alliance-6b13412573d84b68
job 3 (cap=2): undefined <-- returned undefined => CALLER RUNS INLINE
```

A third dispatch past a 2-job cap is silently converted into inline execution.

**Aggravating detail: the warning that was supposed to make this visible never
fires.** Both call sites fetch the logger with `serviceOf(ctx, 'logger')` /
`ctx?.get?.('logger')`. In Cordis, `logger` is a **service object**, not a
provider-registered service, so `ctx.get('logger')` returns `undefined` while
`ctx.logger` is a function:

```
root.get('logger')   : undefined (undefined)
root.logger          : function
root.logger?.warn    : function
```

So `serviceOf` falls through to `ctx?.['logger']` — but only in the *fake-context*
branch; on a real Cordis context
(`dsh-tools`-style `ctx.get` returning `undefined`) the guard
`if (resolved !== undefined) return resolved` misses, and the fallback
`ctx?.[service]` throws `cannot get property "logger" without inject`
(verified earlier: `viaProp: 'THREW: cannot get property "jobs" without
inject'`), which `serviceOf` catches and converts to `undefined`. **Net result:
no warning is ever logged, on the exact path the patch added to make the
fallback observable.** I confirmed empirically: the probe above produced no
`background job unavailable` line at all.

**New defect introduced (LIVE at `b5693d8`).** The cap exists to protect the
host from the exact workload this plugin generates (external agent processes). With the patch, the
2nd, 3rd, … dispatch does not fail — it silently runs **synchronously inside the
tool call / HTTP request**, bypassing the cap *and* the background-job output
ring. The caller therefore waits for the full external CLI under a
`timeoutMs` budget of `defaultTimeout * 4` (`src/tools.js:238`), i.e. up to
**20 minutes** for the foreground fallback, with no `jobId` to poll or kill.
Before the patch, the model got an actionable error telling it to `job_kill`
something; after the patch, it gets an unkillable multi-minute stall.

**Second new defect — the panel deadlocks its own tab.** `client.js:965-970`
`await request('/roundtable', …)` keeps the tab in `busy` state until the
response arrives (`setBusy(true)` at `:958`, cleared only in `finally` at
`:973`). With the patch, a capped-out `/roundtable` becomes an inline
`runRoundtable` that can run `rounds × providers` external CLIs — the tab
appears frozen for minutes and the Cancel button never renders (it is gated on
`jobId !== ''`, and `jobId` is empty on the inline path).

**Correct form (still applicable — this is a live bug, not a hypothetical).**
Catch *narrowly*: only treat the "no controller" and "no agent registry"
conditions as "jobs unavailable", and **re-throw** the cap. Also use
`ctx.logger` (the real accessor) rather than `ctx.get('logger')`:

```js
function startJob(ctx, spec) {
  const jobs = serviceOf(ctx, 'jobs')
  if (jobs === undefined || jobs === null || typeof jobs.start !== 'function') return undefined
  try { return jobs.start(spec) }
  catch (error) {
    const message = String(error?.message || '')
    if (!/no job controller serves|ownership requires the agent registry/.test(message)) {
      throw error          // cap, invalid kind, invalid label, bad outputLimitBytes
    }
    ctx.logger?.warn?.('agent-alliance: background job unavailable, running inline: ' + message)
    return undefined
  }
}
```

Because the registry provides no `code`, matching on prose is the only option
available to a dependency-free plugin — which is itself worth reporting
upstream as a missing discriminator (a `HarnessError` with a code here would
make this patch a one-liner without string matching).

---

### P2 — Hoisting the resume guard above `startActivation`

**Verdict: SAFE in effect — and it HAS LANDED (`2f6660e`), but it shipped with
the exact ordering flaw I predicted below, so the diagnosis regression is
live.**

**The patch.** Move `if (hasResumeId(request.resumeSessionId)) throw
resumeRejection(providerId, providerName)` from `src/backend.js:248` to before
`src/backend.js:232`.

**What I attacked it with.**

1. *Does the guard need `route`?* `resumeRejection(providerId, providerName)`
   needs `providerName`, which is bound in the closure at
   `src/backend.js:206-212` (`subagentBackend({ …, providerName, … })`) — a
   value fixed when `resolve()` chose the subagent path
   (`src/backend.js:327-336`). It does **not** need `activation`, so hoisting is
   mechanically possible with no data dependency.
2. *Does it change the error for the `route === undefined` case?* **Yes — and
   the shipped patch has this bug.** At HEAD the guard is at
   `src/backend.js:232`, *above* the `route === undefined` check at `:233-236`.
   I verified the resulting misdiagnosis against a backend whose provider was
   unregistered after `resolve()`:

   ```
   stale-route + resume: resumeSessionId is not supported on the official subagent path …
   stale-route, no resume: official subagent provider "claude-code" is no longer registered
   ```

   The first line is **wrong about the cause**: the call also failed because the
   provider is gone, but the user is told their `resumeSessionId` was rejected.
   The correct placement is above `startActivation` but *below* the
   `route === undefined` check — both precede the side effect, so the ordering
   costs nothing. This is a **low-severity live defect introduced by the fix**,
   and it is the one thing in this report that is both new and actionable.
3. *Does anything rely on the child existing?* No. The rejection is thrown, the
   `finally` block's `dispose()` is skipped entirely (no `activation` to
   dispose), and the caller gets the same `Error` message text. Nothing
   downstream reads `externalSessionId` for this path because the throw
   precedes the return.
4. *Cost of leaving it where it is (for contrast):* the whole spawn +
   handshake + teardown described in D.

**New defect introduced: none found.** The only requirement is the ordering
constraint in (2). I record it as the recommended patch.

---

### P3 — Reordering the round-2 prompt to put `basePrompt` first

**Verdict: SAFE functionally, but it does NOT buy the cache win that motivates
it, and it silently changes what the *peer* half of the prompt means.**

**The patch.** In `src/roundtable.js:8-16`, move `String(basePrompt)` to the
front of the joined array so the round-2 prompt shares a prefix with round 1.

**What I attacked it with.**

1. *Does anything downstream parse the `【第N轮辩论】` header?* I grepped every
   consumer of roundtable output — `src/tools.js:13`, `src/http.js:14`, and
   `client.js`. The header is produced only in `buildDebatePrompt`
   (`src/roundtable.js:11`) and **never parsed anywhere**: `formatRoundtableText`
   (`:58-84`) consumes the structured `result.debate`, not the prompt string;
   the client renders `data.text` as opaque preformatted text
   (`client.js:925-928`), and there is no `split('━━')`, no `轮辩论` match, and
   no i18n key for it in `locale/{en,zh}.json`. **Refutation attempt fails to
   find a parser — the header is free to move.**
2. *Do the tests enforce position or presence?* `tests/roundtable.test.js:77`
   asserts `assert.match(pA, /第2轮辩论/)` — a **presence** match, not a prefix
   or position assertion. I confirmed a reordered prompt still satisfies every
   existing assertion:

   ```
   original  | /第2轮辩论/ -> true | /【b】[\s\S]*观点B/ -> true
   reordered | /第2轮辩论/ -> true | /【b】[\s\S]*观点B/ -> true
   ```
   So the patch would pass CI without any test edit — which is itself a risk,
   see (4).
3. *Does it actually create a reusable prefix?* **Only against the round-1
   prompt of the same member, and only if `rounds > 1`.** Round 1 sends
   `String(basePrompt)` verbatim (`:6`) — no wrapper at all. Round 2 with the
   patch would send `basePrompt + '\n…header…'`, which shares the `basePrompt`
   prefix. That is a genuine prefix-cache win *for round 2+ of the same
   provider* — but the provider's own session is not reused (every dispatch is
   a fresh `spawn`, `src/runner.js:36`), so the cache must be a server-side
   exact-prefix cache keyed on the prompt text; whether that hits depends
   entirely on the external CLI's provider. **The patch is a necessary but not
   sufficient condition.**
4. *What it loses.* The header `【第N轮辩论】` currently tells the *model* which
   round it is in and that a response dialectic is expected
   (`请针对上述观点进行回应…`, `:16`). Moving it after the base prompt is
   harmless semantically, but the base prompt now *looks* like a fresh question
   before the model reaches the instruction, which measurably weakens
   instruction-following for weaker models. A safer variant keeps the header
   first but **repeats** the base prompt after it (cost: duplicated tokens).

**New defect introduced: one real one.** Because no test asserts header
*position*, a future refactor could move it again with no signal. If the patch
lands, add `assert.ok(pA.startsWith('问题Q'))` so the cache-relevant property is
pinned by a test rather than by a comment.

---

### P4 — Filtering roundtable members through `enabled` + `detectAll()`

**Verdict: DANGEROUS — it would put up to 50 seconds of blocking subprocess
probing inside a request the panel issues on every tab open.** *Not yet
applied; this is the only one of the four patches still purely hypothetical.*
Its premise is unchanged at HEAD: `resolver.list()` still hardcodes
`available: true` at `src/backend.js:177,211,359,370`, verified. The exact same
probe can be fixed for free — see the sub-section at the end.

**The patch.** Have `/state` (and/or roundtable member selection) call
`registry.detectAll()` and drop providers with `available !== true`, plus honor
`providers.<id>.enabled`.

**What I attacked it with — measured, on this host.**

1. *Does `detectAll` spawn processes?* **Yes, one per provider.** Every
   `detect()` in this plugin is a real `--version` subprocess:
   `src/provider/claude.js:31-32` (`spawnCli({argv:[grun, claudeBin,
   '--version'], timeoutMs: 15000})`), `codex.js:30-32`
   (`timeoutMs: 20000`), `opencode.js:33-34` (`timeoutMs: 15000`),
   and `zcode` returns early only when disabled. `detectAll` runs them
   **sequentially** (`src/provider/types.js:28-40`, a `for` loop with `await`).
2. *Measured cost, CLIs absent (the common case on this host):* **60 ms** for
   all four, because ENOENT fails immediately.
3. *Measured cost, CLI present:* one successful `claude --version` through the
   real spawn path averaged **49 ms**; extrapolated `detectAll` ≈ **197 ms**.
4. *Worst case — a CLI that hangs at startup:* the `timeoutMs` values are the
   ceiling, and they add up: `15000 + 20000 + 15000 = 50 000 ms`. A single
   `/state` response could block for **50 seconds**.
5. *How often is `/state` called?* **Four** independent `useLoad(() =>
   request('/state'), [])` mounts — `client.js:565` (state tab), `:676`
   (sessions tab), `:793` (dispatch tab), `:929` (roundtable tab). `useLoad`
   (`client.js:441-460`) fires on mount and on every `retry`, and each tab mount
   is a fresh fetch when the user switches tabs (the component unmounts). So
   merely clicking through the four tabs issues **4** `/state` requests.
   With detection wired in, that is `4 × detectAll` = **787 ms** of subprocess
   probing on a healthy install, and up to **200 s** on a host with one hung
   CLI. There is no cache: `detectAll` is invoked fresh each call.

**New defect introduced (three, in order of severity).**

- **Blocking I/O in a hot request path.** `/state` is currently a pure
  in-memory projection (`src/http.js:329-332`, `resolver.list(undefined)`).
  The patch makes it spawn up to 4 child processes. During a hung probe the tab
  spinner stays up for 50 s and the user's only recourse is a page reload,
  which re-enters the same probe. This is a **far worse** defect than the
  inaccuracy it fixes.
- **`enabled` is not a registry concept, so the filter is a no-op for three of
  four providers.** Only `zcode` consults `config.enabled`
  (`src/provider/zcode.js:37,48`). `claude`, `codex`, and `opencode` contain no
  reference to `enabled` at all (verified by grep). So a user who sets
  `providers.claude.enabled: false` expects it to disappear; with a filter
  applied only in the roundtable/panel layer it would vanish from the panel but
  remain dispatchable through `agent_dispatch`, which calls
  `resolver.resolve` → `registry.get` → the provider directly
  (`src/backend.js:338`). **Half-enforced config is worse than unenforced
  config**, because it makes the setting look authoritative.
- **Hiding an unavailable provider removes the diagnosis.** Right now
  roundtable records a per-member failure and `formatRoundtableText` prints
  `[claude] 失败: <reason>` (`src/roundtable.js:77`). That is *exactly* the
  information a user needs. Filtering unavailable members out would make a
  misconfigured deployment look like a 1-member roundtable that "worked".

**Correct form.** Do not detect on the request path. Either (a) detect once at
`apply()` and cache the result with an explicit refresh action, or (b) keep
`detectAll` out of `/state` entirely and surface the per-member failure that
roundtable already produces. For `enabled`, enforce it in `createRegistry` /
`buildProviders` so every path (tool, panel, roundtable) sees the same set,
rather than filtering at one call site.

**A mitigation the prior reports missed:** the roundtable's own
`roundtableRegistry.get()` already throws for `available === false`
(`src/tools.js:407-409`) and `runRoundtable` catches per-member
(`src/roundtable.js:36-38`), so unavailable providers are reported, not
dispatched-and-crashed. The real pre-existing bug is different and worse:
**`resolver.list()` hardcodes `available: true` for every CLI backend**
(`src/backend.js:177`, also `:211`, `:359`, `:370`), so `available === false`
is *never true on the CLI path* — verified:

```
resolver.list(undefined):
 [ {id:'claude',  kind:'cli', available:true}, {id:'codex',  kind:'cli', available:true},
   {id:'opencode',kind:'cli', available:true}, {id:'zcode',  kind:'cli', available:true} ]
```

while the same four providers actually report:

```
claude   detect.available = false | spawn /data/data/com.termux/files/usr/bin/grun ENOENT
codex    detect.available = false | MODULE_NOT_FOUND
opencode detect.available = false | spawn /home/dsh/.local/share/xucodex/opencode/bin/opencode ENOENT
zcode    detect.available = false | zcode 未启用
```

So the panel's "providers" list claims four healthy backends on a host where
**none** work. That is the defect worth fixing — and it can be fixed without
putting `detectAll` on the request path.

**The cheap alternative P4 should have proposed.** `agent_dispatch`'s failure
for an unavailable CLI is already accurate and already reaches the model:
`provider.dispatch` throws `'claude dispatch 失败 (exit -1): spawn … ENOENT'`
and the registry materializes it as a structured tool error (verified in the
framework audit). So the panel does not need ground truth to be *useful*; it
needs to stop asserting a fact it has not checked. Change `available: true` to
`available: undefined` plus a `detail: 'not probed'`, and let the UI render
three states instead of two. That is a two-line change with no subprocess, no
cache, and no timeout risk — strictly better than P4 at every cost point.

**Update — P4 was written while I audited, and I reviewed the actual code.**
An uncommitted working-tree change to `src/http.js` (not mine; another
teammate's) implements P4 with a 30 s TTL cache (`DETECT_TTL_MS`). I tested that
implementation directly rather than the hypothetical. Two results:

1. **Good news — the TTL defeats the sequential storm I predicted.** A
   four-tab sweep now invokes `detectAll` **once**, not four times:

   ```
   sequential 4-tab sweep   -> detectAll invocations: 1
   after TTL expiry         -> detectAll invocations: 2
   ```

   And the tabs are genuinely exclusive (`client.js:1211-1217` renders one
   `Tab` at a time), so the four `useLoad('/state')` mounts never fire
   simultaneously in practice. My concurrency worry was overstated; the patch
   author solved it.

2. **New defect — the fail-open branch contradicts its own comment, and it
   re-creates the exact lie the patch exists to remove.** The code is:

   ```js
   const probe = byId.get(info.id)
   if (probe === undefined) return info        // comment: "Unknown stays unavailable"
   ```

   `info` comes from `resolver.list(undefined)`, whose `available` is the
   hardcoded `true` at `src/backend.js:177`. So when `detectAll` throws (caught
   by `catch { rows = [] }`), **every provider is reported available again**:

   ```
   detectAll failed entirely. /state now reports:
      claude    available = true | detail = (none)
      codex     available = true | detail = (none)
      opencode  available = true | detail = (none)
      zcode     available = true | detail = (none)
   ```

   The comment says "Unknown stays unavailable"; the code returns the one value
   that is *not* unavailable. The fix is one line — treat a missing probe as
   unknown, never as `info`:

   ```js
   if (probe === undefined) return { ...info, available: false, detail: 'availability not probed' }
   ```

3. **Residual cost the TTL does not remove.** The first `/state` after load, and
   the first after each 30 s TTL expiry, still blocks on sequential `--version`
   probes with `15000 + 20000 + 15000` ms of headroom. On a host with one hung
   CLI that is still a 50-second spinner. Cheaper: probe lazily *after*
   responding (return cached-or-unknown immediately, kick the probe, let the
   next poll pick it up), which makes the worst case invisible to the user
   instead of bounded-but-huge.

---

## Part 3 — Verdict table

Status column: **LIVE** = still true at `b5693d8`; **FIXED** = the claim was
true at `2d68e3f` but commit `2f6660e`/`b5693d8` closed it.

### Claims

| # | Claim | Verdict | Status | Severity | Reason |
| --- | --- | --- | --- | --- | --- |
| D | resume rejected only after a billed child | **CONFIRMED** (was) | **FIXED** (`src/backend.js:232`) | was medium → now low | No resume field exists in `SubagentStartRequest`, so no provider could pre-validate. Guard now runs first — verified: `startActivation was called: 0`. |
| E | already-aborted signal still executes dispatch | **OVERSTATED** | **FIXED** (`src/tools.js:58-60`) | was high → now **low, new form** | The registry already returned `ABORTED_BEFORE_DISPATCH` before the body (`dsh-tools/lib/index.js:3390-3400`); the prior reproduction bypassed it by testing the semaphore alone. The landed fix rejects with a bare `Error`, losing abort identity — a new low-severity issue. |
| F | agent_dispatch duplicates the official tool, opposite semantics | **OVERSTATED** | **LIVE (by design)** | low | `dsh-subagent-codex` / `-claude-code` are **not installed** (only in the source checkout at `0.2.1-alpha.2`); tool names differ so both register cleanly. "Opposite" is wrong — different *delivery models*, not opposite semantics. |
| G | roundtable bypasses maxConcurrent | **CONFIRMED** | **LIVE** | medium | Measured peak concurrency = member count (8/8). No gate exists on that path at all, so nothing is "bypassed"; the fan-out is provider-count-bounded and `rounds` clamps to 3. |

### Proposed patches

| # | Patch | New defect? | Status | Severity of the new defect |
| --- | --- | --- | --- | --- |
| P1 | `try/catch` around `jobs.start` → `undefined` | **YES** | **LANDED AS-IS** (`2f6660e`) — the naive form | **high** |
| P2 | hoist resume guard above `startActivation` | ordering flaw only | **LANDED, with the flaw** | low |
| P3 | reorder round-2 prompt (`basePrompt` first) | none functional | not applied | low (missing test guard) |
| P4 | filter members via `enabled` + `detectAll()` | **partly solved, one new bug** | **in-flight in the working tree** | medium |

### The single most dangerous side effect

**P1's catch is not selective, and the registry gives it no way to be — and the
patch has already shipped in that form.**

All four `LocalJobRegistry.start` preflight failures
(`dsh-jobs-local/lib/index.js:413-419`) are plain `Error`s with no `code` and no
`name`:

```
background job limit reached for this owner (limit: 1); use job_kill to …
background jobs unavailable: no job controller serves this agent (load …)
```

The first is a **capacity** signal the caller must obey; the second is a
**composition** signal that legitimately means "run inline". The shipped
`startJob` (`src/tools.js:130-141`) and the panel route
(`src/http.js:449-463`) catch both. Verified against the shipped function with a
real registry at `maxConcurrentJobsPerOwner: 2`:

```
job 1 (cap=2): agent-alliance-44eee8580ee84e58
job 2 (cap=2): agent-alliance-6b13412573d84b68
job 3 (cap=2): undefined <-- returned undefined => CALLER RUNS INLINE
```

Three consequences, in order of severity:

1. **Backpressure becomes an unbounded foreground stall.** The 3rd dispatch
   does not fail — it runs inline under the foreground budget
   `Math.min(args.timeoutMs || defaultTimeout, defaultTimeout * 4)`
   (`src/tools.js:238`) = up to **20 minutes**, with no `jobId` to poll or kill.
2. **The panel freezes with its Cancel button hidden.** `client.js:958-973`
   awaits `/roundtable` and clears `busy` only in `finally`; the cancel
   affordance is gated on `jobId !== ''`, which the inline path never sets.
3. **The diagnostic the patch added never fires.** Both call sites look up the
   logger with `ctx.get('logger')` / `ctx?.get?.('logger')`, but `logger` is a
   Cordis **built-in accessor**, not a registered service: `ctx.get('logger')`
   returns `undefined` while `ctx.logger.warn` is a function (verified). The
   `serviceOf` fallback then throws `cannot get property "logger" without
   inject`, which its own `catch` swallows — so the `background job unavailable,
   running inline:` line is never emitted. My probe reproduced exactly this: no
   warning appeared.

### The cheapest real improvement (free, no new risk)

Not one of the four proposed patches: **stop asserting `available: true` for a
backend nobody probed** (`src/backend.js:177,211,359,370`). Today `/state`
reports four healthy providers on a host where `detectAll` shows **all four
`available: false`**. Reporting `available: undefined` + `detail: 'not probed'`
and letting the UI render a third state costs two lines, no subprocess, and no
timeout exposure — it fixes the lie P4 was invented to fix, without P4's
50-second worst case.

### Notes on my own confidence

- **D and G were the two CONFIRMED verdicts.** D rests on reading the whole
  `startActivation → startExternal → materializeTracked → provider.start` chain
  in the installed lib plus Codex's `spec.spawn(...)`-before-return. G rests on
  a direct measurement (peak 8 for 8 members). D's defect was then fixed
  independently while I audited, which strengthens rather than weakens the
  verdict.
- **E's downgrade rests on one empirical run** against a real `ToolRuntime`. It
  is the strongest piece of new evidence here, and it contradicts the prior
  audit's method (semaphore in isolation rather than through the registry).
- **F's downgrade rests on the installed tree lacking the official bundles.** If
  a future rc ships them by default, F returns to medium.
- **The genuinely new findings in this report are all consequences of the
  fixes, not of the original code:** P1's swallowed capacity signal (**high**,
  landed `2f6660e`), P2's stale-route misdiagnosis (**low**, landed `2f6660e`),
  and the in-flight P4's fail-open branch that re-asserts `available: true`
  whenever the probe fails (**medium**, uncommitted working tree). None of the
  three existed at the audit's starting commit.
- **Method note, in fairness to the prior reports.** Two of the four claims I
  was asked to refute were closed by a fix commit that landed *during* this
  audit. I kept the as-of-`2d68e3f` analysis and marked it FIXED rather than
  deleting it, because a reader needs to know which findings are still
  actionable. Everything marked LIVE in the tables above was re-executed
  against `b5693d8` after the fixes landed.
