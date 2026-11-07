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
