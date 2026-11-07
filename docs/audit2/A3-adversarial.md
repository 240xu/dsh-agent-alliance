# A3 — Adversarial audit of the planned / in-flight patches

Role: red-team the implementation of the 7 first-batch fixes **before** they are finalised.
Repo `dsh-agent-alliance`, audited at `2d68e3f` (audit commit) with the Lead's fix work observed in
progress. READ-ONLY: this file is the only artifact.

**Status: complete.** Final state re-verified at `1b15214`.

## Bottom line for the Lead

**One defect blocks release: R6.3 — the `maxConcurrent` semaphore loses its accounting.** It is pre-existing, not
introduced by any of the seven fixes, but **Fix 6 turns it into a user-visible regression**: the first roundtable
after a promotion is bounded, the second runs at double the configured limit, and no test can see it because every
existing concurrency test measures a single batch. Root cause is one missing `active += 1` on the promotion path
(`src/tools.js:56-99`). Corrected implementation and two pinning tests are in "R6.3 — STILL OPEN at `1b15214`".

**Everything else is either fixed or acceptable as-is.** Fixes 5, 6 and 7 landed with all three of the edge cases
this audit flagged already handled; Fixes 1 and 3 were repaired on the strength of A2's findings; the residual
items (R4.3 abort-result shape, R5.1 missing prefix test, R6.2 member-failure wording) are polish, not blockers.

## What was actually reviewed

The Lead began patching while this audit ran, so this report reviews the **real diffs**, not hypothetical
ones. That is strictly better than reviewing a plan: every claim below is against code that exists.

| Fix | Status at `2d68e3f` | Status at `1b15214` | Where |
|---|---|---|---|
| 1. `startJob` catches + inline fallback | committed, 2 defects | **fixed** (`f6eaf59`) | `src/tools.js`, `src/http.js` |
| 2. `/state` real availability | not started | **committed** (`446a5f9`), fail-closed after `f6eaf59` | `src/backend.js`, `src/http.js` |
| 3. `resumeSessionId` guard moved up | committed, 1 defect | **fixed** (`f6eaf59`) | `src/backend.js` |
| 4. pre-aborted signal rejected | committed | committed, R4.3 residual | `src/tools.js:45-99` |
| 5. round-2 prompt starts with `basePrompt` | not started | **committed** (`3837623`), all traps avoided | `src/roundtable.js:17-33` |
| 6. roundtable inside `maxConcurrent` | not started | **committed** (`3837623`), **gated on R6.3** | `src/tools.js:438-446` |
| 7. exclude member's own prior answer | not started | **committed** (`3837623`), history untouched | `src/roundtable.js:17-24` |

Verification baseline moved from **188 pass** at review start to **197 pass / 0 fail** at `1b15214`.

---

## FIX 1 — `startJob` guard + inline fallback (committed)

**Patch as written** (`src/tools.js`):

```js
function startJob(ctx, spec) {
  const jobs = serviceOf(ctx, 'jobs')
  if (jobs === undefined || jobs === null || typeof jobs.start !== 'function') return undefined
  try {
    return jobs.start(spec)
  } catch (error) {
    const logger = serviceOf(ctx, 'logger')
    if (logger !== undefined && typeof logger.warn === 'function') {
      logger.warn('agent-alliance: background job unavailable, running inline: ' + String(error?.message || error))
    }
    return undefined
  }
}
```

### R1.1 — `serviceOf(ctx, 'logger')` is always `undefined`: the diagnostic never fires

Verified live against the installed Cordis:

```
$ node ctx-logger-probe.mjs
ctx.get("logger")      => undefined
ctx.logger            => function
child.get("logger")   => undefined
child.logger.warn     => function
```

`logger` is a **Context property** (`vendor/cordis/src/context.ts:81`, `this.logger = new LoggerService(self)`),
not a registry service, so `ctx.get('logger')` returns nothing (`reflect.ts:227-230` consults `reflect.props` and
the service store; `logger` is in neither).

**Correction to an earlier draft of this section.** I first wrote that the `tools.js` diagnostic is dead. It is
not: that patch calls the plugin's own `serviceOf(ctx, 'logger')`, which falls back to a bare property read
(`src/tools.js:118-121`), and a live probe against the installed Cordis confirms it resolves:

```
$ node real-logger.mjs
serviceOf(ctx,"logger") type = function
logger.warn type            = function
=> R1.1 claim "always undefined" is: FALSE
```

So **`tools.js` logs correctly, and `http.js` does not.** The two call sites use different mechanisms, and only
one of them works:

| site | mechanism | resolves? |
|---|---|---|
| `src/tools.js:126-129` | `serviceOf(ctx, 'logger')` → falls back to `ctx.logger` | **yes** |
| `src/http.js:500` | `ctx?.get?.('logger')` → no fallback | **no** |

```
$ node http-logger.mjs
http.js uses ctx?.get?.('logger') => undefined   <-- the log is DEAD
tools.js uses serviceOf(ctx,"logger") which falls back to ctx.logger => function
```

**BAD vs CORRECT** (for `src/http.js:498-503` only)

```js
// BAD (as committed): no property fallback, so the warning never fires
const logger = ctx?.get?.('logger')
if (logger !== undefined && typeof logger?.warn === 'function') logger.warn(...)

// CORRECT: match what tools.js already does
const logger = serviceOf(ctx, 'logger')            // or: ctx?.logger
if (typeof logger?.warn === 'function') logger.warn(...)
```

Severity for this finding is therefore **low**, not high: it silences one warning on one fallback path, and the
behaviour (inline roundtable) is still correct.

### R1.2 — the catch swallows *every* start failure, not just the missing-controller one

`jobs.start()` has six distinct throw sites (`dsh-jobs-local/lib/index.js:414-435`):

```
its own docstring paragraph above lists: controller, empty kind, empty label,
invalid outputLimitBytes, owner-without-agent-registry, per-owner job limit, unknown owner
```

The patch cannot tell them apart. A typo'd `label` (never possible here — computed), or more realistically
**`background job limit reached for this owner (limit: N)`**, now degrades to a silent inline run that blocks the
tool call for minutes instead of returning "too many jobs, kill one". The user asked for fire-and-forget and
gets a multi-minute foreground hang with no explanation.

The per-owner limit is the realistic case. Measured default: `DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER = 10`
(`dsh-jobs-local/lib/index.js:340`), enforced at `:421-422`. Ten is not easily hit by one careful user, but a
long-lived Session that starts roundtables (background **by default**) without collecting them reaches it, and
after Fix 1 it no longer learns that it did. Correction to an earlier draft of this section: the default is 10,
not "small", so this is a *latency* and *diagnosability* defect rather than a routine one.

**BAD vs CORRECT**

```js
// BAD: all-or-nothing
try { return jobs.start(spec) } catch { return undefined }

// CORRECT: degrade only on the controller refusal, rethrow the rest
try {
  return jobs.start(spec)
} catch (error) {
  const message = String(error?.message ?? error)
  if (!message.includes('no job controller serves this agent')) throw error
  logInlineFallback(ctx, message)
  return undefined
}
```

Caveat before adopting this: string-matching a framework message is fragile. The durable fix is for the *host* to
expose a typed refusal code; until then, matching the one message is still better than swallowing capacity
errors, and the test below pins the behaviour either way.

### R1.3 — `http.js` fallback reuses a dead controller and drops `owner`

In `src/http.js` the inline path is now reachable *after* a `jobs.start` refusal, but it calls
`produce(new AbortController().signal)` — a **fresh** controller that nothing can abort. Previously the inline
path only ran when no jobs service existed at all. Now a panel roundtable that hits a capacity limit runs to
completion with no way to cancel it from the Tasks UI (`POST /tasks/kill` finds no job).

**Test that catches R1.1–R1.3**

```js
test('startJob degrades only on a controller refusal and logs through ctx.logger', async () => {
  const warnings = []
  const ctx = {
    tools: { register: () => () => {} },
    logger: { warn: (m) => warnings.push(m), info() {}, error() {} },   // property, not service
    get: (n) => (n === 'jobs' ? {
      start() { throw new Error('background jobs unavailable: no job controller serves this agent') },
    } : undefined),
  }
  const tool = /* registerTools(...) */ find('agent_dispatch')
  const value = await tool.execute({ provider: 'fake', prompt: 'x', background: true }, { signal: new AbortController().signal })
  assert.equal(value.kind, undefined, 'must fall back to the foreground value')
  assert.equal(warnings.length, 1, 'the degradation must be logged via ctx.logger')
  assert.match(warnings[0], /no job controller/)

  // and the capacity error must NOT be swallowed
  ctx.get = (n) => (n === 'jobs' ? { start() { throw new Error('background job limit reached for this owner (limit: 4)') } } : undefined)
  await assert.rejects(() => tool.execute({ provider: 'fake', prompt: 'x', background: true }, {}), /limit reached/)
})
```

### R1.4 — edge case the naive version gets wrong: a `start()` that returns a non-string

