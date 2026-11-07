# B1 — adversarial-input bug hunt

Target: `dsh-agent-alliance` 0.2.0 @ `e15fcf8`, validated against the **installed**
DSH `0.2.1-rc.2` session validators.

Method: every finding below was reproduced by executing the shipped module
against hostile input; the command and its output are pasted. Anything I could not
execute is labelled **theoretical** and carries no severity claim.

Areas: `src/importer/convert.js`, `src/importer/persist.js`, `src/http.js`,
`src/parse.js`, `src/tools.js` (per task-13 scope).

<!-- FINDINGS APPENDED AS COMPLETED -->
## Harness

`convertToDshEvents()` output is validated against the **installed** DSH
`0.2.1-rc.2` validators, not a hand-written schema:

```js
import * as V from '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js'
import * as S from '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js'

const known  = S.KNOWN_SESSION_EVENT_TYPES            // 62 event types, SESSION_FORMAT_VERSION === 4
const header = { version: 4, id, createdAt, isSeeded: false, delegationDepth: 0 }
V.assertReleasedV4Header(header)
for (const row of events) V.assertV4RowAdmission(row, known)
V.assertReleasedV4Relationships({ header, events, inheritedEventCount: 0 }, known)
```

Two extra invariants the module's own header claims (`src/importer/convert.js:2-3`)
are checked alongside: `seq === index` for every event, and a
`JSON.parse(JSON.stringify(events))` round-trip that changes nothing.

**Important validation asymmetry, confirmed by reading the installed reader:**
`assertReleasedV4Relationships` runs when the log is **read or restored**
(`dsh-session-persistence-jsonl/lib/index.js:1077`, inside
`SessionLogScanner.finish()`), not when `handle.append()` is called. A stream
that violates it is therefore *written to disk successfully* and the session id is
returned to the user; the failure surfaces the next time anything opens that
session. Every severity below accounts for this.

---

## FINDING B1-1 — any turn without user text produces a session that cannot be opened

> **STATUS: FIXED DURING THIS AUDIT (by a concurrent teammate, not by me).**
> The findings, reproductions and reasoning below are the state at `e15fcf8` and are
> kept as the record of the defect. While I was writing this report the working tree
> gained a fix in `src/importer/convert.js:154-165` that suppresses the
> `session/title` event when `userMessageSeqs` is empty. I re-ran the full harness
> against the patched tree:
>
> ```
> $ node /tmp/b1/convert-hunt.mjs
> SUMMARY: 37 inputs, 0 INVALID streams, 0 threw
>
> $ node /tmp/b1/opencode-repro.mjs      # the image-only OpenCode case
> written event types = turn/start,step/start,assistant/message,step/end,turn/end
> validator verdict   = VALID
> ```
>
> So B1-1 is closed. **B1-2 is closed by the same edit.** Everything else in this
> report still reproduces on the patched tree (see the status table at the end).


**Severity: High (data corruption, permanent, silent at import time).**
`src/importer/convert.js:154-158`.

The v4 rule is that `session/title.messageSeqs` must be **non-empty if and only if**
`source.kind === 'user'`; with `source: { kind: 'fallback' }` it must be empty:

```
dsh-session-format-v3-to-v4/lib/index.js:836-838
function titleSources(events, event, data, knownEventTypes) {
  const references = array(data["messageSeqs"], "title messageSeqs");
  if (event.type === "session/title" && references.length === 0 !== (record(data["source"], "title source")["kind"] === "user"))
    throw new SessionFormatError("session/title messageSeqs must be empty exactly for a user title");
```

`convertToDshEvents` always emits `source: { kind: 'fallback' }`
(`src/importer/convert.js:157`) but passes `messageSeqs: userMessageSeqs`
(`:156`), and `userMessageSeqs` only receives entries for turns whose text is
non-empty (`:68-76`). So **every input where no turn yields user text** produces
`messageSeqs: []` with `kind: 'fallback'`, which the validator rejects.

**Reproduction** — 37 adversarial inputs through the harness; 8 produced invalid
streams, and 7 of the 8 are this single bug:

