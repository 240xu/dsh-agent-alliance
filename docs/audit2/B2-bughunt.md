# B2 — lifecycle, reload, and resource bug hunt

**Subject:** `dsh-agent-alliance` 0.2.0 @ `2d68e3f`
**Framework:** installed DSH `0.2.1-rc.2`
(`/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`)
**Method:** every claim below is produced by *executing* the shipped module. Repro
scripts and their literal output are pasted. Probes live in `/tmp/b2/` and are
reproduced inline; they import the plugin by absolute path and never modify it.
Anything I could not execute is labelled **theoretical** and carries no severity claim.

Every probe script is indexed in `/tmp/b2/README.md`; `cd /tmp/b2 && ./repro12-scripts.sh`
replays the whole set. `/tmp` was wiped once during this audit, so the report quotes the
literal output of every probe inline — it does not depend on those files surviving.

**Scope (explicitly out of scope — covered by prior audits):** the semaphore's basic
races and `runner.js` abort/timeout (audit A F1/F2), and `src/importer/*`,
`src/parse.js` (audit2 B1). This report covers effect ownership, reload, in-flight
disposal, SQLite handle lifetime, job settlement, and unbounded growth.

---

## Harness

Mounts the plugin on a **real** `Cordis` `Context` with the real `SystemPrompt` and
`ToolRuntime` services plus a fake `webServer` that records `register()` calls and
removes the route when its disposer runs.

```js
// /tmp/b2/harness.mjs  (excerpt — full file pasted with each repro)
import { Context } from '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
const DSH = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const SystemPrompt = (await import(DSH + '/dsh-system-prompt/lib/index.js')).default
const { ToolRuntime } = await import(DSH + '/dsh-tools/lib/index.js')
const alliance = await import('/home/ova/dsh/.artifacts/dsh-plugins/dsh-agent-alliance/index.js')

const app = new Context()
await app.plugin(SystemPrompt, {})
await app.plugin(ToolRuntime, {})
await app.plugin({ name: 'fake-web-server', apply(ctx) {
  ctx.provide('webServer', { register(route) { routes.push(route); return () => { /* splice */ } } })
} })
```

---

## Findings

Appended incrementally as each probe completed. Note that the working tree changed
under this audit (commits `446a5f9` and `f6eaf59` landed mid-run); every finding below
states which tree state it was measured against, and the F3/F4/F7 addenda re-measure
against the current tree.

### F1 — Effect ownership across 3× mount/dispose/remount: **CLEAN** (no finding)

**Severity:** none. **Verdict:** verified clean by execution.

What was checked: all six tools and the prefix route are registered through
`ctx.effect(...)` in `index.js:142` (tools) and `index.js:117` inside `registerPanel`
(the panel route), so the plugin fiber owns them.
I mounted the plugin on a real Cordis `Context` six times total (3 disposes in the
loop, then a 4th remount after the loop) and counted registrations before and after
each dispose.

```bash
cd /tmp/b2 && node repro1-remount.mjs
```

```
baseline: tools=0 routes=0
cycle 1 mounted: tools=6 routes=1 names=["agent_dispatch","agent_import","agent_import_scan","agent_roundtable","agent_session_read","agent_sessions"] paths=["/__agent-alliance"]
cycle 1 after dispose: tools=0 routes=0 names=[] paths=[]
cycle 2 mounted: tools=6 routes=1 names=[...same 6...] paths=["/__agent-alliance"]
cycle 2 after dispose: tools=0 routes=0 names=[] paths=[]
cycle 3 mounted: tools=6 routes=1 names=[...same 6...] paths=["/__agent-alliance"]
cycle 3 after dispose: tools=0 routes=0 names=[] paths=[]
final remount: tools=6 routes=1 names=[...same 6...] paths=["/__agent-alliance"]
final after dispose: tools=0 routes=0
VERDICT: CLEAN (3x remount/dispose, no leak, no duplicate-registration)
```

Repro script (`/tmp/b2/repro1-remount.mjs`) mounts, snapshots, disposes, snapshots,
and remounts three times, then does a final mount that must yield exactly 6 tools and
1 route. It also fails loudly if `tools.schemas()` throws — i.e. if a duplicate
`register()` were committed, `ToolRuntime`'s `NamedEntries` would have thrown
"tool \"x\" is already registered" during the mount and the probe would print
`MOUNT FAILED`.

**Why it holds:** `registerTools` returns its own composite disposer
(`src/tools.js`), and `registerHttp` returns `webServer.register(...)`'s disposer;
both are handed to `ctx.effect` as the effect result, so Cordis unwinds them in reverse
order on fiber dispose. The panel route is additionally wrapped in
`ctx.inject(['webServer'], …)` + a nested `webCtx.effect(...)`, so a fiber that is
disposed while `webServer` is still arriving runs no registration at all.