`jobs.start` is typed to return `JobId`, but the guard is `jobId === undefined`. A future host change returning
`null`, or a fake test double returning `''`, takes the "started" branch and returns
`{ kind: 'background', jobId: null }` to the model — a handle to nothing.

```js
// CORRECT: treat only a non-empty string as a started job
const id = jobs.start(spec)
return typeof id === 'string' && id !== '' ? id : undefined
```

---

## FIX 2 — `/state` through `detectAll()` (not yet started)

The report's proposed patch:

```js
const detected = await registry.detectAll()
const stateOf = (id) => detected.find((d) => d.id === id)
// per row: available: stateOf(providerId)?.available === true
// and drop config.providers[id].enabled === false from providerIds()
```

### R2.1 — measured cost: serial spawns, each with a 15–20 s timeout

Measured on this machine (`/tmp/detect-cost.mjs`, real `buildProviders()`):

```
detectAll wall time: 132 ms
second call: 87 ms
  claude    available=false spawn /data/data/com.termux/files/usr/bin/grun ENOENT
  codex     available=false ...   opencode available=false ...   zcode available=false
```

132 ms is the *fast* case — all four fail to spawn instantly. The timeouts are the real exposure:

| provider | detect timeout | source |
|---|---|---|
| claude | 15 000 ms | `src/provider/claude.js:33` |
| codex | 20 000 ms | `src/provider/codex.js:32` |
| opencode | 15 000 ms | `src/provider/opencode.js:34` |
| zcode | no spawn (template check) | `src/provider/zcode.js` |

`detectAll()` is **serial** (`src/provider/types.js:28-40` — `for … await p.detect()`), so one wedged CLI can hold
the call for 20 s, and the sum of timeouts is 50 s. `claude`'s detect runs `grun` *plus* a native binary — a
Termux shim on a non-Termux host, exactly the configuration this machine has — so a hang there is realistic.

### R2.2 — the panel polls, and `/state` is not the only caller

`client.js` reads `/state` on mount and on every refresh; `resolver.list(parent)` is also called **per
roundtable member** inside `agent_roundtable` (`src/tools.js:381-383`, `:398`) through `roundtableRegistry.list`
and `get`. If `list()` becomes async or blocks on detection, a 4-member roundtable performs the detection
5+ times before dispatching anything. A naive "await detectAll() inside list()" turns one slow probe into a
per-call latency multiplier.

### R2.3 — `enabled: false` filtering changes resolution semantics, not just display

The report says to drop disabled providers from `providerIds()`. `createBackendResolver.providerIds()` feeds
**both** `list()` and `resolve()`. Removing an id there means:

- `agent_dispatch({provider:'zcode'})` now throws `unknown provider: zcode` instead of the CLI registry's own
  error, changing a message the tests and the model may rely on; and
- **the subagent path for a disabled provider disappears too**, since `resolve()` calls `subagentRoute()` on the
  same id set. A user who disables the *CLI* wrapper for `codex` but relies on the *official* provider would lose
  official dispatch as collateral.

**BAD vs CORRECT**

```js
// BAD: conflates "hidden from the panel" with "not resolvable"
function providerIds() {
  return [...registry ids, ...config ids].filter(id => config.providers[id]?.enabled !== false)
}

// CORRECT: keep resolution intact; filter for display only
function providerIds() { /* unchanged */ }

function list(parent, { onlyEnabled = true } = {}) {
  return providerIds()
    .filter(id => !onlyEnabled || config.providers?.[id]?.enabled !== false)
    .map(...)
}
// and /state calls resolver.list(undefined, { onlyEnabled: true })
// while resolve() keeps seeing every id.
```

### R2.4 — recommended caching design

Given R2.1/R2.2, **do not** call `detectAll()` inline per request. Recommended, in order of preference:

**(a) Cache-on-mount + explicit refresh (recommended).** Probe once when the plugin applies, hold the result in a
closure, and expose a refresh trigger. Rationale: `ctx.jobs`-style services are long-lived; availability changes
only when a human installs a CLI, which is not a per-request event.

```js
let cache = { at: 0, rows: undefined, inflight: undefined }
const TTL = 60_000

async function detected() {
  const now = Date.now()
  if (cache.rows !== undefined && now - cache.at < TTL) return cache.rows
  if (cache.inflight !== undefined) return cache.inflight          // coalesce concurrent callers
  cache.inflight = registry.detectAll()
    .then((rows) => { cache = { at: Date.now(), rows, inflight: undefined }; return rows })
    .catch(() => { cache = { at: Date.now(), rows: [], inflight: undefined }; return cache.rows })
  return cache.inflight
}
```

**(b) Stale-while-revalidate.** Serve the last known rows immediately and refresh in the background, so the
panel never waits on a probe:

```js
function stateRows() {
  if (cache.rows !== undefined && Date.now() - cache.at > TTL) void detected()   // fire and forget
  return cache.rows ?? UNKNOWN_ROWS      // first call answers "checking…", not a 20 s hang
}
```

**(c) Bound the probe.** Whatever cache is chosen, cap it: `Promise.race` against ~2 500 ms and report
`available: undefined` ("not yet known") rather than letting a wedged `grun` hold `/state` for 20 s. A UI that
says "checking" is honest; one that hangs is broken.

**Do not** use a short TTL (≤ 2 s) or per-request detection: at a 2 s poll interval that is a fork storm of four
subprocesses per tick, on a box that also runs the model.

**Test that catches R2.1–R2.4**

```js
test('/state detection is cached and coalesced', async () => {
  let calls = 0
  const registry = { list: () => [{ id: 'a', label: 'A' }], get: () => ({}),
                     detectAll: async () => { calls++; return [{ id: 'a', label: 'A', available: true }] } }
  const resolver = /* build with that registry */
  await Promise.all([resolver.listState(), resolver.listState(), resolver.listState()])
  assert.equal(calls, 1, 'concurrent /state reads must share one probe')
  await resolver.listState()
  assert.equal(calls, 1, 'a second read within the TTL must not re-probe')
})

test('a disabled CLI provider stays resolvable through the official subagent path', async () => {
  // config.providers.codex.enabled = false, subagentProvider = 'codex', provider registered
  const backend = resolver.resolve({ provider: 'codex', parent: liveParent })
  assert.equal(backend.kind, 'subagent', 'disabling the CLI wrapper must not disable official dispatch')
})
```

### R2.5 — edge case the naive version gets wrong: "not installed" vs "installed but not configured"

**Correction to an earlier draft.** I first wrote that `zcode.detect()` returns no `available` field. It does —
checked against the source (`src/provider/zcode.js:36-47`):

```js
async function detect() {
  if (config.enabled === false) return { available: false, detail: 'zcode 未启用…' }
  if (!config.commandTemplate) return { available: false, detail: 'zcode 未配置 commandTemplate…' }
  return { available: true, detail: 'template mode' }
}
```

All three branches set `available`, and `detectAll()` spreads `...d` (`src/provider/types.js:35`), so
`stateOf(id)?.available === true` is a correct predicate for every provider. This is **checked and clean**.

The real edge case is different, and it survives: `zcode` reports `available: true` when a `commandTemplate` is
merely *set* — the code's own comment says "有模板即视为可尝试；真实可用性取决于用户环境". So after Fix 2 the
panel will show zcode green for a template that does not run. That is the same class of lie Fix 2 exists to
remove, in the one provider that cannot probe itself. Fix 2 should either exclude template-mode zcode from the
"available" claim, or present it as a third state (`configured`) rather than `available`. The `detail` carries
enough text ("template mode") to render that honestly.

## FIX 3 — `resumeSessionId` guard before `startActivation` (committed)

**Patch as written** (`src/backend.js:228-232`):

```js
const signal = request.signal ?? new AbortController().signal
if (hasResumeId(request.resumeSessionId)) throw resumeRejection(providerId, providerName)
const route = subagentRoute(ctx, config, providerId, parent)
```

This one is **correct and well-placed**. It runs before `subagentRoute()` (pure registry reads) and before
`startActivation()`, so nothing is spawned. The committed test correctly flips from
`assert.equal(calls.dispose, 1)` to `calls.start.length === 0` / `calls.dispose === 0`.

### R3.1 — the removal of `activation.result.catch(() => {})` re-opens an unhandled-rejection window

The patch deleted the no-op consumer together with the guard it was protecting:

```diff
       let primary
       try {
-        // 先挂上 no-op rejection 消费者：resumeSessionId 分支会丢弃 result…
-        activation.result.catch(() => {})
         const result = await activation.result
```

That `.catch()` was doing **two** jobs. The comment names only the resume one, but the line also guarded a real
race: `startActivation()` resolves when the child is *published*, while `activation.result` may already be
settling. If the caller's `signal` aborts between publication and the `await` on the next line, the rejection can
land before anyone has attached a handler, and Node reports an unhandled rejection. The plugin's own contract in
`dsh-subagent/lib/types/types.d.ts:46-49` says capture failures **reject** `result`, so this path is reachable.