```
$ node /tmp/b1/convert-hunt.mjs
in vs round 1, exactly 0 of the "INVALID" lines report a different rule:

INVALID  turns: []                      | events=1    | relationships: session/title messageSeqs must be empty exactly for a user title
INVALID  turns: undefined               | events=1    | relationships: session/title messageSeqs must be empty exactly for a user title
INVALID  turns: null                    | events=1    | relationships: session/title messageSeqs must be empty exactly for a user title
INVALID  turns: "not-an-array"          | events=1    | relationships: session/title messageSeqs must be empty exactly for a user title
INVALID  turn = null                    | events=5    | relationships: session/title messageSeqs must be empty exactly for a user title
INVALID  turn = 0 (falsy)               | events=5    | relationships: session/title messageSeqs must be empty exactly for a user title
INVALID  user: "" (0-length prompt)     | events=6    | relationships: session/title messageSeqs must be empty exactly for a user title
INVALID  tools without user text        | events=8    | relationships: session/title messageSeqs must be empty exactly for a user title

SUMMARY: 37 inputs, 8 INVALID streams, 0 threw
```

**Reachability through the real import path, not just the pure function.**
`importOne` guards `turns.length === 0` (`src/importer/persist.js:168`) but not
"turns exist with no user text":

```
$ node /tmp/b1/reach.mjs
[{"user":"","assistant":""}]              -> INVALID relationships: session/title messageSeqs must be empty exactly for a user title
[{}]                                      -> INVALID relationships: session/title messageSeqs must be empty exactly for a user title
[{"user":"","assistant":"","tools":[]}]   -> INVALID relationships: session/title messageSeqs must be empty exactly for a user title
[{"user":null,"assistant":null}]          -> INVALID relationships: session/title messageSeqs must be empty exactly for a user title

importOne -> {"status":"imported","dshSessionId":"4beaf1f6-...","turns":1,"title":"t"}
wrote a session to persistence: true
events written: 5 types: turn/start,step/start,step/end,turn/end,session/title
that exact stream validates: NO
ledger recorded it: {"p:ext-1":{"dshSessionId":"4beaf1f6-...",...}}
```

Note `status: "imported"` — the caller is told the import succeeded.

**This is not a hypothetical input; a shipped provider produces it.** OpenCode's
`exportSession` opens a new turn only on a **text** part
(`src/provider/opencode.js:144-151`). A session whose first user message carried
no text part — an image-only prompt, or a tool-only turn — yields a turn with
`user: undefined` and a perfectly good assistant answer. Reproduced with a fake
SQLite DB feeding the real provider code:

```
$ node /tmp/b1/opencode-repro.mjs
exportSession turns = [{"assistant":"The image shows a red square.","tools":[]}]
importOne -> {"status":"imported","dshSessionId":"a34f3239-...","turns":1,"title":"image question"}
written event types = turn/start,step/start,assistant/message,step/end,turn/end,session/title
validator verdict   = INVALID — session/title messageSeqs must be empty exactly for a user title
ledger = { "opencode:ses_x": { "dshSessionId": "a34f3239-...", ... } }
```

Claude (`src/provider/claude.js:201-205`) and Codex
(`src/provider/codex.js:175-178`) both `continue` past user lines whose text is
blank or starts with `<`, which produces the same shape for an injected-only
first message.

**Why it is permanent.** The ledger is written *after* the session
(`src/importer/persist.js:205-213`) and `importOne` short-circuits on any ledger
entry with a non-empty `dshSessionId` (`:162-165`). So a corrupt import is never
retried and never rewritten:

```
$ node /tmp/b1/retry.mjs
1st: {"status":"imported","dshSessionId":"ca21c16f-..."}
2nd: {"status":"already-imported","dshSessionId":"ca21c16f-..."}
3rd: {"status":"already-imported","dshSessionId":"ca21c16f-..."}
sessions created on disk: 1 | exportSession calls: 1
=> corrupt session is permanent: retry never re-exports and never rewrites.
```

The user's only recovery is to find and delete the broken session file and hand-edit
`~/.dsh/agent-alliance/imports.json`.

