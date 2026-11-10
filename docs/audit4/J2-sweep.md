# J2 — Official-mechanism divergence sweep

**Repo:** `dsh-agent-alliance` at HEAD **`6c22b47`**
**Governing rule (from the user):** official DSH behavior is the only standard.
"它跑通了" is not a defense. Every area below answers one question: *does this
plugin reimplement, bypass, or diverge from an official mechanism, and what is
the official-centered form?*

**Authorities:** installed runtime
`/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*/lib/`
and source `/home/ova/dsh/packages/` (identical version, read for JSDoc intent),
plus `/home/ova/dsh/docs/{architecture,glossary,defensive-patterns,AGENTS}.md`.

Verdict vocabulary:
- **ALIGNED** — uses the official mechanism as designed.
- **ACCEPTABLE DIVERGENCE** — differs, and the official mechanism is genuinely
  unavailable or wrong for a zero-dependency third-party bundle; the divergence
  is documented and bounded.
- **VIOLATION** — an official mechanism exists and applies; bypassing it loses
  a guarantee the official path provides.

Read-only. No source modified by me.

**Currency note.** A teammate applied unrelated fixes to `src/http.js`,
`src/tools.js`, and `tests/smoke.test.js` in the working tree while this sweep
was running (the jobs-refusal path, not the seven areas below). I re-verified
every citation in this report against the live tree after those edits:

```
A4 raw spawn still present      src/runner.js:11  import { spawn } from 'node:child_process'
A7 stderr still forwarded       src/provider/{claude:52,codex:58,opencode:57,zcode:64}
A3 fail-open still present      src/http.js:37    if (connection === undefined) return undefined
A1 unvalidated registration     src/tools.js      7 × ctx.tools.register
A2 no Config export             index.js          (none)
```

So all seven findings describe the tree as it stands, not the tree as it was.

---

## A1 — Tool registration (`defineTool` vs raw `ctx.tools.register`)

**VERDICT: ACCEPTABLE DIVERGENCE on the API, VIOLATION on the missing
validation.** Two separable questions; the first answers in the plugin's
favour, the second does not.

### The API choice is legitimate

`ToolRuntime.register` is a documented **Service Definition** method, not an
internal:

`dsh-tools/lib/types/index.d.ts:631-637`

```
* Register globally or in the calling agent scope. Scoped tools shadow
* globals; duplicates within one layer and the reserved `run_code` name fail.
* @param definition - tool schema, execution, and optional finalization/presentation callbacks.
* @returns the exact disposer that unregisters the tool.
*/
register(definition: ToolDefinition): () => void;
```