Removing it is *probably* fine in practice because the `await` is on the very next statement, but the audit did not
prove that, and the new test does not cover it — it only covers the pre-start rejection.

**BAD vs CORRECT**

```js
// BAD (as committed): the only handler is attached one microtask later
const activation = await route.service.startActivation({...})
let primary
try {
  const result = await activation.result

// CORRECT: keep one no-op consumer attached before any await can interleave
const activation = await route.service.startActivation({...})
let primary
try {
  void activation.result.catch(() => {})   // contention guard, independent of the resume branch
  const result = await activation.result
```

### R3.2 — the guard's error message still routes the user to a path that may not exist

`resumeRejection()` (`src/backend.js:152-157`) says:

> "…use the CLI provider for external-session resume"

On this machine all four CLI providers are unavailable (`detectAll()` → all `available=false`), and the plugin
never checks availability before making that recommendation. The user is told to use a path that cannot run.
That is not caused by the patch — the patch only made the message *more* promptly reachable, which raises its
prominence.

**Corrected wording**:

> `resumeSessionId is not supported on the official subagent path for provider "…" (the official provider is
> one-shot). Continue the session with the CLI wrapper instead — if its CLI is not installed, run the task in a
> new session, or use agent_import to bring the old transcript into DSH.`

### R3.3 — edge case: `resumeSessionId: 0` and `resumeSessionId: " "`

`hasResumeId` (`src/backend.js:148-150`) is `value !== undefined && value !== null && value !== ''`. So `0`
counts as a resume id and is rejected, and `"   "` (whitespace) also counts. Neither can be a real session id.
The schema declares the parameter as `{type:'string'}`, so `0` is a type violation the raw-schema tool path does
not validate. Minor, but a `' '` resume that reaches the CLI provider passes `--resume ' '` to the binary.

```js
// CORRECT
function hasResumeId(value) {
  return typeof value === 'string' ? value.trim() !== '' : value !== undefined && value !== null
}
```

### R3.4 — the fix's real payoff depends on which path the caller reaches

The guard only fires on the **subagent** path. A caller who supplies `resumeSessionId` *and* has no live parent
Agent — every panel request (`src/http.js:274-276`) and any headless tool call without `exec.agent` — never
reaches `subagentBackend` at all; it goes straight to `cliBackend`. So the saved cost applies to exactly one
scenario: an interactive model session with the official bundle installed, asking to resume. That is the scenario
the audit measured, so the fix is worth keeping — but the commit message's "a rejected resume still paid for a
child process" is accurate only for that scenario, not universally.

**Test that catches R3.1**

```js
test('an activation that rejects before the caller awaits does not become an unhandled rejection', async () => {
  const rejections = []
  process.on('unhandledRejection', (e) => rejections.push(e))
  // fakeSubagents whose startActivation resolves with an already-rejecting result
  const resolver = /* ... */
  await assert.rejects(() => resolver.resolve({ provider: 'codex', parent }).dispatch({ prompt: 'x' }), /boom/)
  await new Promise((r) => setTimeout(r, 20))   // let the microtask queue drain
  process.off('unhandledRejection', () => {})
  assert.deepEqual(rejections, [])
})
```

---

## FIX 4 — reject a pre-aborted signal (committed)

**Patch as written** (`src/tools.js:50-56`):

```js
run(signal, fn) {
  if (signal?.aborted === true) {
    return Promise.reject(new Error('aborted before start (maxConcurrent=' + limit + ')'))
  }
  return new Promise((resolveRun, rejectRun) => { … })
```

Placement is correct: the check is **before** `active += 1` and before the `new Promise`, so no slot is taken and
no handler is needed. This is the right shape. The analysis below is about what a plausible *refactor* of it
would break, plus the question you asked about `exec.signal` scope.

### R4.1 — the answer to "can `exec.signal` carry an unrelated abort?": **yes, by design**

`exec.signal` is **not** per-call. `packages/core/agent-loop/src/tool-calls.ts:65-79` builds every planned call of
a step from one `signal`:

```js
export async function executeToolCalls(ctx, turn, step, toolCalls, signal, acceptContext) {
  …
  // Inputs are distinct because tools/execute wrappers may replace `exec.signal`.
  const planned = toolCalls.map(block => ({
    block,
    exec: { callId: block.id, name: block.name, arguments: parseArguments(block.arguments), agent, signal },
  }))
```

One abort therefore cancels **the whole step**: "stop this turn" (user pressed Esc, goal round ended, turn
deadline hit) aborts the step signal, which every call in the step shares. That is the intended contract, not a
bug — but it means the patch's semantics are "if the *step* is already cancelled, do not start" rather than "if
*this* call is cancelled, do not start". For `agent_dispatch` that is exactly right: a cancelled step must not
spend quota.

The important consequence is the reverse one — **a signal that aborted for an unrelated reason can reject a call
that the registry would otherwise have dispatched**. The registry already has a canonical gate for this,
`callerCancelled(exec)` at `packages/core/tools/src/index.ts:1506`:

```ts
if (this.callerCancelled(exec)) {
  return next({ kind: 'final-result', exec, result: toolAbortedBeforeDispatchResult() })
}
```

with `callerCancelled` reading `state.callerSignal.aborted` (`index.ts:1548-1553`). So for the ordinary
"cancelled before dispatch" case, **the framework already stops the call before `execute()` runs**, and the
plugin's new check is a second, redundant guard for the *same* non-event.

Where the plugin's check is **not** redundant — and where it earns its place — is the window the framework cannot
see: `tools/execute` wrappers may *replace* `exec.signal` with a tighter one after the pre-dispatch check.
`packages/guard/timeout-policy/src/index.ts:62-66` does exactly that:

```ts
using d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)
const upstream = exec.signal
exec.signal = d.signal
```

So the signal the plugin sees can be a **derived deadline** that is already aborted when `execute()` begins, even
though `callerCancelled` said no. The plugin's guard catches that. Net: keep the patch; it is a genuine
belt-and-braces against the deadline wrapper, not a duplicate of `callerCancelled`.

What it must **not** become is `signal.throwIfAborted()` sprinkled inside `begin()` or before every `await` in
`dispatch()` — see R4.2.

### R4.2 — the refactor trap: moving the check into `begin()` leaks the slot permanently

The natural "cleaner" version — replace the boolean with `throwIfAborted()` and put it where the work starts —
wedges the gate forever. Verified (`/tmp/slot-leak2.mjs`):

```
$ node slot-leak2.mjs
rejected: AbortError
active after aborted fast-path = 1  (must be 0)
next call: TIMEOUT | ran = false
PERMANENT SLOT LEAK confirmed
```

because `active += 1` has already run and the `.finally()` that would decrement it is attached only to the
*future* chain that the throw skipped.

**BAD vs CORRECT**

```js
// BAD: throw after taking the slot, before the settle chain exists
if (active < limit) { active += 1; entry.begin(); return }
// ...inside begin():
signal?.throwIfAborted()                 // ← leaks `active` on throw

// CORRECT (what is committed): reject before taking the slot
run(signal, fn) {
  if (signal?.aborted === true) return Promise.reject(new Error('aborted before start (…')) 
  return new Promise(…)
}

// ALSO CORRECT, if the check must live in begin(): decrement before rethrowing
begin() {
  if (started) return
  started = true
  if (signal?.aborted === true) {
    active -= 1                            // release the slot we just took
    if (queue.length > 0) queue.shift().begin()
    rejectRun(new Error('aborted before start (…'))
    return
  }
  …
}
```

### R4.3 — the error shape differs from the framework's canonical abort result

The patch rejects with a plain `Error`. The framework's canonical pre-dispatch abort is
`toolAbortedBeforeDispatchResult()` (`index.ts:1978-1989`):

```ts
{ content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
  isError: true,
  error: { message: 'tool call aborted before dispatch',
           info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH } } }
```

A plain throw reaches the model as a generic tool error with no `AbortError` classification, so an ordinary user
cancellation is reported to the model — and to any `tools/result` observer or transcript analysis — as a failure
rather than a cancellation. It also makes `agent_dispatch` look broken in transcripts where the user simply
pressed Esc.

**Corrected code**:

```js
if (signal?.aborted === true) {
  const error = new Error('tool call aborted before dispatch')
  error.name = 'AbortError'
  error.code = 'TOOL_ABORTED_BEFORE_DISPATCH'
  return Promise.reject(error)
}
```

This is a small change with a disproportionate effect on transcript honesty: it lets the model distinguish "I
cancelled it" from "the tool failed".

### R4.4 — the committed regression test asserts on the wrong surface

`tests/tools.test.js` adds:

```js
await assert.rejects(
  () => dispatch.execute({ provider: 'p1', prompt: 'x' }, { signal: controller.signal, agent: undefined }),
  (error) => { assert.match(String(error.message), /abort/i); return true },
)
```