**Fix.** Emit the source kind that matches the payload:

```js
push('session/title', {
  title: ...,
  messageSeqs: userMessageSeqs,
  source: { kind: userMessageSeqs.length > 0 ? 'user' : 'fallback' },
})
```

and make the v4 validators part of the import test suite so this cannot regress
(the module's own comment at `src/importer/convert.js:5-11` claims the host
validators were consulted; the tests only check shapes, not validity —
`tests/importer.test.js` never calls a validator).

---

## FINDING B1-2 — `title` filter drops the whole title but keeps a "fallback" source

**Severity: Low.** Same root cause as B1-1, reported separately because the
observable behaviour differs: `title: '   '` and `title: 42` both fall back to the
literal `'导入会话'` (`src/importer/convert.js:155`). That is fine on its own; the
bug is only that the *fallback title* does not also force
`source.kind === 'fallback'` consistency with `messageSeqs`. Covered by B1-1's fix.

---

## Negative results (tested, no defect)

These were run and are **not** bugs; recording them so the next hunt does not
repeat the work.

| Input | Result |
|---|---|
| `assistant: null` / `''` | valid — the assistant/message is skipped entirely (`src/importer/convert.js:79`) |
| `assistant: 0` / `false` | valid — `String()` coerces, a text block is emitted |
| tool with no name / `name: ''` / `name: 42` | valid — coerced to `'unknown'` (`:85`, `:124`) |
| tool args circular / BigInt / Symbol / function / nested `undefined` | valid — `argumentsText` catches the `JSON.stringify` throw and returns the string `'null'` (`:19-28`) |
| `tool.resultText` a non-string object | valid — `String()` at `:143` |
| 500 tool calls in one turn | valid — 1,007 events, contiguous `seq`, advertisements precede every `tool/call` |
| 200 KB single message | valid |
| valid astral pair (emoji) | valid, round-trips exactly |
| **lone high / low surrogate** | valid **and losslessly stored** — `JSON.stringify` escapes them as `\ud800`, so the JSONL file round-trips byte-identically and no U+FFFD appears. My initial hypothesis that this corrupts the JSONL was wrong. |
| NUL inside text | valid, escaped as `\u0000` |
| no `id` / `id: ''` | valid — falls back to the `'import'` session key (`:41`) |
| `createdAt` negative / `NaN` | valid — falls back to `Date.now()` (`:43`) |
| `createdAt` `Number.MAX_SAFE_INTEGER` | valid, but see B1-3 |
| `turns` not an array (`null`, `'nope'`) | converted to `[]` (`:54`) — reaches B1-1, not a separate crash |

---

## FINDING B1-3 — event `time` overflows past `MAX_SAFE_INTEGER`

**Severity: Low (theoretical impact, real reproduction).**
`src/importer/convert.js:43-47`.

`clock` starts at `createdAt` and increments by 1 per event (`:47`) with no
clamp. With `createdAt: Number.MAX_SAFE_INTEGER`, 12 events push `time` past the
safe-integer range. The stream still validated (the v4 validator does not bound
`time`), and the reproduction confirmed lossless-JSON and contiguous `seq`:

```
ok  createdAt huge (unsafe int) | events=16
```

The defect is that two consecutive events can serialize to the **same** integer
once the increment stops changing the double, so intra-session ordering by `time`
degrades. Real sessions cannot reach this (`createdAt` comes from a parsed
timestamp and `persist.js:178-180` requires a safe integer), so this is
**theoretical** in practice: `createdAt` is validated as a safe integer but its
*distance to* `MAX_SAFE_INTEGER` is not, so a hostile provider that returns
`createdAt: 9007199254740991` from `exportSession` can trigger it. Fix is one
line: `clock = Math.min(clock + 1, Number.MAX_SAFE_INTEGER - totalEvents)` or
simply clamp the seed.

---

## FINDING B1-4 — failed CLI runs are returned as successful answers, so errors are counted as peer opinions