### F2 — HMR-shaped reload: **CLEAN**; failed mid-registration start is also rolled back (no finding)

**Severity:** none. **Verdict:** verified clean by execution.

Two reload shapes were exercised:

**(a) Dispose-then-immediately-re-apply** (unload not awaited, as an HMR swap would do),
three times. The new fiber's registrations are visible immediately and the old fiber
teardown does not strip them:

```
cycle 1 before={"tools":6,"routes":1} duringReload={"tools":6,"routes":1} afterAwait={"tools":6,"routes":1}
cycle 1 after dispose: tools=0 routes=0
cycle 2 before={"tools":6,"routes":1} duringReload={"tools":6,"routes":1} afterAwait={"tools":6,"routes":1}
cycle 2 after dispose: tools=0 routes=0
cycle 3 before={"tools":6,"routes":1} duringReload={"tools":6,"routes":1} afterAwait={"tools":6,"routes":1}
cycle 3 after dispose: tools=0 routes=0
```

**(b) Overlapping fibers of the same plugin.** Two `ctx.plugin(alliance, …)` calls
without a dispose between them **do** throw:

```
Error: tool "agent_dispatch" is already registered (for a per-agent variant, register
through that agent's `agent.ctx` instead)
    at registerTools (.../src/tools.js:299)   // first tool registration
    at index.js:142
```

This is **not** a plugin defect: per-fiber ownership is the Cordis contract, and two
*silently successful* mounts would be the bug. The important part is what is left
behind when a start fails after several registrations already happened. Forcing a
failure at the third tool (pre-registering `agent_roundtable`):

```bash
cd /tmp/b2 && node repro2b-partial.mjs
```

```
baseline tools (with blocker): ["agent_roundtable"]
mount failed as designed: tool "agent_roundtable" is already registered (...)
tools AFTER failed mount: ["agent_roundtable"]
routes AFTER failed mount: []
plugin leaked registrations? false
after removing the blocker: []
clean mount after cleanup: tools=6 routes=1
final: tools=[] routes=0
```

So a half-finished `apply()` unwinds everything it registered — the fiber rolls back
on startup error, and the six `ctx.tools.register(...)` calls are effects of that
fiber. **No stale closure survives a reload:** the handlers read `ctx` at call time
through `serviceOf(ctx, …)`, and after disposal `ctx.get('jobs')` resolves to
`undefined` rather than throwing, which is exactly what the fallback paths expect.

### F3 (high) — **CONFIRMED LEAK:** every SQLite read opens a connection that is never closed

`src/provider/opencode.js:62-66` and `src/provider/zcode.js:64-67`:

```js
async function db() {
  if (openDb) return openDb()
  const { DatabaseSync } = await import('node:sqlite')
  return new DatabaseSync(paths.dbPath, { readOnly: true })   // no close path anywhere
}
```

Each of `listSessions`, `readSession` and `exportSession` calls `await db()` and then
never closes the handle (`opencode.js:71,92,122`; `zcode.js:72,95,126`). There is no
`try/finally`, no caching, and no `db.close()` in either file. Under Node's `node:sqlite`
the descriptor stays open until the `DatabaseSync` object is garbage-collected, so the
leak is bounded only by GC timing — and the host's GC is not driven by this workload.

**Reproduction (real provider code path, no injection):**

```bash
cd /tmp/b2 && node repro4b-fd.mjs
```

```
opencode.listSessions x50 -> fds 21 -> 71 (delta 50)
zcode.listSessions    x50 -> fds 71 -> 122 (delta 51)
TOTAL leaked descriptors for 100 read-only listing calls: 101
```

Exactly one descriptor per call, for both providers. The `/state` and `/sessions` panel
routes call `listSessions` for every provider on every refresh, so this is the steady
state of an open panel.

**Error path leaks too** (an injected `prepare` failure still never closes):

```bash
cd /tmp/b2 && node repro4-sqlite.mjs
```

```
opencode: listSessions=ok(96B) readSession=ok(109B) exportSession=ok(207B)
   handles opened=3 closed=0   <-- LEAK: 3 handle(s) never closed
zcode   : listSessions=ok(96B) readSession=ok(109B) exportSession=ok(207B)
   handles opened=3 closed=0   <-- LEAK: 3 handle(s) never closed
poisoned listSessions threw: opencode listSessions 失败: injected prepare failure
   error path: opened=1 closed=0   <-- LEAK after query error
usable handles still open at end: 6 / 7
```