It calls `execute()` **directly**, bypassing the registry. So it proves the semaphore rejects, but not that a real
tool call through `ToolRuntime` produces a cancellation. And because the test never goes through
`registerTools`' disposal path, it would still pass if the patch broke the gate for subsequent calls (R4.2): a
single aborted call cannot detect a leaked slot.

**Test that catches R4.2 and R4.4**

```js
test('an aborted call does not consume a concurrency slot', async () => {
  const { ctx, registered } = mockCtx()
  const { registry, resolver } = wire([slowProvider()])
  registerTools(ctx, { registry, resolver, config: makeConfig({ maxConcurrent: 1 }) })
  const tool = registered.find(t => t.name === 'agent_dispatch')

  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(() => tool.execute({ provider: 'slow', prompt: 'x' }, { signal: aborted.signal }), /abort/i)

  // The gate must still have its single slot free.
  const value = await Promise.race([
    tool.execute({ provider: 'slow', prompt: 'y' }, { signal: new AbortController().signal }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('gate wedged: slot leaked')), 1000)),
  ])
  assert.match(value.text, /done/)
})
```

### R4.5 — edge case: `signal` may be `undefined` on the fake-context path

Every committed test passes `{ signal }`, but `execute(args, exec)` is called with `{}` by several existing tests
(`'unknown provider rejects…'`, `'background dispatch without an agent…'`). `run()` handles that
(`signal?.aborted`), and `dispatchForeground` passes `signal` straight through to `gate.run(signal, …)`, so
`undefined` never becomes `"undefined"`. Confirmed clean — but the optional-chaining is load-bearing and should
stay even if the JSDoc is tightened to require a signal.

---

## FIX 5 — round-2 prompt must start with `basePrompt` (not yet started)

**Patch as it would plausibly be written** (`src/roundtable.js:5-20`), moving `basePrompt` to offset 0:

```js
function buildDebatePrompt(basePrompt, round, history) {
  if (round <= 1 || !history.length) return String(basePrompt)
  const peer = history.map(h => '【' + h.provider + '】\n' + String(h.text || '').slice(0, 2000)).join('\n\n')
  return [
    String(basePrompt),          // ← moved to the front
    '',
    '【第' + round + '轮辩论】',
    '其他 agent 的上一轮发言：',
    peer,
    '',
    '请针对上述观点进行回应…',
  ].join('\n')
}
```

### R5.1 — the existing test asserts the banner, not its position, so it **passes either way**

`tests/roundtable.test.js:77` is the only assertion touching the banner:

```js
assert.match(pA, /第2轮辩论/)
```

`assert.match` is position-independent, so reordering keeps the suite green. That is good for the patch and bad
as a guarantee: **no test currently pins the header-first layout**, and none would catch a future flip back.
Verified by reading the whole file — the other prompt assertions are `/【b】[\s\S]*观点B/` and
`/【a】[\s\S]*观点A/`, also position-independent.

**Answer to "does any test or downstream consumer assert the header comes first?"** — No test does. No
downstream consumer parses the prompt: the only readers are the external CLIs (`parseClaudeStreamJson`,
`parseCodexOutput`, `parseOpencodeEvents`) which parse *stdout* JSON, never the prompt. `formatRoundtableText`
renders results, not prompts. So the reorder is safe from a contract standpoint, and the test must be
**strengthened** to pin the new invariant:

```js
test('round 2 is a strict prefix extension of round 1', async () => {
  const seen = []
  const spy = (id) => ({ id, label: id, dispatch: async ({ prompt }) => { seen.push({ id, prompt }); return { text: id } } })
  const reg = createRegistry([spy('a')])
  await runRoundtable({ registry: reg, prompt: '问题Q', providerIds: ['a'], rounds: 2 })
  const [first, second] = seen.filter(s => s.id === 'a').map(s => s.prompt)
  assert.ok(second.startsWith(first), 'round 2 must extend round 1 as a strict prefix; got:\n' + second.slice(0, 80))
})
```

### R5.2 — moving the question first makes the peer section read as an afterthought, and `原始问题：` becomes a lie

Once `basePrompt` is at offset 0 there is no "原始" (original) to label — the reader has just read it. Keeping the
label produces prompts of the shape:

```
问题Q

【第2轮辩论】
原始问题：
问题Q                      ← repeated verbatim, immediately after itself
其他 agent 的上一轮发言：
…
```

That is (a) a duplicated question, (b) a label that now points *forward* to text the model already has, and (c) a
second copy that **breaks the very prefix extension the fix is buying** — no, it does not break the prefix (it is
an append), but it does add tokens on every round for zero information. On a 4-member 3-round roundtable that is
`4 × (R−1) = 8` redundant question copies.

**BAD vs CORRECT**

```js
// BAD: moved the question but kept the old scaffolding
[ String(basePrompt), '', '【第' + round + '轮辩论】', '原始问题：', String(basePrompt), … ]

// CORRECT: question first and only once; the banner labels the NEW material
return [
  String(basePrompt),
  '',
  '【第' + round + '轮辩论】上一轮其他 agent 的发言：',
  peer,
  '',
  '请针对上述观点进行回应、修正或补充你的结论（可以坚持原判，但需给出理由）。',
].join('\n')
```

### R5.3 — the cache win depends on a prefix that the peer block immediately destroys

The report's own measured claim is "shared prefix: 49 chars → 100% reusable". That is true for
`basePrompt` only. Round 2 is `basePrompt + '\n\n【第2轮辩论】…' + peer`. Round 3 is
`basePrompt + '\n\n【第3轮辩论】…' + peer'`. Round 2 and round 3 diverge at the banner, so **round 3 reuses round
2's prefix only up to the banner** — i.e. the fix buys `len(basePrompt)` once, not cumulative reuse.

The report's ⚠️ warning is the sharper hazard: adding a cache annotation on this layout, or moving the banner
*before* the question again to "label" it, destroys the prefix and yields the +17.4% regression it measured. The
fix must therefore be pinned by the `startsWith` test above, not by a comment.

### R5.4 — edge case the naive version gets wrong: `history` non-empty but this member is alone

Covered under Fix 7 (R7.4): with a single member, round 2 has `history = [{provider:'solo'}]`, so
`round <= 1 || !history.length` is false and the member debates itself. Moving `basePrompt` to the front makes
that prompt `Q\n\n【第2轮辩论】…\n【solo】\nsolo-ans…`, i.e. it *looks* legitimate. Fix 5 and Fix 7 must land
together, or Fix 5 silently blesses a self-debate.

---

## FIX 6 — roundtable inside `maxConcurrent` (not yet started)

**Patch as it would plausibly be written** (`src/tools.js:412-424`), wrapping the whole fan-out in the gate:

```js
const runOnce = (signal) => gate.run(signal, () => runRoundtable({ … }))
```

### R6.1 — wrapping the *whole* roundtable in the gate deadlocks against Fix 6's own members

`maxConcurrent` defaults to **3** (`src/config.js:26`) and a roundtable's default member list is **every
configured provider** — four of them. If `runOnce` takes one slot and then the four member dispatches also go
through the same gate (which is what "roundtable inside `maxConcurrent`" naturally means if the member calls are
also gated), the gate is asked for 5 slots while holding 1 with no release until all members finish:

```
roundtable holds slot 1
  member a wants slot 2 → granted
  member b wants slot 3 → granted
  member c wants a slot → QUEUED (active=3)
  member d wants a slot → QUEUED
  …a and b finish, c and d proceed → OK, slow but not deadlocked
```

Not a hard deadlock with limit ≥ 2, but with `maxConcurrent: 1` — a legitimate operator setting — it is:
the roundtable holds the only slot and every member waits for a slot that the roundtable itself will never
release.

**BAD vs CORRECT**

```js
// BAD: one outer slot + N inner slots from the same gate
const runOnce = (s) => gate.run(s, () => runRoundtable({ registry, … }))   // members also gate → deadlock at maxConcurrent:1

// CORRECT (a): gate only the MEMBERS, not the roundtable
//   pass a per-dispatch wrapper into runRoundtable and call gate.run() around
//   each provider.dispatch. The roundtable itself never holds a slot.
const gatedRegistry = {
  list: () => resolver.list(parent).map(i => ({ id: i.id, label: i.label })),
  get(id) {
    const backend = resolver.resolve({ provider: id, parent })
    return { ...backend, dispatch: (req) => gate.run(req.signal, () => backend.dispatch(req)) }
  },
}

// CORRECT (b): if you must gate the whole roundtable, give it a separate
//   semaphore, or clamp member count to maxConcurrent and document it.
```

**Recommendation: (a).** It preserves the invariant "at most `maxConcurrent` external processes at once" —
which is what the setting means and what protects against 429 — without the nested-acquisition deadlock, and it
composes with the panel path (`src/http.js`) which has no gate at all today.

### R6.2 — a gated member now inherits the gate's error message, which the roundtable treats as a member failure

