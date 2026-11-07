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
| R1.1 | `serviceOf(ctx,'logger')` is dead — every degradation is silent, in both `tools.js` and `http.js` | **high** | committed |
| R1.2 | catch swallows *all* `jobs.start()` failures, incl. per-owner capacity → multi-minute silent inline hang | **high** | committed |
| R7.3 | naive Fix 7 makes a solo member debate an empty peer list | **high** | not yet written |
| R6.1 | gating the whole roundtable deadlocks at `maxConcurrent: 1` | **high** | not yet written |
| R2.3 | filtering `enabled:false` from `providerIds()` kills official dispatch for a disabled CLI wrapper | **medium** | not yet written |
| R4.2 | moving the abort check into `begin()` leaks the slot permanently (proved) | **medium** | trap, not present |
| R4.3 | plain `Error` instead of `AbortError` mislabels cancellation as failure in the transcript | **medium** | committed |
| R5.2 | `原始问题：` becomes redundant and duplicates the question each round | **medium** | not yet written |
| R6.2 | gate rejection is attributed to the *member* as a failure and drops it from later rounds | **medium** | not yet written |
| R1.3 | `http.js` inline fallback reuses a dead, uncancellable controller | **medium** | committed |
| R3.1 | removal of `activation.result.catch()` re-opens an unhandled-rejection window | **low** | committed |
| R2.5 | detection failure is not the same as unavailability; `zcode` returns no `available` field | **low** | not yet written |
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