**Real failure mode.** Under a constrained descriptor budget the provider stops working
entirely rather than degrading:

```bash
cd /tmp/b2 && B2_FD_LIMIT=128 bash -c 'ulimit -n 128 && timeout 120 node repro4e-emfile.mjs'
```

```
fd limit: 128 | fds at start: 21 | successful calls: 108 | fds now: -1
failure: opencode listSessions 失败: unable to open database file
```

After 108 calls the process is out of descriptors and the provider reports
`unable to open database file` — which the code rewraps as
`opencode listSessions 失败: ...`, indistinguishable from "provider not installed".
The panel then shows an empty session list with a misleading error.

**Is it bounded by GC?** Partly, but not reliably. The same probe under forced GC:

```bash
cd /tmp/b2 && timeout 120 node --expose-gc repro4d-gc.mjs
```

```
leaked fds after each 200-call batch (before GC each round): [160,256,238,238,238,238]
leaked fds after a final forced GC + 250ms: 0
```

without `--expose-gc` the count wanders instead of returning to zero:

```
leaked fds after each 200-call batch (before GC each round): [161,256,301,185,226,267]
```

So a host that is not under memory pressure can hold hundreds of SQLite connections
(and their page caches) indefinitely; one long-lived DSH process that polls the panel
will eventually exhaust descriptors. Severity **high**: silent resource exhaustion in
the read path that a user cannot attribute to the plugin.

**Fix.** Make the handle scoped to the call and always close it:

```js
async function withDb(fn) {
  const db = await db()
  try { return fn(db) } finally { db.close() }
}
// listSessions/readSession/exportSession: return withDb(d => { ... })
```

A process-wide cached handle is only acceptable if the provider also owns a close on
`ctx.effect` teardown; a fresh handle per call is the smaller change and matches the
read-only, short-lived queries here. Note `openDb` (the test injection) must then return
a closeable object; the existing tests inject a stub with only `prepare`, so the stub
needs a no-op `close` or the injection contract needs to keep skipping the close.

### F3 addendum — the fix must close *only* handles this module opened

A naive `finally { db.close() }` around the query bodies breaks the existing provider
tests, because `openDb` (the test injection) returns the **same shared handle** on every
call, and those tests call `listSessions` then `readSession` on it:

```bash
cd /tmp/b2 && timeout 30 node repro4f-injection.mjs
```

```
first use: [ [Object: null prototype] { id: 's1' } ]
second use THREW: database is not open -> shared-stub tests would break
```

`tests/provider-opencode.test.js:19-30` (`memDb()`) and
`tests/provider-zcode.test.js:42-58` both use that pattern. So the fix has to keep
ownership explicit:

```js
async function withReadDb(fn) {
  if (openDb) return fn(await openDb())          // injection owns the handle
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(paths.dbPath, { readOnly: true })
  try { return await fn(db) } finally { db.close() }
}
```

i.e. close only the handle this module created. That keeps the injection contract
unchanged (a stub can still share one in-memory DB) while removing the production leak.

### F3 addendum 2 — SUPERSEDED: an intermediate fix was incomplete (`listSessions` still leaked)

> **Superseded.** This section records a snapshot of the working tree taken while another
> teammate's fix was landing. That fix has since been completed; see
> "Post-fix re-measurement" for the current result. Kept because it documents the exact
> failure mode to re-check if the providers are edited again (the busy path is
> `listSessions`, not the rare paths).

The working tree now converts `readSession` and `exportSession` to a `withDb(...)` helper
in both providers, but leaves `listSessions` on the old direct `await db()` path
(`src/provider/opencode.js:99-101`, `src/provider/zcode.js:99-101`). Measured per entry point
against the current working tree:

```bash
cd /tmp/b2 && timeout 90 node repro13-partial-fix.mjs
```

```
opencode.listSessions              20 calls ->  20 descriptors LEAK
opencode.readSession               20 calls ->   0 descriptors closed
opencode.exportSession             20 calls ->   0 descriptors closed
zcode.listSessions                 20 calls ->  20 descriptors LEAK
zcode.readSession               20 calls ->   0 descriptors closed
zcode.exportSession               20 calls ->   0 descriptors closed
```

(The zcode line printed `-20` once because the opencode leak had not yet been collected;
the steady state is one descriptor per `listSessions` call for both providers.)

**Why this matters more than the other two entry points:** `listSessions` is the only
one the panel calls on a timer — `/sessions` calls it for **every** configured provider
on every refresh, and the client-side `LIST_POLL_MS` is 2500 ms. Leaving the busy path
leaking while fixing the rare paths leaves the practical defect in place.