`runRoundtable`'s per-member `try/catch` (`src/roundtable.js:31-43`) converts **any** throw into
`{ ok: false, error }`. A gate rejection therefore becomes "member c failed: aborted before start
(maxConcurrent=3)" in the synthesized text, and — importantly — that member is then **dropped from
`history`**, so it does not participate in later rounds. With `maxConcurrent: 1` and 4 members, three members
report a spurious failure on round 1 and the roundtable silently becomes a monologue.

`agent_dispatch` has the same gate but a user sees one call fail. In a roundtable the failure is *attributed to
the agent*, which is the wrong story: the process was never started.

**Corrected code** — distinguish "did not run" from "ran and failed":

```js
// in runRoundtable's per-member catch
} catch (err) {
  const queued = err?.name === 'AbortError' || /aborted before start/.test(String(err?.message))
  return { provider: id, ok: false, skipped: queued, error: String(err?.message || err), durationMs: Date.now() - t0 }
}
```

and in `formatRoundtableText` render `skipped` members as `[c] 未执行（并发已满）` rather than `失败`.

### R6.3 — `active` is already drifted before Fix 6 lands (found while reviewing Fix 6)

Independently of any new patch, the committed `createSemaphore` leaks slots. Verified against the exact committed
source (`/tmp/gate-probe.mjs`):

```
$ node gate-probe.mjs
after 1 queued job completes -> active = -1
maxConcurrent=1 but peak concurrency = 2 | final active = -5
DEFECT: gate no longer bounds concurrency
```

Root cause: in `entry.begin()` the `.finally()` decrements `active`, and for a **queued** entry `active` was never
incremented when it was later promoted by `queue.shift().begin()`. So every promotion makes `active` drift
negative. Current consequence: `maxConcurrent` is not actually enforced after the first queued work item — the
existing `maxConcurrent bounds in-flight dispatches` test passes only because it never queues. Once Fix 6 routes
four roundtable members through this gate, the drift is no longer cosmetic, and once Fix 1's inline fallback keeps
calls alive longer, queueing becomes common.

**This is the single most important thing to fix alongside Fix 6.** The gate must count the slot for a promoted
entry, or decrement only what it incremented:

```js
// BAD (current): one decrement, two acquisition paths
begin() { …; pending.finally(() => { active -= 1; if (queue.length) queue.shift().begin() }) }
if (active < limit) { active += 1; entry.begin() }        // increments
queue.push(entry)                                          // never increments; promoted by shift().begin()

// CORRECT: increment on promotion too
function promote(entry) { active += 1; entry.begin() }
if (active < limit) promote(entry)
else queue.push(entry)
// and in the settle handler:
pending.finally(() => { active -= 1; if (queue.length > 0) promote(queue.shift()) })
```

**Test that catches R6.1–R6.3**

```js
test('maxConcurrent still bounds concurrency after a queued item is promoted', async () => {
  let inFlight = 0, peak = 0
  const work = async () => { inFlight++; peak = Math.max(peak, inFlight); await sleep(20); inFlight-- }
  const gate = createSemaphore(1)
  await Promise.all([gate.run(undefined, work), gate.run(undefined, work)])   // forces one promotion
  peak = 0
  await Promise.all(Array.from({ length: 4 }, () => gate.run(undefined, work)))
  assert.equal(peak, 1, 'a promoted queued item must not leave the gate over-admitting')
})

test('a roundtable does not deadlock at maxConcurrent: 1', async () => {
  const { ctx, registered } = mockCtx()
  const { registry, resolver } = wire([p('a'), p('b'), p('c')])
  registerTools(ctx, { registry, resolver, config: makeConfig({ maxConcurrent: 1 }) })
  const tool = registered.find(t => t.name === 'agent_roundtable')
  const value = await Promise.race([
    tool.execute({ prompt: 'q', background: false }, { signal: new AbortController().signal }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('roundtable deadlocked at maxConcurrent=1')), 2000)),
  ])
  assert.match(value.text, /\[a\]/)
})
```

### R6.4 — edge case: the panel path has no gate and no owner

`src/http.js`'s `/roundtable` dispatches outside the semaphore entirely, and its members are unowned. Fix 6 as
described only touches `src/tools.js`. A panel roundtable plus a tool roundtable still doubles the configured
limit — the writer must decide whether `/roundtable` shares the gate (it cannot: the gate lives in the
`registerTools` closure, and `registerHttp` receives a different options object). Sharing it requires hoisting the
semaphore into `apply()` and passing it to both.

---

## FIX 7 — exclude a member's own previous answer (not yet started)

**Patch as it would plausibly be written** — thread `selfId` into the prompt builder and filter the peer list:

```js
const out = await provider.dispatch({
  prompt: buildDebatePrompt(prompt, rn, history, id),      // ← id now passed
  cwd, model, timeoutMs, signal,
})

function buildDebatePrompt(basePrompt, round, history, selfId) {
  if (round <= 1 || !history.length) return String(basePrompt)
  const peer = history
    .filter(h => h.provider !== selfId)                    // the fix
    .map(h => '【' + h.provider + '】\n' + String(h.text || '').slice(0, 2000))
    .join('\n\n')
  …
}
```

### R7.1 — answer to "does `history` currently include self?" — **yes, always**

`src/roundtable.js:48-53` writes every successful member, including the one that just answered, into the shared
`history` array, then participant selection for the next round reads `history.map(h => h.provider)`. Verified with
the real module (`/tmp/rt-probe.mjs`):

```
=== two members, round 3 prompt seen by a ===
"【第3轮辩论】\n原始问题：\nQ\n\n其他 agent 的上一轮发言：\n【a】\na-ans\n\n【b】\nb-ans\n\n请针对上述观点…"
a sees own 【a】 block? true
```

So member `a` is told "其他 agent 的上一轮发言" and then handed its own `a-ans` under a label implying another
agent said it. That is the false statement the report flags, and it is confirmed.

### R7.2 — answer to "does removing it change round-3 semantics?" — **`history` must not be touched**

Only the **prompt** may lose the self-entry. `history` has three other consumers in the same loop:

```js
const activeIds = rn === 1 ? ids : history.map(h => h.provider)        // :24  participation
…
const prev = history.findIndex(h => h.provider === e.provider)          // :49  bookkeeping
if (prev >= 0) history[prev] = item; else history.push(item)
```

Filtering `history` itself — the obvious "just remove self" edit — shrinks participation. This is not
hypothetical: the probe in `/tmp/rt-trap2.mjs` shows the shape. Written naively as
`history = history.filter(h => h.provider !== id)` inside the per-member task, members silently drop out of round
3 and later. The correct edit is a **local copy inside the prompt builder**, never a mutation of the shared array.

**BAD vs CORRECT**

```js
// BAD: mutates shared state used for participation and index bookkeeping
async (id) => {
  history = history.filter(h => h.provider !== id)             // ← shared array mutated
  const out = await provider.dispatch({ prompt: buildDebatePrompt(prompt, rn, history) })
}

// CORRECT: filter only the rendered peer block; history stays authoritative
function buildDebatePrompt(basePrompt, round, history, selfId) {
  if (round <= 1) return String(basePrompt)
  const peers = history.filter(h => h.provider !== selfId)      // local
  if (peers.length === 0) return String(basePrompt)             // nothing to debate
  …
}
// and the call site gains exactly one argument:
prompt: buildDebatePrompt(prompt, rn, history, id),
```

### R7.3 — the guard must move from `history` to `peers`, or a solo member debates itself

The existing early return keys on `history.length`, which stays non-zero for a single member. Verified
(`/tmp/rt-probe.mjs`, single member, 3 rounds):

```
"【第2轮辩论】\n原始问题：\nQ\n\n其他 agent 的上一轮发言：\n【solo】\nsolo-ans\n\n请针对上述观点…"
participant count per round: [ 1, 1, 1 ]
```

After the naive fix, `peer` becomes `''` and the prompt degenerates to a request to debate an empty list
(`/tmp/rt-edge.mjs`):

```
"【第2轮辩论】\n原始问题：\nQ\n\n其他 agent 的上一轮发言：\n\n\n请回应"
```

The member is told to respond to other agents' statements when there are none. With `rounds: 3` and one provider
that is three paid calls producing self-referential nonsense.

**BAD vs CORRECT**

```js
// BAD: guard on history, then filter
if (round <= 1 || !history.length) return String(basePrompt)
const peer = history.filter(h => h.provider !== selfId).map(…).join('\n\n')   // may be ''

// CORRECT: guard on the filtered list
if (round <= 1) return String(basePrompt)
const peers = history.filter(h => h.provider !== selfId)
if (peers.length === 0) return String(basePrompt)        // solo: identical to round 1 → cache-friendly too
const peer = peers.map(…).join('\n\n')
```

Note the bonus: with `peers.length === 0` returning the plain prompt, a solo roundtable's later rounds become
**byte-identical to round 1**, which is the maximal-prefix case Fix 5 is chasing.

### R7.4 — edge case: a member that failed mid-run keeps a stale entry in `history`

