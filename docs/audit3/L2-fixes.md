# L2 — Adversarial audit of the fix commits

**Repo:** `dsh-agent-alliance`, HEAD **`519be02`**
**Scope:** the 16 commits in `git log e15fcf8..HEAD`
**Stance:** prove each fix is broken, incomplete, or regressive. Every verdict
carries a reproduction command and its literal output, so a reader can re-run
rather than trust me.

Verdict vocabulary:
- **FIX HOLDS** — I attacked it and could not break it.
- **REGRESSION** — the fix works as intended but introduces a new defect.
- **INCOMPLETE** — the fix does not cover a path its commit message claims.

Read-only. No source was modified.

---

## C1 — `withDb` SQLite close (`1b15214`)

*(pending)*

## C2 — `detectAll` parallel + budget (`15bc8c8`)

**VERDICT: REGRESSION.** The budget works — `detectAll` returns promptly and
never blocks `/state` — but it abandons the losing `detect()` instead of
cancelling it. The orphaned probe keeps its `--version` child alive, and
because `detectAll` is reachable from a polling route, orphans accumulate and
delay process shutdown.

### The mechanism

`src/provider/types.js` `detectAll`:

```js
const timeout = new Promise((resolve) => {
  timer = setTimeout(() => resolve({ available: false, detail: 'probe timed out' }), budgetMs)
  timer.unref?.()
})
try {
  const d = await Promise.race([p.detect(), timeout])
  ...
} finally {
  if (timer !== undefined) clearTimeout(timer)
}
```

`Promise.race` does not cancel the loser. `p.detect()` keeps running, and on
every real provider that means a live `spawnCli` child
(`src/provider/claude.js` `--version`, `codex.js`, `opencode.js` each pass
`timeoutMs: 15000/20000/15000`). Those per-probe timeouts are what eventually
reap the child — up to **20 s** after `detectAll` already answered.

### Reproduction 1 — the child outlives the answer

```
$ node /tmp/C2b.mjs
detectAll returned after 101ms -> [{"id":"slow","label":"Slow","available":false,"detail":"probe timed out"}]
at return: child exited? false | the tool now shows available: false
the orphaned --version child is STILL RUNNING: true
4.2s later: child finally exited? true | detect() resolved? true
```

The panel is told the provider is unavailable while a probe for it is still
executing. Cosmetic, but it also means a *correct* slow provider is reported
`available: false, detail: 'probe timed out'` — the panel cannot distinguish
"not installed" from "installed but the machine was busy for 2.5 s".

### Reproduction 2 — orphans accumulate under polling

```
$ node /tmp/C2c.mjs
poll 1: returned false | orphaned children alive: 1
poll 2: returned false | orphaned children alive: 2
poll 3: returned false | orphaned children alive: 3
poll 4: returned false | orphaned children alive: 4
peak concurrent orphans: 4
```

This is worse in the real route because `detectRows` in `src/http.js:346-362`
caches the **promise** for 30 s — but only *after* `detectAll` settles. If the
TTL expires while a probe is still orphaned, the next `/state` starts a fresh
sweep. With the panel's 30 s TTL and four providers whose probes can each run
20 s, a machine with three hung CLIs can stack sweeps.

### Reproduction 3 — process shutdown is delayed

```
$ node /tmp/C2f.mjs
detectAll returned at 101 ms. Now letting the script end naturally...
PROCESS EXITED at 3154 ms after detectAll returned
```

A 100 ms budget produced a **3 s** shutdown delay. For a `dsh` CLI invocation
that renders `/state` once and exits (headless/scripted use), this is the
difference between a 200 ms command and a 3 s one. For the long-lived Web host
it is invisible — which is exactly why it went unnoticed.

### What is *correct* — and what the commit got right

Two sub-claims tested and clean:

1. **The `unref()` on the budget timer is not a starvation bug.** I expected
   the timer never to fire in a handle-free process; it does, because the
   `Promise.race` microtask still runs. Verified:

```
$ node /tmp/C2d.mjs
settled after 115 ms: [{"id":"hung","label":"Hung","available":false,"detail":"probe timed out"}]
```

2. **No unhandled rejection from a late-throwing orphan.** `try/catch` around
   the `await` covers the race result, and the loser's rejection is swallowed
   by the already-settled race. Verified: `unhandledRejection` never fired
   (`/tmp/C2e.mjs`).

So the fix is not wrong — it is one `AbortController` short of correct.

### Corrected form

Thread a signal through `detect()` so the losing probe can actually be stopped,
and kill the child rather than waiting for its own 20 s timeout:

```js
async detectAll({ budgetMs = 2500, signal } = {}) {
  const rows = await Promise.all([...byId.values()].map(async (p) => {
    if (typeof p.detect !== 'function') return { id: p.id, label: p.label, available: false, detail: 'no detect()' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('probe timed out')), budgetMs)
    try {
      const d = await p.detect({ signal: controller.signal })
      return { id: p.id, label: p.label, ...d }
    } catch (err) {
      return { id: p.id, label: p.label, available: false,
               detail: String(err?.message || err) === 'probe timed out'
                 ? 'probe timed out' : String(err?.message || err) }
    } finally { clearTimeout(timer) }
  }))
  return rows
}
```

and have each `detect()` forward that signal into its `spawnCli({ signal })`
call — `spawnCli` already kills the child on abort (`src/runner.js` `onAbort`),
so the whole orphan class disappears. Minimal alternative if signals are too
invasive: put the budget **inside** `spawnCli` by passing
`timeoutMs: Math.min(budgetMs, 15000)`, so the child cannot outlive the answer.

**Severity: medium.** No user-visible failure in the Web host; it costs a child
process and up to 20 s of shutdown latency per timed-out probe, and it makes
`available: false` ambiguous between "missing" and "slow".

