# A3 — Adversarial audit of the planned / in-flight patches

Role: red-team the implementation of the 7 first-batch fixes **before** they are finalised.
Repo `dsh-agent-alliance`, audited at `2d68e3f` (audit commit) with the Lead's fix work observed in
progress. READ-ONLY: this file is the only artifact.

**Status: in progress** — one section per fix, appended.

## What was actually reviewed

The Lead began patching while this audit ran, so this report reviews the **real diffs**, not hypothetical
ones. That is strictly better than reviewing a plan: every claim below is against code that exists.

| Fix | Status at review time | Where |
|---|---|---|
| 1. `startJob` catches + inline fallback | **committed** (`2f6660e`) | `src/tools.js:126-146`, `src/http.js:434-469` |
| 2. `/state` real availability | **not started** | `src/backend.js:363-385` still returns `available: true` |
| 3. `resumeSessionId` guard moved up | **committed** | `src/backend.js:228-231` |
| 4. pre-aborted signal rejected | **committed** | `src/tools.js:50-56` |
| 5. round-2 prompt starts with `basePrompt` | **not started** | `src/roundtable.js:5-20` unchanged |
| 6. roundtable inside `maxConcurrent` | **not started** | `src/tools.js:412-424` bypasses `gate` |
| 7. exclude member's own prior answer | **not started** | `src/roundtable.js:7-9` includes self |

Verification baseline: `node --test 'tests/*.test.js'` → **188 pass / 0 fail** at review time.

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
not a registry service, so `Reflect.get(name)` returns nothing for it (`reflect.ts:227-230` consults
`reflect.props`/store, and `logger` is neither). Every failure path in the new catch block is therefore a silent
swallow — precisely the "invisible degradation" the audit criticised elsewhere.

The plugin already has a correct pattern for this: `index.js:65-73`'s `logFailure` reads `ctx.logger?.[level]`
directly and calls it. The patch ignores it and reinvents it incorrectly.

**BAD vs CORRECT**

```js
// BAD (as committed): dead branch, no diagnostic
const logger = serviceOf(ctx, 'logger')
if (logger !== undefined) logger.warn(...)

// CORRECT: use the property the plugin already relies on, guarded
const log = ctx?.logger?.warn
if (typeof log === 'function') log.call(ctx.logger, 'agent-alliance: …')
```

`src/http.js` has the same bug in a different form — `ctx?.get?.('logger')`:

```js
const logger = ctx?.get?.('logger')      // ALWAYS undefined
if (logger !== undefined && typeof logger?.warn === 'function') logger.warn(...)
```

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

The per-owner limit is the realistic case: `maxConcurrentJobsPerOwner` is a host setting (default small), and the
roundtable path is background-by-default, so a user who fires several roundtables hits it routinely.

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

### R2.5 — edge case the naive version gets wrong: detection failure is not unavailability

`detectAll()`'s own `catch` (`types.js:37-39`) maps a **thrown** `detect()` to `available: false`. But `zcode`
throws nothing and returns a *reason string* ("未配置 commandTemplate") without an `available` field at all, so
`...d` yields `available: undefined`. The naive `stateOf(id)?.available === true` then reports `false`
correctly by luck — but the patch must not conflate the three states "not installed", "installed and broken",
"not configured". The panel needs the `detail` string to distinguish them, and the report's own suggestion
(`detail: stateOf(providerId)?.detail`) only works if `detail` is preserved for every branch.

---

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