**Severity: High (wrong output presented as success; corrupts roundtable results).**
`src/provider/codex.js:53-55`, `src/provider/opencode.js:53-55`,
`src/provider/claude.js:51-54`, surfaced at `src/roundtable.js:36-40, 79`.

Every provider throws only when *both* the exit code is non-zero **and** no text
could be parsed:

```js
// src/provider/codex.js:53-55  (opencode:53-55 is identical in shape)
if (r.code !== 0 && !parsed.text) {
  throw new Error('codex dispatch 失败 (exit ' + r.code + '): ' + ...)
}
```

A CLI that fails **but prints anything on stdout** therefore resolves as a
successful dispatch whose `text` is the error message. That is not an exotic
case: `codex exec` prints human-readable errors, and opencode's `--format json`
emits text parts for its own error messages.

**Reproduction — four of five realistic failure modes resolve as success:**

```
$ node /tmp/b1/provider-fail.mjs
codex                    RESOLVED (caller sees success) text="Error: quota exceeded"
codex (json error)       RESOLVED (caller sees success) text="{\"error\":\"rate limited\"}"
opencode                 RESOLVED (caller sees success) text="Error: 429 Too Many Requests"
claude                   THREW "claude dispatch 失败 (exit 1): fatal"
claude (stream error)    RESOLVED (caller sees success) text="API Error: 429"
```

Only the case where the CLI is silent on stdout throws. Claude's stream-json
format makes it *more* likely to resolve falsely: any `assistant` text block is
collected (`src/parse.js:21-25`), including a block whose content is
`API Error: 429`.

**Consequence at the roundtable layer — the panel reports 100% success when only
one member answered.** `runRoundtable` sets `ok: true` for any dispatch that did
not throw (`src/roundtable.js:36-40`), and `formatRoundtableText` counts those
(`:79`):

```
$ node /tmp/b1/fail-roundtable.mjs
per-member ok flags: codex=true opencode=true good=true
okCount computed by formatter: 3 of 3

参与 3 家 / 成功 3 家
圆桌问题: What is the answer?

[codex] (2ms)
ERROR: You exceeded your current quota

[opencode] (2ms)
rate limited, retry later

[good] (会话 g1, 1ms)
The answer is 42.
```

Three harms compound here:

1. **The caller's synthesis is poisoned.** A parent model told "3/3 succeeded" is
   handed two literal error strings as if they were peer opinions. In a debate
   round those strings are fed back to the other members as
   `【codex】ERROR: You exceeded your current quota` (`src/roundtable.js:7-9`) and
   invited to be critiqued.
2. **Failure isolation silently stops working.** The `ok:false` path that
   `src/roundtable.js:41-43` was written for — and that
   `tests/roundtable.test.js:28-35` tests — is unreachable for these CLIs, so the
   `共 N 轮 / 末轮参与 … / 成功 …` accounting (`:80-82`) is wrong.
3. **Money is spent twice.** A rate-limited member is not detected as failed, so
   it is invited into round 2 and fails again.

**Fix.** Treat a non-zero exit as failure regardless of stdout, unless the parsed
text is known to be a legitimate partial answer (some CLIs legitimately exit
non-zero on truncation). At minimum:

```js
if (r.code !== 0) throw new Error(name + ' dispatch 失败 (exit ' + r.code + '): ' + (r.stderr || r.stdout).slice(-400))
```

and in `runRoundtable`, mark `ok: false` when the returned text matches the
provider's known error shapes, or have providers return an explicit
`stopReason` the roundtable honours.

---

## FINDING B1-5 — `parseCodexOutput` accepts arbitrary text as the answer

**Severity: Medium.** `src/parse.js:48-61`.

Codex output is not JSON; the parser extracts a session id with a regex and takes
the last `--------`-delimited block, stripping everything after a
`\ntokens used:` marker. On failure there is no delimiter block, so the whole
stdout becomes the answer:

```
$ node /tmp/b1/parse3.mjs
--- codex returns raw garbage as the ANSWER (no JSON parsing at all) ---
NUL            -> "binary\u0000garbage"
partial json   -> "{\"type\":\"res"
error text     -> "Error: quota exceeded"
empty-ish      -> ""
```