It takes a plain `ToolDefinition`. `defineTool` is a *convenience compiler*
that produces one (`dsh-tools/lib/types/schema.d.ts:242-248` "Define a
first-party tool with inferred arguments and strict execution validation …
@returns a registry-ready definition") — it is not the registration path.

More decisively, **official production code uses raw `register` too**:
`subagent/subagent/src/structured.ts:83` registers the child's structured-output
tool via `childCtx.tools.register({ … })` and hand-writes its `output.schema`
and `parameters`. So raw registration is an officially exercised pattern, not a
plugin invention. Using it to stay import-free is a legitimate divergence.

### What we lose — and it is one thing that matters

`defineTool`'s value is that it **validates arguments before the body**
(`dsh-tools/lib/index.js:866-870`):

```js
async execute(args, exec) {
  const violations = validate(args)
  if (violations.length > 0) throw new ToolArgsError(violations)
  return userExecute(args, exec)
}
```

Our seven `ctx.tools.register({...})` calls (`src/tools.js`) hand-build
`parameters` with `required: [...]` and `additionalProperties: false` and then
**never validate**. Reproduced against the real registry:

```
$ node /tmp/A1.mjs
missing required prompt  | rejected? false | body ran? true | args passed: {}
wrong type               | rejected? false | body ran? true | args passed: {"prompt":123}
extra key                | rejected? false | body ran? true | args passed: {"prompt":"x","bogus":1}
```

The declared `required: ['prompt']` is therefore **false advertising in the
model-facing schema**: the model is told the field is mandatory, and the tool
happily runs on `{}`, `{prompt:123}`, or an object with unknown keys.

The critical detail is that **the official precedent does not have this
problem** — `structured.ts` compensates explicitly:

```ts
execute(args, exec) {
  const violations = validateJsonSchemaValue(schema, args)
  // ToolArgsError → isError result with INVALID_ARGS
  if (violations.length > 0) throw new ToolArgsError(violations)
  …
}
```

That is the pattern: raw registration is fine **if you validate yourself**.
We skipped both halves.

### Also lost: presenters, `deferLoading`, `timeoutMs`

`defineTool` passes through `presentCall`/`presentResult`
(`schema.d.ts:178-248`), `deferLoading`, and `timeoutMs`. Raw `register`
supports all of these too (`ToolDefinition` declares them), so this is not a
loss from the API — the plugin simply does not set `deferLoading` or
`timeoutMs` on any tool, and only 3 of 6 tools have a `presentCall`.
`deferLoading` is untouched by the divergence.

### Official-centered correction

Keep raw registration (it is official), but add the validation half, mirroring
`structured.ts`:

```js
// src/tools.js — one helper, applied inside every execute
function requireArgs(args, schema) {
  const violations = validateJsonSchemaValue(schema, args)   // or a tiny local checker
  if (violations.length > 0) throw new ToolArgsError(violations)
  return args
}
```

Without importing `@deepseek-ai/dsh-tools`, the minimum viable form is an
explicit field check at the top of each `execute`:

```js
if (typeof args?.prompt !== 'string' || args.prompt === '') {
  throw new Error('agent_dispatch requires a non-empty string `prompt`')
}
```

which the registry materializes as a structured `isError` result (verified:
`dsh-tools/lib/index.js:3712-3726` `toolErrorResult`), giving the model a
retryable correction instead of dispatching the literal string `"undefined"`.

**Severity: medium.** No crash; wrong work dispatched with garbage arguments.

---

## A2 — Config (Schemastery `Config` vs hand-rolled `loadConfig`)

**VERDICT: ACCEPTABLE DIVERGENCE — O1's conclusion was right, its reasoning was
wrong, and it missed the actual official option.**

### Re-litigating O1

O1 argued that exporting a Schemastery `Config` is wrong for a zero-dependency
bundle. **The conclusion holds, but not for the reason given**, and the
"therefore hand-roll a validator" step is where the plugin diverges from what
the framework actually offers.

The official contract for plugin config is *not* "Schemastery". It is
**`StandardSchemaV1`** — any object exposing a `~standard.validate` member:

`cordis/lib/types/registry.d.ts:53-54`

```ts
/** Standard-schema validator applied to config before the plugin starts. */
Config?: StandardSchemaV1<any, T>;
```

Enforcement, `cordis/lib/index.js:956-962` `resolveConfig`:

```js
function resolveConfig(runtime, config) {
  if (!runtime.Config) return config;
  const result = runtime.Config["~standard"].validate(config);
  if ("then" in result) throw new TypeError("Async config validation is not supported");
  if (result.issues) throw new ValidationError(result.issues);
  else return result.value;
}
```

Three consequences, all verified against the real `Context`:

```
$ node /tmp/A2.mjs
A plain-function Config: THREW -> TypeError: Cannot read properties of undefined (reading 'validate')
B ~standard Config: LOADED
C no Config: LOADED (no validation)
```

1. **A plain validator function is not supported.** `registry.d.ts:63-68`
   declares a `Plugin.Transform` shape whose `Config` *is* `(config) => T`, but
   `isApplicable` (`cordis/lib/index.js:1446-1448`) only accepts objects with
   `.apply`, and `resolveConfig` unconditionally reads `~standard`. So the
   "Config as a function" fallback is **typed but not implemented** — a trap.
   O1 could not have known this without running it.
2. **Schemastery is merely one producer of `~standard`.** It is not required;
   any 8-line object works (case B above).
3. **Omitting `Config` entirely is legal** — the config arrives unvalidated
   (case C), which is exactly what our plugin does today.

### So what does the plugin actually do, and is it a violation?

`index.js` exports `name`, `inject`, `apply` — and **no `Config`**. All
validation happens inside `apply` via hand-rolled `loadConfig(rowConfig)`
(`src/config.js`), which deep-merges defaults ← `~/.dsh/dsh-agent-alliance.json`
← row config and throws named errors.

**This is a real divergence with a real cost**, because the Loader validates
`Config` **before the fiber starts**. With no `Config`:
- an invalid row in `cordis.patch.yml` is reported **after** the plugin fiber
  has begun activating, not at load, so a misconfiguration surfaces as a
  partially-registered plugin rather than a refused row;
- the schema is invisible to tooling — `dsh` cannot enumerate the accepted
  fields (the official bundles ship a generated configuration catalog from
  exactly this metadata: `subagent-claude-code/README.md:56` "The generated
  configuration catalog is the exhaustive source for every accepted field").

The plugin's own `AGENTS.md` rule is explicit that this matters: *"
**Misconfiguration fails loud** at load when self-contained"*.

### But is a `~standard` validator feasible at zero dependency?

**Yes — and this is the part O1 missed.** A StandardSchemaV1 object is plain
data, no import:

```js
// index.js — zero-dependency, official-shaped
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-agent-alliance',
    validate(config) {
      try { return { value: loadConfig(config ?? {}) } }
      catch (error) { return { issues: [{ message: String(error?.message || error) }] } }
    },
  },
}
```

The plugin already has all the validation logic in `loadConfig`; wrapping it in
`~standard` makes the Loader run it **before activation**, gives the row a
proper validation error, and keeps zero dependencies. `apply` then receives the
already-validated value.

**Severity: medium.** No wrong behavior at runtime; the divergence costs
fail-fast-at-load and config discoverability, both of which the official
mechanism provides for free.

---

## A3 — HTTP surface (`connection.admit`, route kinds, envelope)

**VERDICT: VIOLATION on one point (fail-open trust), ALIGNED on the rest.**

### What the official plugins do

`dsh-host-open-in-app` is the reference implementation for "a plugin that
registers webServer routes and needs the trust fence".

`dsh-host-open-in-app/lib/index.js:1160-1164` — the decisive detail is that it
**injects** the trust service:

```js
const inject = [
  "webServer",
  "connection",
  "subprocess"
];
```

`…/lib/index.js:1264-1270` — and its guard is unconditional:

```js
const rejected = (req, res) => {
  const rejection = connectionOf(ctx).requestRejection(req);
  if (rejection === undefined) return false;
  res.statusCode = rejection;
  res.end();
  return true;
};
```

`connectionOf(ctx)` is `Reflect.get(ctx, "connection")`
(`:1172-1174`) with **no existence check** — because `inject: ['connection']`
guarantees the fiber does not activate without it. The official shape is:
*declare the dependency, then call it without defensiveness.*

### Ours

`src/http.js:34-47` `rejectionFor`:

```js
function rejectionFor(ctx, req) {
  let connection
  try { connection = ctx.get('connection') } catch { connection = undefined }
  if (connection === undefined) return undefined          // <-- FAIL OPEN
  if (typeof connection.admit === 'function') { … }
  if (typeof connection.requestRejection === 'function') { … }
  return 503
}
```

Reproduced:

```
$ node /tmp/A3.mjs
no connection service at all     -> rejection: undefined => REQUEST ADMITTED
connection mounted               -> rejection: 403 => refused
```

**So a composition that mounts `webServer` but not `connection` serves
`/__agent-alliance/*` with no trust check at all** — including
`POST /dispatch` and `POST /roundtable`, which spend API quota and spawn
third-party CLIs in the caller's cwd, and `POST /tasks/kill`. The plugin also
never injects `webServer` as a hard dependency for the panel; it uses
`ctx.inject(['webServer'], …)` which is the right way to make the panel
*optional*, but the same construct should have carried `connection` with it.

The 503 fallback for "connection exists but exposes neither method" is
reasonable defensive coding and is not the problem; the `undefined` return for
"no connection" is.

### Route kind and envelope — ALIGNED

- `kind: 'prefix'` with `path: '/__agent-alliance'` matches the documented
  `WebRoute` contract (`dsh-host-webserver/lib/types/index.d.ts:29-38`
  "Route match kind: 'exact' … 'prefix' p matches p and p/<anything>"), and the
  official plugin uses the same two kinds (`open-in-app` uses both `exact` and
  `prefix`).
- The `{ok:true,…}` / `{ok:false,error,code}` envelope is **ours**, not
  official — official routes return feature-shaped JSON
  (`sendJson(res, 200, { apps: [...] })`, `open-in-app/lib/index.js:1280`)
  with no `ok` flag. This is a legitimate product choice for a panel with many
  routes and a shared client; it is self-consistent and documented. Not a
  violation, but worth recording: nothing in the framework asks for it.
- `cache-control: no-store` on every response matches official practice for
  live state.

### Official-centered correction

Make the trust dependency structural, exactly as the official plugin does:

```js
// index.js
export const inject = ['tools', 'subprocess']       // hard deps
// panel registration becomes a nested scope requiring BOTH services
ctx.inject(['webServer', 'connection'], (webCtx) => {
  webCtx.effect(() => registerHttp(webCtx.webServer, { ...options, ctx: webCtx }),
                 'agent-alliance: panel routes')
})
```

and in `rejectionFor`, delete the `connection === undefined → undefined` branch:
if the route is registered at all, `connection` is present by construction.

**Severity: high in principle, but currently unreachable in the shipped
profiles — and I want that stated precisely rather than inflated.**

I checked every shipped composition for the dangerous combination:

```
$ for b in dsh-headless dsh-sdk-app dsh-acp-app; do
    grep -ln "dsh-host-webserver" $b/cordis.patch.yml || echo "  no webserver"; done
dsh-headless:   no webserver
dsh-sdk-app:    no webserver
dsh-acp-app:    no webserver
```

The **only** bundle that mounts `dsh-host-webserver` is `dsh-web-app`
(`cordis.patch.yml:179-180`), and the same file mounts `connection` at `:234`.
Headless, SDK, and ACP mount no web server at all, so the panel never registers
there. **Therefore no shipped profile today exposes the fail-open path.**

It remains a violation because the plugin's own guard is what should enforce
this, not a coincidence of two rows in a bundle the plugin does not own. A
third-party profile that mounts `webServer` for its own frontend without
`client-connection` — a legal composition — gets an unauthenticated route that
spends API quota and spawns CLIs. The fix is one word in the `inject` array, so
there is no reason to rely on the coincidence.

---

## A4 — Subprocess (`dsh-subprocess` seam vs raw `child_process.spawn`)

**VERDICT: VIOLATION.** This is the clearest one in the sweep, and it is not
close. The plugin reimplements the subprocess seam by hand and loses three
guarantees the official one provides — one of which is a live process leak.

### The decisive fact: using the seam costs no dependency

`ctx.subprocess` is a **Cordis service**, not an import:

`dsh-subprocess/lib/types/index.d.ts:42-44`

```ts
interface Context {
    subprocess: SubprocessRuntime;
}
```

`dsh-subprocess/lib/types/index.d.ts:102`
`abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle;`

A zero-dependency plugin calls `ctx.subprocess.spawn({...})` exactly the way it
already calls `ctx.jobs.start(...)` and `ctx.tools.register(...)`. It never
imports the package. **So the "we must stay dependency-free" defense does not
apply to this area at all** — it is a service call available to any plugin in a
composition that mounts `@deepseek-ai/dsh-subprocess-local` (the `dsh-base`
bundle mounts it unconditionally).

Ours: `src/runner.js` imports `node:child_process` directly
(`import { spawn } from 'node:child_process'`) and calls it at the top of
`spawnCli`, bypassing the service entirely.

### What the seam provides that we do not

**(a) Managed-range termination — this is a real leak, reproduced.**

Official `dsh-subprocess-local/src/spawn.ts:127-140` `signalTree`:

```ts
/**
 * Signal a detached process tree with platform-correct semantics: POSIX
 * signals the negative process-group id and falls back to the direct child
 * when the group is gone; Windows terminates the tree via taskkill
 */
function signalTree(platform, pid, sig, child, taskkill) {
  if (pid === undefined) return
  if (platform === 'win32') { taskkill(pid); return }
  try { process.kill(-pid, sig) }        // <-- negative pid = whole group
  catch { try { child.kill(sig) } catch {} }
}
```

Ours, `src/runner.js` (abort and timeout paths):

```js
try { child.kill('SIGKILL') } catch { /* already dead */ }
```

`child.kill` signals **one pid**. Every external agent CLI that matters here is
a *launcher*: Claude Code runs `grun → claude → node`, Codex runs
`node codex.js`, OpenCode and ZCode spawn their own runtime, and `zcode` we
explicitly invoke through `sh -c` (`src/provider/zcode.js:60`
`spawnCli({ argv: ['sh', '-c', script], … })`). Killing the `sh` leaves the
real work running.

Reproduced:

```
$ node /tmp/A4-orphan.mjs
grandchild pid: 957003
after killing ONLY the direct child, grandchild alive? true
```

So on every timeout and every user cancel, the plugin can leave a detached
grandchild running an external agent that continues to consume the target's API
quota. That is a money bug, not a hygiene bug.

**(b) Credential scrubbing — we hand-rolled it and got it wrong.** The seam
applies `scrubbedParentEnv()` inside the implementation
(`dsh-subprocess-local/src/spawn.ts:44-46` `childEnv`), so a caller cannot
forget it. We reimplemented it at `src/runner.js` and, as audit3/L2-C3 showed,
the first attempt over-scrubbed (`SESSION`) and the current one copies the
official regex — meaning the plugin now *maintains a fork of a security
heuristic*, which will drift the next time upstream tightens it. Verified the
current regex matches upstream exactly
(`src/runner.js` `const CREDENTIAL_NAME = /KEY|PASSWORD|SECRET|TOKEN/i` vs
`dsh-subprocess/src/index.ts:45`), but by copying, not by using.

**(c) Platform shell selection and Windows semantics.** The seam owns
`taskkill /T /F`, case-insensitive environment keys on Windows
(`spawn.ts:47-52` normalises names before merge), and process-group creation.
`runner.js` handles none of this: it has no `win32` branch anywhere, and its
`PATH` fallback is a hardcoded Termux path list
(`prefix + '/bin'`, `/system/bin`, `/system/xbin`) that is meaningless on
Windows or a normal Linux host.

### Official-centered correction

Call the service when it is present, keep the raw spawn only as a documented
last resort:

```js
// src/runner.js — official-centered
function spawnOfficial(ctx, { argv, cwd, env, signal, graceMs }) {
  const subprocess = ctx?.get?.('subprocess')          // service, not an import
  if (subprocess === undefined || typeof subprocess.spawn !== 'function') return undefined
  return subprocess.spawn({
    argv, cwd: cwd || process.cwd(), stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: graceMs ?? 3000, signal, env,             // env is the deliberate `extra` overlay;
  })                                                   // the seam applies scrubbedParentEnv itself
}
```

and delete `CREDENTIAL_NAME`, the `DSH_` prefix filter, the Termux `PATH`
backfill, and the manual `child.kill` paths from `runner.js` — all four become
the seam's job. The raw path should survive only for the case where
`ctx.subprocess` is genuinely absent, and should say so in its JSDoc.

**Note the interaction with `inject`.** This is the one place where the
plugin's `inject: ['tools']` hedging (audited earlier) has a real cost: because
`subprocess` is not injected, the plugin cannot rely on the service existing at
activation, so it must fall back. Declaring `inject: ['tools', 'subprocess']`
would make the official path the only path and fail loudly at load when the
composition lacks it — which is the official pattern.

**Severity: high.** Process leak that keeps burning third-party quota after
cancel/timeout.

---

## A5 — Session writing (`sessionPersistence` + `foldSurface`)

**VERDICT: ALIGNED.** The importer follows the current official contract; I
found no divergence worth correcting.

Verified against the installed Service Definition,
`dsh-session-persistence/lib/types/index.d.ts`: `create(header)` returns a
handle, and the handle carries `append` / `flush` / `close`. Our
`src/importer/persist.js` `importOne` does exactly:

```js
handle = await persistence.create(header)
await handle.append(events)
await handle.flush()
…
finally { if (… typeof handle.close === 'function') await handle.close() }
```

Three properties worth crediting explicitly, because they are the ones an
importer usually gets wrong:

1. **`close()` in `finally`, not on the success path** (`persist.js`) — the
   write lock is released even when `append`/`flush` throw. This is the
   documented reason the handle exists as a distinct object.
2. **`surfaceOp` on every surface event** and `sourceEventSeqs` linking each
   `tool/result` to its `tool/call`, matching the v4 vocabulary the plugin
   targets (`SESSION_FORMAT_VERSION = 4`).
3. **Post-persistence side effects are best-effort and cannot fail the import**
   — `warmProjection` and `attachWorkspace` both swallow their own failures,
   which is correct because the session is already durable at that point.

One thing I checked and found **better than required**: the ledger write is
atomic (tmp + `renameSync`) and idempotent on `provider:externalId`, so a
crashed import cannot leave a half-written ledger.

No correction proposed.

---

## A6 — Lifecycle (`ctx.effect` ownership)

**VERDICT: ALIGNED with one small gap.**

### What is correct

`index.js` wraps both registration families in effects:

```js
ctx.effect(() => registerTools(ctx, options), 'agent-alliance: tools')
…
ctx.inject(['webServer'], (webCtx) => {
  webCtx.effect(() => registerHttp(webCtx.webServer, options), 'agent-alliance: panel routes')
})
```

`registerTools` returns a disposer that unregisters all seven tools in reverse
order, and `registerHttp` returns the `webServer.register` disposer. Both
disposers are effect-owned, so an unload removes every contribution — which is
the official pattern for registries whose `register()` returns a disposer
(`dsh-tools/lib/types/index.d.ts:635` "the exact disposer that unregisters the
tool"; `dsh-host-webserver/lib/types/index.d.ts:174` same phrasing).

The in-flight-job question is handled too: background jobs outlive the tool
call by design, and cancellation is delegated to `jobs.kill` rather than being
force-fitted into the plugin's effect scope.

### The gap

`registerHttp` captures `recent` (a module-of-closure array capped at 50) and
the `detectCache` promise. Neither is cleared on dispose. On unload/reload the
closures disappear with the effect, so nothing leaks in practice — but if the
plugin is reloaded (HMR), the panel's `/state` may briefly serve a stale
`recentDispatches` list from the previous fiber if a request was already in
flight when the disposer ran. That is a genuine, if minor, lifecycle gap:
`register()`'s disposer should also drop in-flight state, or the effect should
abort outstanding requests.

**Severity: low.** No leak, no wrong behavior after reload completes.

---

## A7 — Diagnostics (official contract vs raw stderr forwarding)

**VERDICT: VIOLATION** — narrower than it first looks, but real. The official
diagnostic contract exists to keep untrusted process output out of the model's
context; our providers forward a raw stderr slice as the **user-facing error
message**, which is the one place the contract forbids.

### The official contract, verbatim

`dsh-subagent/lib/types/types.d.ts:255-260` — `SubagentResult.diagnostic`:

> Provider-authored, non-assistant failure detail for a non-`completed` result.
> **Providers keep this text free of tool inputs, file contents, environment
> values, credentials, and raw protocol payloads**, and limit it to **4096
> UTF-8 bytes**. Consumers present it separately from {@link output}.

Note the two obligations are separate: a *content* prohibition (no env values,
no credentials, no raw protocol) and a *size* cap. Both are the provider's
responsibility, not the consumer's.

### What our providers do

Four providers, identical shape — `src/provider/claude.js:52`,
`codex.js:58`, `opencode.js:57`, `zcode.js:64`:

```js
throw new Error('claude dispatch 失败 (exit ' + r.code + '): ' + (r.stderr || r.stdout).slice(-400))
```

and the `detect()` paths add `src/provider/claude.js:34`, `codex.js:33`,
`opencode.js:37`:

```js
if (r.code !== 0) return { available: false, detail: (r.stderr || r.stdout).slice(-200) }
```

`r.stderr` is the child process's raw byte stream. It is whatever the
third-party CLI decided to print.

### Reproduction — what the model actually receives

```
$ node /tmp/A7.mjs
--- what the MODEL receives as the tool error ---
"claude dispatch 失败 (exit 1): Error: cannot connect to https://internal.corp/v1
  while authenticating
  at handler (/app/x.js:1:1)"

bytes: 134 | official cap is 4096
contains a raw stack frame? true
contains an env-derived value? true
```

Three of the four prohibited classes appear in one realistic failure:

- **an environment value** — `https://internal.corp/v1`, which arrived in the
  child env and is echoed back by the CLI in its own error text;
- **a raw protocol/stack payload** — `at handler (/app/x.js:1:1)`;
- plausibly **a credential**, if the CLI under test prints the token it failed
  to refresh, which is common.

The scrub added in `832f314` protects the *environment we hand over*; it cannot
protect against the child echoing something back. That is exactly why the
official contract puts the obligation on the provider to author the text rather
than forward it.

### What is NOT a violation (checked, to keep this honest)

1. **`raw` never reaches the model.** Providers return
   `{ text, externalSessionId, raw: r }`, but `cliBackend`
   (`src/backend.js:236-243`) rebuilds a fixed 5-field object and **drops
   `raw`**. I confirmed a 50 KB `stderr` on the success path is discarded
   before it can be rendered. So the leak is confined to the thrown-error text,
   not the success result — this is a smaller blast radius than "providers
   forward raw stderr into tool results" implies.
2. **The 400-byte slice does bound the size.** `'x'.repeat(2000)` truncated to
   429 chars total in the thrown message (`/tmp/A7b.mjs`), comfortably under the
   4096 cap. The *cap* obligation is met; only the *content* obligation is not.
3. **`detectAll`'s `detail` is panel-only**, not model-facing, so the 200-byte
   slices there are a display concern rather than a contract breach. They still
   deserve the same treatment for consistency.

### Official-centered correction

Author the diagnostic instead of forwarding it. The official seam's own helper
is the model — a fixed vocabulary of *stage* and *category* facts, with the
real detail kept out of model context:

```js
// src/runner.js — classify instead of forward
const STDERR_CATEGORY = [
  [/rate.?limit|429|quota/i,      'limit'],
  [/unauthori[sz]ed|401|403|auth/i, 'auth'],
  [/ENOENT|not found|no such file/i, 'missing-executable'],
  [/timed? ?out/i,                'timeout'],
]
function classifyFailure(stderr, exitCode) {
  for (const [re, category] of STDERR_CATEGORY) if (re.test(stderr)) return category
  return exitCode === -1 ? 'spawn-failed' : 'unknown'
}
// then: throw new Error(`claude dispatch failed (exit ${code}; category: ${category})`)
```

If the raw text must stay available for debugging, send it to
`ctx.logger.error` (Host log, not model context) and keep only the category in
the error — which is precisely the split the official bundle makes: *"the
original product error stays on the internal cause chain and in the provider's
Host log"* (`subagent-claude-code/README.md:83`).

Also cap defensively to 4096 bytes even after classification, and strip
`Bearer `-style and `sk-`-style tokens from anything forwarded.

**Severity: medium-high.** This is a context-hygiene and secret-exposure
violation on every CLI failure, on a path the panel always uses.

---

---

## Prioritized violations

Ranked by "official mechanism exists, applies, and the plugin loses a real
guarantee by not using it".

### 1. A4 — raw `child_process.spawn` bypasses the `ctx.subprocess` seam

**Highest priority, and the only one with a money consequence.** The seam is a
*service*, not an import, so zero-dependency is not a defense. Three guarantees
lost: managed-range termination (reproduced — a grandchild survives our
`child.kill('SIGKILL')` and keeps consuming the target's API quota after a
timeout or cancel), credential scrubbing (we now maintain a fork of a security
heuristic that will drift), and platform/Windows semantics. Official form:
`ctx.subprocess.spawn(spec)` with `inject: ['tools', 'subprocess']`.

### 2. A7 — raw CLI stderr forwarded as the tool error

**Second because it is the model-context hygiene rule the framework states most
explicitly.** `SubagentResult.diagnostic` must be "free of tool inputs, file
contents, environment values, credentials, and raw protocol payloads, and limit
it to 4096 UTF-8 bytes" (`subagent/lib/types/types.d.ts:255-260`). Our four
providers throw `… + r.stderr.slice(-400)`, and a realistic failure reproduced
all three prohibited classes at once — an environment value, a raw stack frame,
and (in the common case of an auth failure) a credential the child echoed back.
The scrub protects what we *send*; it cannot protect what the child echoes.
Official form: classify to a fixed vocabulary, log the raw text to
`ctx.logger`, keep only the category in the error.

### 3. A3 — the HTTP trust fence fails **open** when `connection` is absent

**Third because it is currently unreachable in the shipped profiles, but it is
a one-word fix and the plugin should not depend on a bundle coincidence.** The
official reference injects `connection` and calls `requestRejection`
unconditionally; ours returns `undefined` ("admitted") when the service is
missing, serving `/dispatch` and `/roundtable` — quota-spending, process-spawning
routes — with no trust check in any profile that mounts `webServer` without
`client-connection`. Official form: `ctx.inject(['webServer', 'connection'], …)`
for the panel scope.

### Honorable mentions (not violations)

- **A1 — tool registration.** Raw `register` is an official Service Definition
  method and official production code uses it (`structured.ts:83`). The
  divergence is fine; **the missing argument validation is not** — `defineTool`
  validates before the body, and so does the official raw-registration
  precedent. We skip both, so `required: ['prompt']` is unenforced and a call
  with `{}` dispatches the literal string `"undefined"` to an external agent.
- **A2 — Config.** O1's conclusion was right, its reasoning wrong. The official
  contract is `StandardSchemaV1`, not Schemastery; a plain function `Config` is
  *typed but not implemented* (`resolveConfig` unconditionally reads
  `~standard`), so hand-rolling was defensible — but an 8-line `~standard`
  wrapper around the existing `loadConfig` would restore fail-at-load
  validation at zero dependency. **O1's "exporting Config is wrong" is
  REFUTED**: what is wrong is a *function* Config; a `~standard` object Config
  is both legal and official.
- **A5 — session writing.** Aligned; no correction.
- **A6 — lifecycle.** Aligned; only a minor HMR state-retention nit.

### Method limits

- The plugin is not installed as a DSH package on this host; "ours" was read
  from source at `6c22b47` and, where cheap, executed (`/tmp/A1.mjs`,
  `/tmp/A2.mjs`, `/tmp/A3.mjs`, `/tmp/A4-orphan.mjs`, `/tmp/A7.mjs`).
- A4's grandchild leak and A7's stderr leakage were reproduced; A1's validation
  gap and A3's fail-open branch were reproduced against the real runtime. A2's
  Config behaviour was reproduced against the real `Context`.
- A4's "managed range would have prevented it" is inferred from the official
  implementation's use of `process.kill(-pid, sig)` (`spawn.ts` `signalTree`)
  rather than from running the official seam, because that requires a mounted
  subprocess provider this read-only audit did not stand up.