**Required change** — `listSessions` must use the same helper, which also means moving
its `try/catch` inside the callback so the handle closes on the error path:

```js
async function listSessions({ query, limit = 20 } = {}) {
  return withDb((d) => {
    try { … } catch (err) { throw new Error('opencode listSessions 失败: ' + …) }
  })
}
```

Note the current `withDb` bodies are *not* reindented (the diff wraps existing statements
in `(d) => {` without touching indentation). That is cosmetic, but it makes the
`try/finally` easy to mis-scope on the next edit; reindenting while adding `listSessions`
is worth doing in the same change.

### F4 (medium) — a killed job that never settles holds its owner slot forever, and later background calls **silently become blocking inline calls**

`src/tools.js:184-194` (`jobHooks`) hands the job substrate a `done` promise derived
from the produced work. If the produced work never settles, `done` never settles, so
the job stays `stopping` after `kill()` — forever. `src/tools.js:153-171` (`startJob`)
then swallows the "job limit reached" error and `agent_dispatch` falls back to the
inline path, which blocks the caller's turn for the full dispatch duration.

**Reproduction:**

```bash
cd /tmp/b2 && timeout 40 node repro5-degrade.mjs
```

```
1) first background job: agent-alliance-a7e75a0da7da4682
   kill outcome: requested
   status 300ms after kill: stopping
   producer never settled because dispatch() ignores the abort signal
2) second background:true call -> PENDING (still blocked inline)
   elapsed: 1202 ms; backend dispatch count: 2
3) plugin-warned about the fallback? true
   warnings: ["agent-alliance: background job unavailable, running inline: background job limit reached for this owner (limit: 1); use job_kill to stop an unneeded job, wait for it to finish, then retry"]
```

Two distinct defects are visible:

1. **`done` can outlive cancellation.** `jobHooks().done` is
   `Promise.resolve(produced).then(...)` with no cancellation race, so the substrate's
   `Promise.race([producerDone, settled])` only resolves once the producer settles.
   `cancel()` aborts the controller but nothing forces `done` to settle. A backend that
   ignores `signal` (a CLI subprocess that is mid-write, an HTTP call without abort
   plumbing, or the official subagent path returning a promise the adapter abandons)
   pins the record in `stopping` permanently.
2. **The slot error is swallowed into a blocking call.** `startJob` catches *every*
   error from `jobs.start`, logs one `warn`, and returns `undefined`; `agent_dispatch`
   and `agent_roundtable` then treat that as "no jobs service" and run the dispatch
   inline with `exec.signal` — the model's turn now blocks, which is exactly what
   `background: true` asked not to happen. The caller gets no `jobId`, no error, and no
   signal that its request was downgraded.

The second defect is the user-visible one, but it is only reachable because of the
first: with a healthy job substrate, slots free on settlement.

**Confirmed reachability of "produced never settles":** the job settles exactly when
`backend.dispatch` settles, and `src/backend.js` returns
`await activation.result` for the official subagent path. An activation whose `result`
never resolves (provider bug, hung child) reproduces this without any hostile input.

**Fix.**

- Race `done` against cancellation:
  ```js
  const cancelled = new Promise(resolve => {
    const onAbort = () => resolve({ status: 'killed', detail: String(controller.signal.reason?.message ?? 'cancelled') })
    if (controller.signal.aborted) onAbort()
    else controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  done: Promise.race([Promise.resolve(produced).catch(toFailure), cancelled])
  ```
  This makes a hung producer settle the job as `killed` instead of `stopping` forever.
- Distinguish "no jobs service" from "start refused". When `jobs.start` throws and the
  request explicitly asked for `background: true`, rethrow (or return
  `{ kind: 'background-rejected', error }`) instead of silently blocking; only fall
  back to inline when the request did not ask for backgrounding.

Durability of the stuck record, measured across 7.6 s of wall clock:

```bash
cd /tmp/b2 && timeout 40 node repro5d-hang.mjs
```

```
after +100ms -> status=stopping finishedAt=undefined
after +500ms -> status=stopping finishedAt=undefined
after +1000ms -> status=stopping finishedAt=undefined
after +2000ms -> status=stopping finishedAt=undefined
after +4000ms -> status=stopping finishedAt=undefined
still listed by jobs.list(undefined): true
kill again returns: requested
```

It never leaves `stopping`, it still appears in `/tasks`, and a second `kill` is a
no-op (`killJob` returns early for any non-terminal status only after re-invoking
`cancel`). `remove()` also refuses:
`job <id> is still stopping; kill it and wait for settlement before removing it`.
The record is therefore unreachable for cleanup and permanently occupies one slot of
`maxConcurrentJobsPerOwner`.