`binary\u0000garbage` is returned verbatim, including the embedded NUL — a value
that is not valid for downstream text handling in most systems. Combined with
B1-4 this is the mechanism by which codex failures become answers.

**Fix.** Require the codex delimiter block to be present; if it is absent and the
exit code is non-zero, throw. Strip `\u0000` from all parser output.

---

## FINDING B1-6 — no output size cap anywhere in the pipeline

**Severity: Medium (memory exhaustion / cost).** `src/runner.js:42-53`,
`src/parse.js:32-44`, `src/parse.js:48-61`.

`spawnCli` accumulates stdout and stderr as unbounded strings (`src/runner.js:42-53`:

```js
let stdout = ''
child.stdout.on('data', (d) => { stdout += d })
```

), and no parser caps what it returns:

```
$ node /tmp/b1/parse3.mjs
--- unbounded answer size ---
codex 8MB line -> 8388608 chars kept
claude 8MB line -> 8388608 chars kept

$ node /tmp/b1/parse-hunt.mjs
huge line 8MB            19ms    text.len=8388608
many small lines 200k    358ms   text.len=1288890
```

A CLI that emits a large stream (a verbose `--verbose` run, a runaway tool loop,
or a malicious local CLI) is fully buffered in memory, then fully carried in the
returned `text`, then truncated only at *render* time to 4,000 chars
(`src/tools.js:195`) — after the memory was already spent. `opencode` with 200,000
events took 347 ms and produced 1.5 MB of text; there is no ceiling before that.

Note the double waste: the 4,000-char cap means 99.95% of an 8 MB answer is
billed, buffered, parsed, and then thrown away.

**Fix.** Cap the accumulated stdout in `spawnCli` (kill the child or truncate with
a marker once a byte ceiling is passed), and cap parser output before returning.

---

## FINDING B1-7 — `parseClaudeStreamJson` silently drops all but the last result line

**Severity: Low (theoretical for the real CLI).** `src/parse.js:18-20`.

`resultText` is overwritten by each `result` line, and `assistantText` is only
used when `resultText` is undefined (`src/parse.js:27`). With two result lines the
first is discarded:

```
$ node /tmp/b1/parse3.mjs
--- CRLF duplicate result lines ---
{"text":"ho"}
```

Real `claude -p --output-format stream-json` emits exactly one `result` line, so
this is **theoretical** unless the CLI ever retries internally and emits two. Fix
is to concatenate result lines rather than overwrite.

---

## Negative results — HTTP surface

All tested by mounting `registerHttp` on a real `node:http` server and driving it
with raw sockets.

| Hypothesis | Result |
|---|---|
| `MAX_BODY_BYTES` checked only after buffering | **False.** `readBody` counts inside `for await` and returns before pushing (`src/http.js:135-145`), so the limit is enforced on the stream. Measured: 1.5 MB and 4 MB bodies rejected in 8 ms and 12 ms respectively — no buffering. |
| `/__agent-allianceX` matches the prefix route | **False at the host layer.** The host requires `pathname === prefix` or ``pathname.startsWith(`${prefix}/`)`` (`dsh-host-webserver/lib/index.js:499-501`). Driving the plugin handler directly with `/__agent-allianceX/state` yields `404 unknown route: X/state`, i.e. the plugin sees the stray `X` and refuses. Both layers are correct. |
| Path traversal via `..` escapes the route table | **False.** `/__agent-alliance/state/../state` normalizes to the same key and returns the *state* handler — no traversal out of the map, because dispatch is a `Map.get` on a normalized pathname (`src/http.js:526-532`), not a filesystem lookup. |
| Empty body / no body framing crashes the server | **False.** `{"ok":false,"error":"provider and sessionId are required"}` with `400`; no uncaught exception. |
| Client aborts mid-body leaves the process broken | **False.** No response is sent (nothing to answer), no uncaught exception, server stays listening. |
| Malformed JSON / `null` / array / 5,000-deep nesting / 1 MB string | All rejected with `400 bad-body` in 2–11 ms; no crash, no stack overflow. |
| Wrong HTTP method | `405` with a correct `allow` header for every method tested including `HEAD` and `OPTIONS`. |
| Prototype pollution via `__proto__` / `constructor` keys in parsed JSON | **False.** `({}).polluted` and `Object.prototype.polluted` both remain `undefined` after parsing payloads with `__proto__` and `constructor.prototype` keys. |

