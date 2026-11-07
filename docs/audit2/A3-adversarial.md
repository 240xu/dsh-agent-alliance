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