`history` is only updated on success (`:48-49`), so a member that answered round 1 and failed round 2 still has its
**round-1** text in `history` during round 3, and the peer block presents it as "上一轮发言" (last round's
statement) when it is two rounds old. Self-exclusion does not cause this, but it becomes visible once the peer
block is shortened and relabelled by Fix 5: the fix makes it more obviously a *previous round* claim.

Cheap correctness upgrade while in the file: keep the round number with each history entry and label the peer
block `上一轮` only when `h.round === round - 1`, otherwise `第N轮`.

### R7.5 — the test that pins it

```js
test('a member never sees its own previous answer in the peer block', async () => {
  const seen = []
  const spy = (id) => ({ id, label: id, dispatch: async ({ prompt }) => { seen.push({ id, prompt }); return { text: id + '-ans' } } })
  const reg = createRegistry([spy('a'), spy('b')])
  await runRoundtable({ registry: reg, prompt: 'Q', providerIds: ['a', 'b'], rounds: 3 })

  const aR2 = seen.filter(s => s.id === 'a')[1].prompt
  assert.doesNotMatch(aR2, /【a】/, 'a must not be handed its own round-1 answer')
  assert.match(aR2, /【b】[\s\S]*b-ans/, 'a must still see b')

  // participation must not shrink
  const rounds = /* r.debate */ null
  assert.equal(seen.filter(s => s.id === 'b').length, 3, 'b must still be asked in round 3')
})

test('a solo roundtable does not debate an empty peer list', async () => {
  const seen = []
  const solo = { id: 'solo', label: 'solo', dispatch: async ({ prompt }) => { seen.push(prompt); return { text: 'x' } } }
  await runRoundtable({ registry: createRegistry([solo]), prompt: 'Q', providerIds: ['solo'], rounds: 2 })
  assert.equal(seen[1], 'Q', 'with no peers, round 2 must be the plain prompt')
  assert.doesNotMatch(seen[1], /其他 agent 的上一轮发言/)
})

---

## Cross-fix interactions (the part a per-fix review misses)

### X1 — Fix 5 + Fix 7 must land together, or Fix 5 blesses a self-debate

Fix 5 moves `basePrompt` to the front, making every later-round prompt *look* well-formed. Fix 7 is what stops a
solo member from debating itself. Landing 5 alone makes the defect harder to spot; landing 7 alone leaves the
prefix optimization on the table. They are one change with two effects, and the `startsWith` test (R5.1) plus the
`seen[1] === 'Q'` test (R7.5) together pin both.

### X2 — Fix 1's inline fallback changes the blast radius of the Fix 6 gate defect

Before Fix 1, a missing controller made background dispatch **fail fast**. After Fix 1, it runs **inline and
synchronously**. Combined with the un-fixed `active` drift (R6.3), a user who fires three roundtables now holds
the tool call open for the full duration of each instead of getting an immediate error, while the gate
over-admits. Fix 1 is still right — an error is worse than an answer — but it converts a loud failure into a
latency problem, which raises the priority of R6.3 from "cosmetic" to "user-visible".

### X3 — Fix 2's `enabled` filtering and Fix 3's resume message

Filtering `enabled: false` out of `providerIds()` (R2.3) would also remove those providers from `agent_sessions`,
`agent_import_scan`, and the resume-message's advice surface. A user told "use the CLI provider for
external-session resume" would find that provider absent from the very list they were pointed at.

### X4 — the in-flight `persist.js` ledger lock has a broken cleanup comparison (found during this review)

Not one of the 7, but it is uncommitted in the same working tree and it is wrong right now. In
`src/importer/persist.js`:

```js
ledgerWrites.set(path, next.catch(() => {}))
try { return await next }
finally {
  if (ledgerWrites.get(path) === next.catch(() => {})) ledgerWrites.delete(path)
}
```

`Promise.prototype.catch()` returns a **new** promise on every call, so the comparison is always `false` and the
entry is **never** deleted. Verified:

```
$ node -e "const p=Promise.resolve(1); console.log(p.catch(()=>{}) === p.catch(()=>{}))"
false
```

Consequence: one permanent entry per ledger path in a module-level `Map`. Bounded by the number of DSH homes
(usually one), so it is a leak of one promise, not unbounded — but the `finally` block is dead code that reads as
if it cleans up, and the map then holds a settled promise for the process lifetime, keeping the last ledger
snapshot reachable.

```js
// BAD (in flight): fresh promise each call → never equal
if (ledgerWrites.get(path) === next.catch(() => {})) ledgerWrites.delete(path)