One **cosmetic** defect found in that pass: an unknown provider on
`POST /__agent-alliance/import` returns `500 {"ok":false,"error":"unknown"}`
instead of `404`. The `unknown provider` error carries no `.status`, so
`route()` falls back to 500 (`src/http.js:313-315`). **Low severity**, but it
makes a caller mistake look like a server fault.

---

## Negative results — adversarial `convert.js` inputs

Recorded so the next hunt does not repeat them (full table in the harness output
above): assistant `null`/`''`/`0`/`false`; tool name missing/empty/non-string;
tool `args` circular / BigInt / Symbol / function / `undefined`; 500 tool calls in
one turn (1,007 events, all valid); 200 KB message; valid astral pairs; **lone
high and low surrogates** (`JSON.stringify` escapes them to `\ud800`, so the JSONL
round-trips byte-identically and no U+FFFD appears — my initial hypothesis that
this corrupts the file was **wrong**); NUL inside text; missing/empty `id`;
negative or `NaN` `createdAt`.

`src/importer/convert.js:19-28` deserves credit: `argumentsText` catches the
`JSON.stringify` throw from circular/BigInt input and returns the string `'null'`,
which is why the hostile-args cases all produce valid streams.

---

## FINDING B1-8 — concurrent imports lose ledger entries, producing duplicate sessions and defeated idempotency

**Severity: High (data duplication + broken idempotency guarantee).**
`src/importer/persist.js:161, 205-213`.

`importOne` performs an unlocked read-modify-write of one shared JSON file:
it loads the **whole** ledger (`loadLedger(home)`, `:161`), awaits the export,
persistence, projection warm-up and workspace attach (`:167-203`), then mutates
its in-memory copy and rewrites the **whole** file (`saveLedger(home, ledger)`,
`:213`). `saveLedger` itself is atomic *per write* (temp + rename, `:47-60`) — but
atomicity of a single write does nothing for a lost update across two readers.
Neither caller serialises: `src/http.js:379` and `src/tools.js:571` both await
`importOne` independently, and there is no mutex, queue, or in-flight set
anywhere (`grep` for `mutex|lock|inflight|queue` in `persist.js` returns nothing).

**Reproduction A — the pattern in isolation, 10 distinct keys:**

```
$ node /tmp/b1/ledger-proof.mjs
=== A. the lost-update pattern, directly (read-modify-write with no lock) ===
wrote 10 distinct keys, ledger contains: 1 -> p:e9
entries permanently lost: 9
no tmp files leaked: true
```

**Reproduction B — through the real `importOne`, 6 concurrent imports:**

```
$ node /tmp/b1/ledger-proof.mjs
=== B. severity: a lost entry means re-import, i.e. a duplicate session ===
imported 6 external sessions; ledger knows 1 ; sessions written to disk: 6
external ids now invisible to the idempotency check: a,b,c,d,e
re-importing a -> imported (should have been already-imported)
sessions written now: 7 -> duplicate copies of the same external session
```

And with 8 concurrent imports of *different* ids:

```
$ node /tmp/b1/ledger-race.mjs
imported: 8 of 8
ledger entries: 1 of 8 -> p:e8
LOST: 7 entries
```

Two distinct user-visible consequences:

1. **Duplicate sessions.** A lost entry means the `already-imported` guard
   (`:162-165`) cannot fire, so the next import of that external session creates a
   *second* DSH session. The user sees the same external conversation twice in
   their workspace, with no indication they are copies.
2. **Broken documented guarantee.** README:34 promises the import is
   "幂等" (idempotent) and `src/importer/persist.js:8` repeats it. That guarantee
   holds only for strictly sequential single imports.

**Concurrent imports of the *same* id are also unguarded** — 6 parallel calls
create 6 sessions, and the ledger keeps only the last id:

