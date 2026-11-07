# Adversarial Audit A2 — refutation pass and fix stress-test

**Subject:** `dsh-agent-alliance` 0.2.0, commit `2d68e3f`
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

**VERDICT: CONFIRMED** — I could not refute it, and I found the consequence is
*worse* than the original claim states.

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

2. *Does the plugin's guard run first in some path?* Only in the HTTP path,
   trivially, because `src/http.js` passes `resumeSessionId` straight through
   to a **CLI** backend (`src/http.js:396`) and never reaches the subagent
   branch — `backendOf()` supplies no parent (`src/http.js:274-276`). So the
   subagent path and the resume parameter can only meet through
   `agent_dispatch`. In that path the order is fixed:
   `src/backend.js:232` `await route.service.startActivation(...)` runs, and
   only at `src/backend.js:248` does
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

**What would refute it (and does not exist):** a `signal.aborted`/`resume`
precheck inside `SubagentRuntime.startActivation` before `provider.start`, or a
`resumeSessionId` field in `SubagentStartRequest` that a provider validates.
Neither is in the installed lib.

---

### (E) "an already-aborted signal still executes dispatch"

**VERDICT: OVERSTATED — mechanism real, reachability wrong.** I found a
framework-level mitigation the prior audit missed for the *normal* tool path.

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

---

## Part 2 — Stress-testing the proposed fixes

*(four patches appended below as completed)*

---

## Part 3 — Verdict table

*(filled at the end)*
