# B2 — lifecycle, reload, and resource bug hunt

**Subject:** `dsh-agent-alliance` 0.2.0 @ `2d68e3f`
**Framework:** installed DSH `0.2.1-rc.2`
(`/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`)
**Method:** every claim below is produced by *executing* the shipped module. Repro
scripts and their literal output are pasted. Probes live in `/tmp/b2/` and are
reproduced inline; they import the plugin by absolute path and never modify it.
Anything I could not execute is labelled **theoretical** and carries no severity claim.

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

*(appended one at a time as each probe completes)*

### F1 — Effect ownership across 3× mount/dispose/remount: **CLEAN** (no finding)

**Severity:** none. **Verdict:** verified clean by execution.

What was checked: all six tools and the prefix route are registered through
`ctx.effect(...)` in `index.js:180` and `index.js:150`, so the plugin fiber owns them.
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
    at registerTools (.../src/tools.js:272)
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

### F4 (medium) — a killed job that never settles holds its owner slot forever, and later background calls **silently become blocking inline calls**

`src/tools.js:160-170` (`jobHooks`) hands the job substrate a `done` promise derived
from the produced work. If the produced work never settles, `done` never settles, so
the job stays `stopping` after `kill()` — forever. `src/tools.js:136-147` (`startJob`)
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