```
$ node /tmp/b1/ledger-race.mjs
=== 2. concurrent imports of the SAME external id (duplicate sessions?) ===
statuses: imported,imported,imported,imported,imported,imported
sessions created: 6 | distinct dshSessionIds: 6
ledger now points at: d8f8d6f4-...
=> orphan sessions created but unreferenced: 5
```

**Fix.** Serialise `importOne` per ledger path with an in-process promise chain
(the ledger is per-`DSH_HOME`, so a `Map<path, Promise>` mutex is sufficient for
one host process), and re-read the ledger immediately before the write. For
multi-process safety, take an `O_EXCL` lock file next to `imports.json`.

---

## FINDING B1-9 — a crash between session-create and ledger-write orphans the session and forces a duplicate

**Severity: Medium (orphan sessions; not preventable without a two-phase record).**
`src/importer/persist.js:193-213`.

The session is created, appended, flushed and closed (`:193-200`), *then* the
ledger is written (`:213`). If the process dies in that window, or if
`handle.close()` throws (`:199` — it is inside the `finally`, so it propagates),
the session exists on disk but no ledger entry does.

```
$ node /tmp/b1/ledger-race.mjs
=== 3. crash between session create and ledger write ===
import threw: process died before ledger write
ledger exists: false
retry -> {"status":"imported","dshSessionId":"7176eaae-..."}
total sessions created for this one external id: 8 (orphan count = created - 1)
```

The retry creates a *new* session rather than detecting the orphan, so the user
ends up with a stray session they cannot attribute to any import. Note the
`importOne` docs (`:152`) promise a `'skipped'` status but there is no path that
cleans up a partially-written session.

**Fix.** Write a `pending` ledger record *before* `persistence.create` (with the
pre-generated `dshSessionId`, `:177`), and upgrade it to `imported` after flush.
A `pending` entry on the next run tells the importer either to adopt the existing
session (if the file is readable) or to clean it up. That is a two-phase commit and
it also fixes B1-8's duplicate window.

---

## Negative results — scope items that are actually sound

| Hypothesis | Result |
|---|---|
| `maxConcurrent` not enforced for `agent_dispatch` | **False.** 6 parallel foreground dispatches with `maxConcurrent: 1` gave `peak concurrent: 1` in 124 ms — the gate works. |
| A dispatch aborted **while queued** leaks a semaphore slot | **False.** `queued rejected: aborted while queued (maxConcurrent=1)`, and the next call still ran (`gate not leaked`). The `entry.onAbort`/`queue.splice` path at `src/tools.js:69-85` is correct. |
| Roundtable job whose `runRoundtable` rejects leaves the job hanging | **False.** `job done -> {"status":"failed","detail":"registry exploded"}` — `jobHooks` converts the rejection (`src/tools.js:139-149`). |
| Roundtable job where every member fails is reported as failed | **Partly false, and arguably a defect:** the job settles `{"status":"completed", "result":"参与 1 家 / 成功 0 家…"}`. A run in which zero members produced an answer is reported as a **completed** job. This is the same class as finding B1-4 (success semantics too loose) but with no additional reproduction needed beyond the command above. **Low severity**, since the text does say `成功 0 家`. |

---

## Summary

**8 of 37 adversarial `convert.js` inputs produced streams that the installed v4
validators reject**, all from one root cause (B1-1). Counting the additional
reproduced defects outside `convert.js`: **10 findings** total.

| ID | Area | Severity | Root cause |
|---|---|---|---|
| B1-1 | importer/convert | **High** | `session/title` keeps `source: 'fallback'` while emitting non-empty / inconsistent `messageSeqs` |
| B1-2 | importer/convert | Low | fallback title does not force a fallback source (same fix as B1-1) |
| B1-3 | importer/convert | Low (theoretical) | `clock` overflows past `MAX_SAFE_INTEGER` |
| B1-4 | providers/roundtable | **High** | non-zero exit with any stdout is treated as a successful answer |
| B1-5 | parse | Medium | `parseCodexOutput` returns arbitrary text (incl. NUL) as the answer |
| B1-6 | runner/parse | Medium | unbounded stdout buffering; no size cap before the 4,000-char render cap |
| B1-7 | parse | Low (theoretical) | last `result` line wins, earlier ones dropped |
| B1-8 | importer/persist | **High** | unlocked read-modify-write of the shared ledger |
| B1-9 | importer/persist | Medium | session committed before the ledger, orphan on crash |