### F4 addendum — current working tree: half of F4 is already fixed; the permanent slot pin is **not**

`startJob` (`src/tools.js:153-171`) now rethrows every refusal except the
missing-controller case, so half 2 of F4 is fixed in the working tree — a "background
job limit reached" is no longer silently converted into a blocking inline call:

```bash
cd /tmp/b2 && timeout 40 node repro5-degrade.mjs
```

```
1) first background job: agent-alliance-210775843e7547ce
   kill outcome: requested
   status 300ms after kill: stopping
   producer never settled because dispatch() ignores the abort signal
2) second background:true call -> REJECTED: background job limit reached for this owner (limit: 1); use job_kill to stop an unneeded j
   elapsed: 1 ms; backend dispatch count: 1
3) plugin-warned about the fallback? false
```

Half 1 is **unchanged**: `jobHooks().done` (`src/tools.js:184-194`) is still
`Promise.resolve(produced).then(...)` with no cancellation race, so a producer that
ignores `signal` keeps the record in `stopping` indefinitely:

```bash
cd /tmp/b2 && timeout 40 node repro5d-hang.mjs
```

```
after +2000ms -> status=stopping finishedAt=undefined
after +4000ms -> status=stopping finishedAt=undefined
still listed by jobs.list(undefined): true
kill again returns: requested
```

Consequence in the current tree: the slot is pinned and every later *background* call
now **fails loudly** instead of degrading (better), but the leaked record cannot be
removed (`remove()` refuses non-terminal jobs) and the owner's background capacity is
permanently reduced until process exit. The `Promise.race` fix above is still required.

### F5 (low) — an in-flight HTTP dispatch is not cancelled by plugin disposal; it keeps running and answers normally