// CORRECT: retain the exact guarded promise
const guarded = next.catch(() => {})
ledgerWrites.set(path, guarded)
try { return await next }
finally { if (ledgerWrites.get(path) === guarded) ledgerWrites.delete(path) }
```

Also worth noting: `importOne` still does its **pre-check** against an unlocked `loadLedger(home)` at `:206`, and
the new locked write returns `undefined` when an entry already exists — but the function then returns
`{ status: 'imported', dshSessionId }` for the **newly created** session even though the ledger kept the *older*
one. Two concurrent imports of the same external session therefore both write a v4 session, and the second one is
orphaned: it exists on disk but the ledger points at the first, so `agent_import_scan` reports it as not imported
and a third attempt would import a third copy. The lock prevents ledger *loss* but not duplicate *sessions*.

**Test that catches X4**

```js
test('concurrent imports of one external session create exactly one DSH session', async () => {
  let created = 0
  const ctx = { get: () => ({ create: async () => { created++; return { append: async () => {}, flush: async () => {}, close: async () => {} } } }) }
  const results = await Promise.all([importOne(ctx, opts), importOne(ctx, opts), importOne(ctx, opts)])
  assert.equal(created, 1, 'only one DSH session may be created for one external id')
  assert.equal(new Set(results.map(r => r.dshSessionId)).size, 1)
})
```

---

## Answers to the specific questions

**1. `ctx.jobs.attachController` — unload/HMR, double attach, owner scope**

* Does the disposer run on plugin unload? **No, not from the plugin's fiber.** Verified
  (`/tmp/attach-probe.mjs`): `attachController` is `this.layers.effect(this.ctx, …)`
  (`dsh-jobs-local/lib/index.js:528-531`), and `this.ctx` is the **jobs service's own** context
  (`vendor/cordis/src/service.ts:42-57`, `self.ctx = ctx`). Its token is a `yield`-ed effect of the *jobs*
  fiber, not of the caller's. A plugin fiber disposal leaves the token in `layer.controllers`
  (`dsh-scope/lib/index.js:99-115` — `AnonymousEntries.append` + idempotent undo) until the jobs service
  itself unloads or the returned disposer is called by hand. So HMR of `dsh-agent-alliance` **leaks one
  controller token per reload**.
* Can attaching twice throw? **No.** `AnonymousEntries` keys each entry by a fresh `Symbol()`
  (`dsh-scope/lib/index.js:91-113`) and the README states registrations are "anonymous tokens so duplicate
  labels stay independently disposable". A second `attachController('agent-alliance')` is an independent token;
  the reload leak above is a silent duplication, not an error.
* Does the token's scope cover the owners used? It covers **everything**, which is broader than needed:
  `attachController` from the host-level jobs context has `scopeOf(ctx) === undefined`, so it lands in
  `layers.global.controllers`, and `servesOwner` short-circuits on
  "`if (!this.layers.global.controllers.isEmpty()) return true`" (`dsh-jobs-local/lib/index.js:553-556`) for
  **all** owners, owned and unowned alike. Both the tool path (`owner: exec.agent?.sessionId`) and the panel
  path (no owner) are therefore served — so the mechanism works, at the cost of allowing this plugin to satisfy
  the controller requirement for *every* job owner in the host, including other plugins' jobs. It also means the
  plugin would mask a genuinely missing `tool-jobs` for unrelated code.

**Recommendation:** do not call `attachController` in `apply()` unless the disposer is captured and returned from
a `ctx.effect`, i.e. `ctx.effect(() => jobs.attachController('agent-alliance'))`. That makes the token an effect
of *your* fiber and HMR-safe. Alternatively — and this is my preference — **do not attach at all**: Fix 1's
catch-and-inline already restores the function, and attaching makes the plugin silently stand in for a
misconfigured host. If it is added, log once at apply time that the plugin is providing its own controller.

**2. `detectAll()` cost and caching** — measured 132 ms cold / 87 ms warm when all four probes fail fast, but the
worst case is the sum of the per-provider timeouts (15 s + 20 s + 15 s, serial). See **R2.1–R2.4** for the
recommended design: a 60 s TTL cache with in-flight coalescing and stale-while-revalidate, never inline per
request, plus a ~2.5 s bound so a wedged probe reports "unknown" rather than hanging `/state`. Do not use a
short TTL: at the panel's poll rate that is a four-subprocess fork storm per tick.

**3. `signal.throwIfAborted()` in the semaphore fast path** — **the committed boolean check is correct;
`throwIfAborted()` inside `begin()` is a permanent slot leak** (verified: `active` stays at 1, every later call
times out). On the "unrelated abort" question: `exec.signal` **is** step-shared
(`packages/core/agent-loop/src/tool-calls.ts:65-79` — one `signal` for every planned call in the step), so a
turn-level cancel rejects calls that were never individually cancelled. That is the intended contract, and the
framework already has a canonical gate for it (`callerCancelled`, `tools/src/index.ts:1506`). The plugin's check
earns its keep only for the `tools/execute` deadline wrapper that swaps in a derived signal
(`timeout-policy/src/index.ts:62-66`). Keep the check; do not convert it to `throwIfAborted()`; give it
`name: 'AbortError'` and the framework's `TOOL_ABORTED_BEFORE_DISPATCH` code (R4.3).

**4. Round-2 prompt reordering** — **no test and no downstream consumer asserts that `【第N轮辩论】` comes first.**
The only assertion is `assert.match(pA, /第2轮辩论/)` (`tests/roundtable.test.js:77`), which is position-independent
and passes either way; all prompt readers are external CLIs parsing *stdout*, never the prompt. So the reorder is
safe — but the suite must be *strengthened* with a `second.startsWith(first)` assertion (R5.1), otherwise nothing
pins the invariant the fix exists for. The `原始问题：` label **does** become redundant and actively harmful after
the move: it labels text the model has already read, and it duplicates the question on every later round
(R5.2). Replace it with a banner that labels the *new* material.

**5. Removing a member's own answer** — `history` **does** currently include self, always (verified: member `a`
receives `【a】a-ans` in its round-3 peer block). Removing it from `history` itself **does** change round-3
semantics, because `history` drives `activeIds` for the next round and the `findIndex` bookkeeping
(`src/roundtable.js:24, 49-53`): filtering it can drop members from later rounds. Filter only inside the prompt
builder, guard on the filtered list (not `history.length`), and keep `history` untouched (R7.2–R7.3).

---

## Severity roll-up

| # | Finding | Severity | Status |
|---|---|---|---|
| R6.3 | committed semaphore leaks slots → `maxConcurrent` stops bounding after the first promotion | **critical** | present in committed code |
| X4 | in-flight ledger lock never clears its map entry; duplicate sessions on concurrent import | **high** | uncommitted, in tree |
| R1.1 | `http.js:500` uses `ctx?.get('logger')` with no property fallback → that one warning is dead (`tools.js` is fine) | **low** | committed |
| R1.2 | catch swallows *all* `jobs.start()` failures, incl. per-owner capacity (default 10) → silent inline hang | **medium** | committed |
| R7.3 | naive Fix 7 makes a solo member debate an empty peer list | **high** | not yet written |
| R6.1 | gating the whole roundtable deadlocks at `maxConcurrent: 1` | **high** | not yet written |
| R2.3 | filtering `enabled:false` from `providerIds()` kills official dispatch for a disabled CLI wrapper | **medium** | not yet written |
| R4.2 | moving the abort check into `begin()` leaks the slot permanently (proved) | **medium** | trap, not present |
| R4.3 | plain `Error` instead of `AbortError` mislabels cancellation as failure in the transcript | **medium** | committed |
| R5.2 | `原始问题：` becomes redundant and duplicates the question each round | **medium** | not yet written |
| R6.2 | gate rejection is attributed to the *member* as a failure and drops it from later rounds | **medium** | not yet written |
| R1.3 | `http.js` inline fallback reuses a dead, uncancellable controller | **medium** | committed |
| R3.1 | removal of `activation.result.catch()` re-opens an unhandled-rejection window | **low** | committed |
| R2.5 | template-mode `zcode` reports `available: true` without ever running → one residual false green after Fix 2 | **low** | not yet written |
| R3.3 | `hasResumeId` treats `0` and `"   "` as session ids | **low** | committed |
| R5.4 / X1 | Fix 5 alone makes the self-debate look legitimate | **low** | ordering |
| R7.4 | stale history entry is presented as "上一轮" when it is older | **low** | not yet written |
| R4.5 | `signal` may be `undefined` on the fake-context path (handled, but load-bearing) | **checked, clean** | — |
| R1.4 | `jobs.start()` returning a non-string is treated as started | **low** | committed |

## Checked and clean

- **Fix 3 placement** — the guard genuinely runs before `subagentRoute()` and `startActivation()`; nothing is
  spawned, and the flipped test asserts exactly that.
- **Fix 4 placement** — the boolean check sits before `active += 1` and before the `new Promise`; no slot, no
  handler needed.
- **`exec.signal` may be `undefined`** — every path uses `signal?.aborted` or `signal &&`, and existing tests
  already call `execute(args, {})`. No `"undefined"` string can reach `throwIfAborted`.
- **`AnonymousEntries` double-attach** — anonymous Symbol keys mean duplicates are independent, not an error.
- **`history` bookkeeping on success-only** — failed members are correctly excluded from later rounds
  (`tests/roundtable.test.js:80-95` pins it); the new self-exclusion must not disturb it.
- **`rounds` clamp** — `Math.max(1, Math.min(3, …))` unchanged and still pinned by two tests.
- **Existing `maxConcurrent` test** — passes today only because it never queues; it is not evidence the gate
  works (R6.3).
- **`formatRoundtableText` prompt-independence** — it renders `result.prompt` from the argument, not from the
  built prompt, so Fix 5/7 cannot corrupt the summary line.
- **`zcode` `commandTemplate` guard** — refuses to dispatch unconfigured rather than running an empty shell
  string; unaffected by any of the seven.

---

## POST-REVIEW: what the Lead actually landed, re-verified

The Lead implemented Fixes 5, 6, and 7 while this audit was being written. Every trap above was checked against
the landed code, and the results changed the priority order. Suite at this point: **196 pass / 0 fail**.

### Fixes 5 and 7 — landed correctly, all three traps avoided

`src/roundtable.js:17-33` now reads:

```js
function buildDebatePrompt(basePrompt, round, history, selfId) {
  const question = String(basePrompt)
  if (round <= 1 || !history.length) return question
  const peers = selfId === undefined ? history : history.filter((entry) => entry.provider !== selfId)
  if (peers.length === 0) return question
  …
  return [question, '', '---', '', '【第' + round + '轮辩论】', '其他 agent 的上一轮发言：', peer, '', '请针对…'].join('\n')
}
```

Against my own adversarial probes (`/tmp/verify-landed.mjs`):

```
A. round2 startsWith round1 ?            true      ← R5.1 prefix invariant holds
A. round2 when solo === plain prompt ?   true      ← R7.3 empty-peer trap avoided
B. a sees own 【a】 in round 2 ?          false     ← Fix 7 works
B. a still sees 【b】 ?                   true      ← peers preserved
B. participation per round :  [['a','b'], ['a','b'], ['a','b']]   ← R7.2 no participation loss
B. b asked in round 3 ?                  true
C. 原始问题 label gone ?                  true      ← R5.2 addressed
C. question appears exactly once ?       true      ← no duplicate question
```

`history` is untouched (`src/roundtable.js:65-71` still writes it exactly as before), so R7.2's trap — filtering
the shared array and losing members from round 3 — does not exist in the landed code. The `'---'` separator is a
new element I had not proposed; it is harmless (still an append, so the prefix holds) and makes the concatenation
visually unambiguous for the child agent.

**R5.1 still stands as an action item**: `tests/roundtable.test.js:77` remains `assert.match(pA, /第2轮辩论/)`,
which is position-independent. The property that now holds is not pinned by any test. The `startsWith` test from
R5.1 should be added before this lands.

### Fix 6 — landed with the recommended per-member gating, and it activates the drift bug

`src/tools.js:438-446`:

```js
const gatedRegistry = {
  list: () => roundtableRegistry.list(),
  get(id) {
    const backend = roundtableRegistry.get(id)
    return { ...backend, dispatch: (request) => gate.run(request.signal, () => backend.dispatch(request)) }
  },
}
```

This is exactly recommendation **(a)** from R6.1: the roundtable itself holds no slot; each member acquires one.
The `maxConcurrent: 1` deadlock I predicted **does not occur**, and the member-failure attribution problem (R6.2)
is mitigated because the gate rejection happens inside `runRoundtable`'s per-member `try/catch`, which still
reports it as a member failure — that part of R6.2 stands as a wording issue only.

**But Fix 6 makes R6.3 (the semaphore drift) a live, user-visible defect.** Measured against the real committed
`createSemaphore` body with the real roundtable access pattern (`/tmp/real-gate2.mjs`, 4 members, `maxConcurrent: 2`):

```
roundtable #1 (4 members, limit 2): peak = 2 ok
roundtable #2 (4 members, limit 2): peak = 4 OVER LIMIT
roundtable #3 (4 members, limit 2): peak = 4 OVER LIMIT
```

The **first** roundtable is bounded; the second runs at double the configured limit. This is not a rare race — it
is the ordinary case of running two roundtables in one session, which the tool encourages (background by default,
returning a job id). Root cause is unchanged and is one line: a queued entry is promoted by
`queue.shift().begin()` without `active += 1`, while every `begin()` decrements `active` in its `.finally()`.

Severity: **critical**, and now blocking for Fix 6. Landing Fix 6 without R6.3 means shipping a fix that silently
stops working the second time it is used.

### Fix 4 — the comment now claims more than the code does

The landed comment (`src/tools.js:49-56`) says:

```
// The tool pipeline happens to refuse an aborted call before the body runs
// (`dsh-tools` resolves ABORTED_BEFORE_DISPATCH first), so this guard is
// redundant on the model-tool path — but the panel's HTTP handlers call
// dispatch without any pipeline in front of them, and a signal can also be
// aborted between admission and the gate.
```

This is accurate and better reasoned than my R4.1 — it correctly identifies the framework gate
(`callerCancelled`, `tools/src/index.ts:1506`) and the panel path as the real justification. Two corrections:

1. It omits the *deadline wrapper* case, which is the one path where the guard is not redundant **on the model-tool
   path** (`packages/guard/timeout-policy/src/index.ts:62-66` replaces `exec.signal` with a derived deadline after
   `callerCancelled` already passed). Worth one clause, because it is the only reason the guard protects model
   calls at all.
2. R4.3 still stands: the rejection is a plain `Error`, not the framework's `AbortError` /
   `TOOL_ABORTED_BEFORE_DISPATCH` shape, so a user cancellation is recorded as a failure.

### Fix 2 — still not started

`src/backend.js` still returns `available: true` unconditionally for every registered provider, and the panel still
shows four green rows on a machine where `detectAll()` reports all four unavailable. R2.1–R2.5 and the caching
design all still apply unchanged.

---

## R6.3 — STILL OPEN at `1b15214`, and it is now the blocking defect

Re-verified after the Lead's `f6eaf59` ("repair four defects the adversarial audit found") and `1b15214`.
That commit fixed four findings — from **A2**, not from this report:

- the blanket `jobs.start()` catch (my R1.2 — fixed, and better than my sketch: it matches the controller
  refusal instead of string-matching a capacity message),
- the dead logger read (my R1.1 — fixed for both sites, `warn()` helper reading the `ctx.logger` accessor),
- the resume-guard ordering vs the stale-route check (an ordering case I had marked clean — A2 was right, the
  guard must sit *below* the route check so a removed provider is not misreported as a resume error),
- the availability probe failing open.

**R6.3 was not among them and is unfixed.** The code at `src/tools.js:56-99` is byte-identical in the relevant
part: `active += 1` happens only on the fast path, while `begin()`'s `.finally()` decrements `active` for every
entry including promoted ones, and promotion is `queue.shift().begin()` with no increment.

Reproduced against the **current HEAD** file body (`/tmp/real-gate2.mjs`, real `createSemaphore` extracted from
`src/tools.js`, real roundtable access pattern — 4 members, `maxConcurrent: 2`):

```
roundtable #1 (4 members, limit 2): peak = 2 ok
roundtable #2 (4 members, limit 2): peak = 4 OVER LIMIT
roundtable #3 (4 members, limit 2): peak = 4 OVER LIMIT
```

and the minimal form (`/tmp/real-gate.mjs`):

```
maxConcurrent=1 -> observed peak concurrency = 2
CONFIRMED: committed gate does not bound concurrency after a promotion
```

**Why no test catches it.** `tests/tools.test.js:419-442` dispatches exactly one batch of three with limit 2 and
asserts `peak <= 2`. The first batch *is* bounded, because drift only becomes visible once a promoted entry's
decrement lands. A single-batch test cannot observe it. The `agent_roundtable` tests inherit the same blind spot.
This is why 196 tests pass over a gate that stops working on the second use.

### Second, independent leak in the same function

Aborting a **queued** entry also strands accounting, and my first proposed one-line fix did not address it.
Verified (`/tmp/fix-edge.mjs`): after a queued entry is aborted while another holds the only slot, `active` stays
at `1` with an empty queue once the holder finishes. Not fatal for the gate (a later `finally` resumes
promotion), but it makes `active` meaningless as a bound and interacts with R6.3's drift.

### The fix, verified

Two changes inside `createSemaphore`:

```js
run(signal, fn) {
  if (signal?.aborted === true) return Promise.reject(new Error('aborted before start (maxConcurrent=' + limit + ')'))
  return new Promise((resolveRun, rejectRun) => {
    let started = false
    const entry = {
      queued: false,                                  // (2) track promotion eligibility
      begin() {
        if (started) return
        started = true
        if (signal && onAbort) signal.removeEventListener('abort', onAbort)
        entry.queued = false
        let pending
        try { pending = Promise.resolve(fn()) } catch (error) { pending = Promise.reject(error) }
        pending.then(resolveRun, rejectRun).finally(() => { active -= 1; promote() })
      },
    }
    function onAbort() {
      const wasQueued = entry.queued
      const index = queue.indexOf(entry)
      if (index >= 0) queue.splice(index, 1)
      entry.queued = false
      if (signal) signal.removeEventListener('abort', onAbort)
      if (wasQueued) promote()                        // (2) an aborted queued entry vacates its place
      rejectRun(new Error('aborted while queued (maxConcurrent=' + limit + ')'))
    }
    entry.onAbort = onAbort
    if (active < limit) { active += 1; entry.begin(); return }
    entry.queued = true
    queue.push(entry)
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }) }
  })
}