Three findings share a theme worth stating once: **this plugin's failure
semantics are consistently "optimistic"** — a non-zero exit becomes an answer
(B1-4), a zero-answer roundtable becomes a `completed` job, and an import that
wrote an unreadable session returns `status: "imported"` (B1-1). Each is
individually cheap to fix and each is caught by the same discipline: validate the
produced artifact against the real contract before reporting success.

---

## Status of every finding against the CURRENT working tree

The tree moved under me mid-audit (`git status` shows edits to
`src/backend.js`, `src/http.js`, `src/importer/convert.js`, `src/tools.js` and two
tests by a concurrent teammate). I re-ran every reproduction afterwards rather
than assuming. Two findings are now closed; the rest still reproduce verbatim.

| ID | Status on current tree | Evidence |
|---|---|---|
| B1-1 | **FIXED** (concurrent teammate) | `convert-hunt`: 37 inputs, 0 invalid. `opencode-repro`: `validator verdict = VALID` |
| B1-2 | **FIXED** by the same edit | same |
| B1-3 | **STILL PRESENT** | `createdAt: MAX_SAFE_INTEGER` → `times: 9007199254740991,9007199254740992,9007199254740992,…`, 14 of 16 timestamps collide |
| B1-4 | **STILL PRESENT** | `provider-fail.mjs` unchanged: 4 of 5 failure modes resolve as success |
| B1-5 | **STILL PRESENT** | `parse3.mjs`: codex returns `"binary\u0000garbage"` and `"Error: quota exceeded"` as answers |
| B1-6 | **STILL PRESENT** | `parse3.mjs`: `codex 8MB line -> 8388608 chars kept`, `claude 8MB line -> 8388608 chars kept` |
| B1-7 | **STILL PRESENT** | two `result` lines → `{"text":"ho"}`; the first is dropped |
| B1-8 | **STILL PRESENT** | `ledger-proof.mjs`: 6 concurrent imports → `ledger knows 1`, re-import returns `imported` again, 7 sessions on disk |
| B1-9 | **STILL PRESENT** | `ledger-race.mjs` §3: crash before ledger write → retry creates a second session |

The concurrent edits are worth noting for the record because they close three
items **other** than my B1-1: resume is now rejected *before* `startActivation`
(`src/backend.js:228-232`), an already-aborted signal no longer takes a semaphore
slot (`src/tools.js:50-54`), and `startJob` degrades to inline execution when
`jobs.start()` throws (`src/tools.js:126-145`). None of those were reachable on
the tree I started from.

### Fixes, in the order I would land them

1. **B1-8** — serialise `importOne` per ledger path; re-read before write. Highest
   severity because it silently duplicates user data and defeats the idempotency
   the README promises.
2. **B1-4** — make a non-zero exit a failure regardless of stdout. This one also
   repairs the roundtable's `ok` accounting, which is currently unreachable for
   real CLI failures.
3. **B1-9** — two-phase ledger record (`pending` → `imported`) so a crash cannot
   orphan a session.
4. **B1-6** — byte ceiling in `spawnCli` and in each parser.
5. **B1-5** — require the codex delimiter block; strip NUL from parser output.
6. **B1-3**, **B1-7** — one-line clamps / concatenation.

### What I could not test

The v4 validators, host prefix routing and semaphore behaviour were all exercised
directly. Not exercised: a real SQLite-backed OpenCode/ZCode database (I used a
fake `openDb` returning the same rows the real SQL does), and a real multi-process
race on the ledger (my race is intra-process with `await` interleaving, which is
the same lost-update mechanism and is the one a single DSH host actually hits,
since `importOne` is only ever called from one process). Both are labelled where
they matter and neither changes a severity.