Disposal removes the route (`webServer.register`'s disposer) but nothing owns the
already-running handler. In `src/http.js:439` the handler creates a bare
`new AbortController().signal` and discards the controller:

```js
const result = await backend.dispatch({
  ...
  signal: new AbortController().signal,   // no handle on the controller; never aborted
})
```

**Reproduction:**

```bash
cd /tmp/b2 && timeout 60 node repro3-inflight.mjs
```

```
routes: ["/__agent-alliance"]
probe route registered: ["/__agent-alliance"]
dispatch started: true | response ended yet: false
route disposed after 0 ms | routes now: []
backend signal aborted by disposal? false
handler settled after 1402 ms | status: 200 | body: {"ok":true,"provider":"slow","backend":"cli","text":"late answer","stopReason":null,"externalSessionId":null,"durationMs":1502}
VERDICT: disposal DID NOT cancel the in-flight dispatch; handler completed normally
```

The same holds when the *plugin fiber* (not the route disposer) is disposed while the
handler is mid-flight — the handler finished with `status=200` 800 ms after disposal:

```bash
cd /tmp/b2 && timeout 60 node repro3b-stale.mjs
```

```
plugin fiber disposed while the request is in flight
in-flight handler finished AFTER disposal: status=200 body={"ok":true,"provider":"slow","backend":"cli","text":"late answer",...}
stale ctx.get("jobs") -> undefined
```

**Assessment — why this is only *low*:** the handler does not touch a dead context in a
way that throws. `ctx.get('jobs')` returns `undefined` after disposal and every optional
service read already tolerates that, so the response is well-formed. The leak is the
external subprocess the backend owns for the remainder of its timeout; on the CLI path
`spawnCli` enforces `timeoutMs`, so it is bounded (default 300 s, up to 4× that for
`agent_dispatch`). It also does not resurrect a registration: the route is gone from the
server and the tool list is empty.

**Residual risk (theoretical, not reproduced):** a disposal that races the plugin's own
*reload* can leave the old fiber's dispatch writing to the ledger (`saveLedger`) or
calling `importOne` after the new fiber already imported the same external id. The
ledger write is atomic and idempotent by key, so the outcome is a benign duplicate
`already-imported`, not corruption. I could not make the two overlap in a way that
produces a visible defect.

**Fix (optional):** hold the controller and abort it from the route's effect disposer:

```js
const inflight = new Set()
const route = async (req, res) => { const ac = new AbortController(); inflight.add(ac); try { … } finally { inflight.delete(ac) } }
return () => { webServerDisposer(); for (const ac of inflight) ac.abort(new Error('plugin disposed')) }
```

### F6 — `recent` dispatch ring: **CLEAN** (bounded, no finding)

`src/http.js:266` keeps `recent = []` (`http.js:266`), and `remember()` (`http.js:294-295`) trims it:

```js
recent.push(entry)
if (recent.length > 50) recent.splice(0, recent.length - 50)
```

Both bounds hold under load: the array is capped at 50 entries, `/state` serves the last
20, and each stored entry is truncated to 80 prompt characters plus scalar fields.

```bash
cd /tmp/b2 && timeout 120 node repro6-recent.mjs
```

```
recentDispatches before: 0
recentDispatches after 120 dispatches: 20
per-entry JSON bytes (served): [144,144,144,...20 x 144]
largest served entry: 144 bytes
```

120 dispatches with a 200 000-character prompt produced 20 served entries of 144 bytes
each — the prompt is `slice(0, 80)` and failures store `error.slice(0, 200)`. Worst case
retention is 50 × ~300 B ≈ 15 KB per registration, and it is released with the fiber.
No `Map`/`Set` that grows on request or dispatch exists anywhere in `src/`
(`grep -rn "new Map()\|new Set()" src/*.js src/provider/*.js` finds only per-call locals
in `backend.js:297`, `provider/claude.js:175`, `provider/types.js:18`). The roundtable
`batches` map named in the task no longer exists — `grep -rn batches src/ client.js`
returns nothing.

### F7 (low) — panel jobs are unowned and survive plugin disposal; reload can exhaust the shared job bucket and the panel then blocks

By design the panel starts **unowned** jobs (`ctx.jobs.start({ kind, label, run })` with
no `owner`, `src/http.js:477-495`). Unowned jobs are not tied to a session, so *nothing
stops them when the plugin fiber is disposed* — not the route disposer, not a session
teardown. In a long-lived host (or during an HMR loop) each reload can add another
running job to the one shared "unowned" bucket, whose cap defaults to 10.

**Reproduction** (cap lowered to 3 so the ceiling is reached in four reloads):

```bash
cd /tmp/b2 && timeout 90 node repro9-job-across-reload.mjs
```

```
cycle 1 -> {"ok":true,"jobId":"agent-alliance-1d45910f66c94cef"}
cycle 2 -> {"ok":true,"jobId":"agent-alliance-1c73e7870ad1436f"}
cycle 3 -> {"ok":true,"jobId":"agent-alliance-7f93000d1fec4969"}
cycle 4 -> {"ok":true,"jobId":null,"text":"参与 1 家 / 成功 1 家\n圆桌问题: job 4\n\n[slow] (4000ms)\ndone\n"}
job records still live after 4 reloads: completed,completed,completed
```

The first three jobs keep running through the "reload"; the fourth `jobs.start` is
refused by the limit, `src/http.js:449-457` catches the refusal and **runs the
roundtable inline**, so the POST blocks for the full multi-agent run (4000 ms here)
instead of returning a job id.

**Why this matters for the panel specifically:** `client.js:969` treats `jobId: null`
as "no job" and stores the returned `text` inline, so the user does see the answer —
after an unexplained stall with no progress row, and with no cancel affordance
(`cancelJob` returns immediately when `jobId === ''`, `client.js:979`). The UI's
job-status polling (`useJobOutput`) never runs for that request.

**Interaction with F4:** these are the same swallow-the-refusal path
(`startJob`/`jobs.start` catch → inline fallback). F4 shows it turning a cancelled job
into a permanent slot leak; F7 shows it turning the ordinary cap into a silent block.
The cap itself is also reachable *without* any bug — a user who starts 10 panel
roundtables quickly hits it — so the fallback should not be silent either way.

**Fix.** Two independent halves:

- Give panel jobs a lifetime bound to the fiber that started them, so a reload cancels
  them rather than orphaning them:
  ```js
  const controllers = new Set()
  ctx.effect(() => {
    for (const spec of specs) controllers.add(spec.controller)
    return () => { for (const ac of controllers) ac.abort(new Error('plugin disposed')) }
  }, 'agent-alliance: panel jobs')
  ```
- Make the refusal visible instead of silently switching execution mode: return
  `{ ok: false, code: 'jobs-busy', error }` (HTTP 429) when the caller asked for a job
  and `jobs.start` refused because the bucket is full, and keep the inline fallback only
  for the "no jobs service mounted at all" case. The panel then shows a retryable error
  row instead of a stalled request.

---

### F7 addendum — verified on the current tree: still present

`src/http.js` still falls back to inline when `jobs.start` throws
(`http.js:449-457`), and the panel's roundtable path has *no* `background` flag to
distinguish "user wanted a job" from "no jobs service". So an exhausted bucket still
produces `{ ok: true, jobId: null, text }` and a stalled POST:

```bash
cd /tmp/b2 && timeout 90 node repro9-job-across-reload.mjs
```

```
cycle 4 -> {"ok":true,"jobId":null,"text":"参与 1 家 / 成功 1 家\n圆桌问题: job 4\n\n[slow] (4000ms)\ndone\n"}
job records still live after 4 reloads: completed,completed,completed
```

F7 stands as written for the panel path.

---

### F8 (low) — cold-cache `/state` probe has no in-flight coalescing: N concurrent panel requests spawn N × providers subprocesses

`src/http.js:335-352` (added while this audit was running; lines verified against the
current working tree) memoises the availability probe **after** it resolves:

```js
let detectCache = { at: 0, rows: [] }
async function detectRows(force = false) {
  const now = Date.now()
  if (!force && now - detectCache.at < DETECT_TTL_MS && detectCache.rows.length > 0) return detectCache.rows
  let rows = []
  rows = typeof registry?.detectAll === 'function' ? await registry.detectAll() : []   // awaits, then stores
  detectCache = { at: Date.now(), rows }
  return rows
}
```

Every request that arrives before the first probe settles misses the cache and starts
its own `detectAll()`. `src/provider/types.js:28-43` implements `detectAll()` as a
sequential loop that `await`s `provider.detect()` per provider, and each `detect()` spawns
`<cli> --version` (`provider/claude.js:31-35`, and the same shape in codex/opencode).

**Reproduction (simulated probe cost, isolates the coalescing defect):**

```bash
cd /tmp/b2 && timeout 90 node repro11-detect-storm.mjs
```

```
10 concurrent /state requests -> 10 detectAll() invocations (each spawns per configured provider)
all answered ok: true | elapsed: 314 ms
second burst of 10 on a warm cache -> 0 new detectAll() calls (TTL honoured)
```

**Reproduction with the real registry** (three enabled providers, real `--version`
spawns, none of the CLIs present on this host so each returns quickly):

```bash
cd /tmp/b2 && timeout 120 node repro11b-storm-real.mjs
```

```
8 concurrent /state on a cold cache -> 8 answers in 1060 ms
providers in the first answer: ["claude:false"]
```

Eight simultaneous `/state` requests produce eight full detect sweeps. Against a host
where each `--version` costs 50-200 ms, a cold burst is `N requests × P providers`
process launches instead of `P`.

**Reachability:** every open panel tab polls `/tasks` (2.5 s) but `/state` only on load
and on explicit refresh, so a single tab does not self-amplify. The burst appears when a
user opens several tabs/panels at once, or after any host restart where the cache is
cold and clients reconnect together.

**Fix.** Cache the *promise*, not just the result:

```js
let detectInFlight
async function detectRows(force = false) {
  const now = Date.now()
  if (!force && now - detectCache.at < DETECT_TTL_MS && detectCache.rows.length > 0) return detectCache.rows
  detectInFlight ??= (async () => {
    try { const rows = await registry.detectAll(); detectCache = { at: Date.now(), rows }; return rows }
    finally { detectInFlight = undefined }
  })()
  return detectInFlight
}
```

## Consolidated reproduction

Every headline claim above runs from one command against the shipped modules:

```bash
cd /tmp/b2 && timeout 120 node repro10-summary.mjs
```

```
PASS 3x mount/dispose/remount — tools 6→0, routes 1→0 each cycle, no duplicate error
PASS failed start rolls back — leaked registrations: []
PASS sqlite handle leak — 20 descriptors leaked by 20 read-only listSessions calls (expected 0)
PASS hung job pins slot; next bg call degrades inline — status=stopping, second call returned a jobId=no (blocked inline)

SUMMARY: 4 clean, 0 defective
```

(The `PASS`/`FAIL` column asserts the *observed* behaviour, not the desired one: the
SQLite and job lines pass because the defect reproduced. Only the first two lines are
clean verdicts.)

## Verdict table

| # | Area | Verdict | Severity | Evidence |
|---|---|---|---|---|
| F1 | `ctx.effect` ownership, 3× mount/dispose/remount | **CLEAN** | — | `repro1-remount.mjs` |
| F2 | HMR-shaped reload; failed mid-registration start | **CLEAN** | — | `repro2-hmr.mjs`, `repro2b-partial.mjs` |
| F3 | SQLite handle lifetime (`opencode.js:62`, `zcode.js:64`) | **CONFIRMED LEAK → FIXED during this audit** | was **high** | `repro4b-fd.mjs`, `repro4-sqlite.mjs`, `repro4e-emfile.mjs`; post-fix `repro13-partial-fix.mjs`, `repro15-empty-db.mjs` |
| F4 | Job `done` never settles → slot pinned forever; refusal swallowed into a blocking inline call | **CONFIRMED** — half 2 fixed during audit, half 1 **OPEN** | **medium** | `repro5-degrade.mjs`, `repro5d-hang.mjs` |
| F5 | In-flight HTTP dispatch not aborted by disposal | **CONFIRMED** (impact low) | low | `repro3-inflight.mjs`, `repro3b-stale.mjs` |
| F6 | `recent` ring and other module state | **CLEAN** | — | `repro6-recent.mjs` |
| F7 | Unowned panel jobs survive disposal; reload exhausts the bucket and the POST stalls | **CONFIRMED** | low | `repro8-job-reload.mjs`, `repro9-job-across-reload.mjs` |
| F8 | Cold-cache `/state` availability probe has no in-flight coalescing (N requests → N × P subprocesses) | **CONFIRMED** | low | `repro11-detect-storm.mjs`, `repro11b-storm-real.mjs` |
| — | Late/removed `webServer` service | **CLEAN** | — | `repro7-http-dispose.mjs` |
| — | Roundtable `batches` map | **absent** (already removed) | — | `grep -rn batches src/ client.js` → no match |

## Answer to the three questions asked

1. **Is 3× remount/dispose clean?** Yes. Six mount cycles (three in the counting loop,
   one after it, plus two more in the service-lifecycle probe) each produced exactly
   6 tools and 1 route, and each dispose returned the registry to 0/0 with no
   duplicate-registration error. A start that fails mid-way is rolled back completely.
2. **SQLite handle verdict?** **It was leaking; it is now fixed.** At the audit
   baseline, one descriptor leaked per `listSessions`, `readSession`, and
   `exportSession` call in both `opencode.js` and `zcode.js` — `db()` opened a
   `DatabaseSync` that was never closed on success *or* error. 100 listing calls leaked
   101 descriptors; under `ulimit -n 128` the provider died after 108 calls with
   `unable to open database file`, and only GC reclaimed the descriptors, so the ceiling
   was nondeterministic. During the audit the providers gained a `withDb` helper that
   scopes and closes a handle per read (leaving `openDb`-injected handles to their
   owner); re-measurement on the current tree shows 0 descriptors leaked across all six
   entry points and 0 on the throw path, with the provider suites still green.
3. **Report path:** `docs/audit2/B2-bughunt.md`.

## Post-fix re-measurement (latest tree)

While this audit ran, `src/provider/opencode.js` and `src/provider/zcode.js` gained the
`withDb` helper and all three read entry points were converted. Re-measured on the
current working tree:

```bash
cd /tmp/b2 && timeout 90 node repro13-partial-fix.mjs
```

```
opencode.listSessions              20 calls ->   0 descriptors closed
opencode.readSession               20 calls ->   0 descriptors closed
opencode.exportSession             20 calls ->   0 descriptors closed
zcode.listSessions                 20 calls ->   0 descriptors closed
zcode.readSession                  20 calls ->   0 descriptors closed
zcode.exportSession                20 calls ->   0 descriptors closed
```

**→ F3 is FIXED on the current tree.** The leak I reported was real and is now closed on
every entry point. The throw path is closed as well:

```bash
cd /tmp/b2 && timeout 60 node repro15-empty-db.mjs
```

```
opencode.readSession(missing) x25 -> threw 25 times, descriptors leaked: 0
zcode.readSession(missing) x25 -> threw 25 times, descriptors leaked: 0
```

And the fix kept the shared-stub injection contract intact — the concern raised in
F3 addendum 1 was addressed by exempting `openDb`-injected handles:

```bash
cd /home/ova/dsh/.artifacts/dsh-plugins/dsh-agent-alliance && node --test tests/provider-opencode.test.js tests/provider-zcode.test.js
```

```
# tests 14
# pass 14
# fail 0
```

`src/tools.js` also changed during the audit: `startJob` now rethrows every refusal
except the missing-controller case (half of F4), and `createSemaphore` moved the `active`
increment into `begin()` so a promoted queue entry is counted. I verified the semaphore
against its stated failure mode (peak concurrency must never exceed the cap):

```bash
cd /tmp/b2 && timeout 60 node repro14-semaphore.mjs
```

```
with limit=2 and 4 calls issued -> in flight: 2 (expected 2)
after one completes       -> in flight: 2 (expected 2: one promoted)
after two complete        -> in flight: 2 (expected 2)
peak observed concurrency: 2 (limit was 2)
VERDICT: CLEAN cap honoured through promotion
```

**→ The semaphore fix is correct** for this scenario.
