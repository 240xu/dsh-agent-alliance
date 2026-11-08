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

*(pending)*

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