// (1) every promotion takes a slot, so every decrement has a matching increment
function promote() {
  const next = queue.shift()
  if (next === undefined) return
  active += 1
  next.begin()
}
```

Verified with the corrected implementation (`/tmp/final-gate.mjs`), six batches each:

```
limit=1: peak across 6 batches = 1 OK; active=0 queue=0
limit=2: peak across 6 batches = 2 OK; active=0 queue=0
limit=3: peak across 6 batches = 3 OK; active=0 queue=0
mixed abort run: active = 0 queue = 0 | results: 0,1,A,3,4,5,6,7,8,9
CLEAN after mixed aborts
```

The `finite gate` invariant now holds across batches, limits, and interleaved aborts.

### The test that pins it (must be added with the fix)

```js
test('maxConcurrent still bounds after a queued call is promoted', async () => {
  let inFlight = 0, peak = 0
  const slow = { id: 's', label: 's', dispatch: async () => {
    inFlight++; peak = Math.max(peak, inFlight)
    await new Promise(r => setTimeout(r, 20)); inFlight--
    return { text: 'x' }
  } }
  const { ctx, registered } = mockCtx()
  const { registry, resolver } = wire([slow])
  registerTools(ctx, { registry, resolver, config: makeConfig({ maxConcurrent: 1 }) })
  const tool = registered.find(t => t.name === 'agent_dispatch')
  const go = () => tool.execute({ provider: 's', prompt: 'p' }, { signal: new AbortController().signal })

  await Promise.all([go(), go(), go()])     // forces promotions
  peak = 0
  await Promise.all([go(), go(), go()])     // the batch the current code over-admits
  assert.equal(peak, 1, 'a promoted call must not leave the gate over-admitting')
})

test('aborting a queued call releases its place', async () => {
  let release
  const blocker = { id: 'b', label: 'b', dispatch: () => new Promise(r => { release = () => r({ text: 'done' }) }) }
  const { ctx, registered } = mockCtx()
  const { registry, resolver } = wire([blocker])
  registerTools(ctx, { registry, resolver, config: makeConfig({ maxConcurrent: 1 }) })
  const tool = registered.find(t => t.name === 'agent_dispatch')
  const running = tool.execute({ provider: 'b', prompt: 'hold' }, { signal: new AbortController().signal })
  await Promise.resolve()
  const c = new AbortController()
  const queued = tool.execute({ provider: 'b', prompt: 'drop' }, { signal: c.signal })
  c.abort()
  await assert.rejects(() => queued, /aborted while queued/)
  release()
  await running
  // The gate must still accept a new call promptly (no stranded slot).
  const next = await Promise.race([
    tool.execute({ provider: 'b', prompt: 'after' }, { signal: new AbortController().signal }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('slot stranded')), 500)),
  ])
  assert.ok(next !== undefined)
})
```

## Corrections to this report

Three of my own claims did not survive verification, and are corrected in place above:

| Claim | Correction |
|---|---|
| R1.1 "`serviceOf(ctx,'logger')` is dead in `tools.js`" | **False.** `serviceOf` falls back to a property read; only `http.js`'s bare `ctx.get` was dead. Severity high → low. |
| R1.2 "per-owner limit defaults small" | **Wrong number.** `DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER = 10` (`dsh-jobs-local/lib/index.js:340`). Severity high → medium. |
| R2.5 "`zcode.detect()` returns no `available` field" | **False.** All three branches set it. Replaced with the real residual issue: template mode reports `available: true` without running. |

R6.3, R7.2/R7.3, R4.2, R5.1, R5.2 and R6.1 all held up under verification, three of them reproduced as executable
failures rather than argued from reading.