---

## C3 — `normalizeEnv` credential scrub (`832f314`)

**VERDICT: REGRESSION.** The scrub removes real credential names correctly, but
its regex is far broader than the seam's and silently deletes ordinary host
variables from every CLI child. `SESSION` is the worst offender — it is **not**
in the official pattern.

### The two patterns

Official, `subprocess/subprocess/src/index.ts:45`:

```ts
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i
```

Ours, `src/runner.js:29`:

```js
const CREDENTIAL_NAME = /(?:KEY|PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|SESSION)/i
```

Four extra alternatives were added — `PASSWD`, `CREDENTIAL`, `SESSION`, and the
`(?:…)` grouping — and the commit message does not mention adding any of them;
it claims parity ("The DSH subagent seam scrubs the same classes"). **It does
not scrub the same classes.** Parity would have been the five-term pattern.

### Reproduction — false positives on legitimate names

```
$ node /tmp/C3.mjs
regex: /(?:KEY|PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|SESSION)/i
DROPPED MONKEY
DROPPED KEYBOARD
DROPPED TOKENIZER
kept    SESAME
DROPPED HOTKEY
DROPPED KEYMAP
DROPPED KEYSTONE
DROPPED PASSWD_FILE
DROPPED SESSION_MANAGER
DROPPED DBUS_SESSION_BUS_ADDRESS
DROPPED XDG_SESSION_TYPE
DROPPED GNOME_KEYRING_CONTROL
...
FALSE POSITIVES (legit names dropped): 11
["MONKEY","KEYBOARD","TOKENIZER","HOTKEY","KEYMAP","KEYSTONE","PASSWD_FILE",
 "SESSION_MANAGER","DBUS_SESSION_BUS_ADDRESS","XDG_SESSION_TYPE","GNOME_KEYRING_CONTROL"]
```

The substring match has no word-boundary or suffix anchoring, so `KEY` matches
inside `MONKEY`/`KEYBOARD`, `TOKEN` inside `TOKENIZER`, and `SESSION` inside the
three standard freedesktop session variables.

### Reproduction — with a real desktop environment

```
$ node /tmp/C3c.mjs
Variable                          forwarded?
  DBUS_SESSION_BUS_ADDRESS         NO  <-- silently dropped
  XDG_SESSION_TYPE                 NO  <-- silently dropped
  SESSION_MANAGER                  NO  <-- silently dropped
  GNOME_KEYRING_CONTROL            NO  <-- silently dropped
  MONKEY                           NO  <-- silently dropped
  KEYBOARD                         NO  <-- silently dropped
  TOKENIZER                        NO  <-- silently dropped
  HOME                             YES
  PATH                             YES
```

`DBUS_SESSION_BUS_ADDRESS` is the damaging one: on any Linux desktop it is what
lets a child reach the session bus. `SESSION_MANAGER` is what X11 clients use to
register with the session. A TUI-based agent CLI (Claude Code, Codex, opencode
all ship one) started without them can lose clipboard, keyring-backed
credential lookup, notification, or session-manager integration — and because
the drop is silent, the symptom is an unrelated-looking CLI failure.

### What is *correct*

Two sub-claims from the brief, both tested and **clean**:

1. **Values are never inspected** — only names are matched:

```
$ node /tmp/C3d.mjs
PATH (value has KEY/MONKEY)  : kept -> /opt/MONKEY/bin:/usr/bin
SOME_VALUE (value has KEY/TOKEN): kept
EXPLICIT_KEY via extra        : kept (opt-in works)
```

   So a `PATH` containing `KEY` in a directory name survives, which is the
   right behaviour and the more dangerous failure mode if it had gone wrong.

2. **The explicit `extra` opt-in works** and only `extra` survives the scrub
   (`Object.assign(merged, extra || {})` after the loop, `src/runner.js:44`).

### Why the existing test misses it

`tests/runner.test.js:73-83` asserts only that the four credential names are
absent and that an explicit opt-in survives. It never asserts that **ordinary
variables remain**, so a regex that deletes half the environment still passes.
Verified: 202 tests green with this regression in place.

### Corrected form

Match the seam's exact vocabulary, anchored to a name boundary, and keep
`KEY` last so a specific suffix wins:

```js
// Credential-shaped NAMES only; mirrors dsh-subprocess SENSITIVE_ENV_PATTERN
// plus CREDENTIAL (git credential helpers). No bare SESSION/PASSWD substring.
const CREDENTIAL_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL)(?:$|_)/i
```

and add a regression test that pins the *complement*, not just the exclusions:

```js
test('normalizeEnv keeps ordinary host variables', () => {
  process.env.MONKEY = 'x'; process.env.KEYBOARD = 'us'
  process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/user/1000/bus'
  const e = normalizeEnv({})
  assert.equal(e.MONKEY, 'x')
  assert.equal(e.KEYBOARD, 'us')
  assert.equal(e.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus')
})
```

A cheap alternative that avoids the whole class of bug: copy the official
pattern verbatim (`/KEY|PASSWORD|SECRET|TOKEN/i`) and accept that it too
over-matches `MONKEY`. It is the *shipped*, *tested* upstream heuristic; the
plugin's job is parity, not a stricter invention.

**Severity: medium-high.** No crash, no data loss, but silent environment
mutation on a path that every panel dispatch uses, and the failure surfaces as
an unrelated CLI error.

---

## C4 — `startJob` selective catch (`f6eaf59`)

*(pending)*

## C5 — `recordLedgerEntry` single-flight (`b5693d8`)

*(pending)*

## C6 — `jobHooks` Promise.race cancellation (`15bc8c8`)

*(pending)*

## C7 — `buildDebatePrompt` prefix change (`3837623`)

*(pending)*

---

## Verdict table

*(filled at the end)*
