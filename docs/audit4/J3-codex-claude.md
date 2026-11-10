# J3 — Codex / Claude Code bundles as the behavioral standard

User rule: **开发绝对以官方为唯一准则** — the official experimental Codex and Claude Code subagent bundles are the
behavioral standard, and this plugin's related behavior must align to them.

This report turns that sentence into an executable checklist with source evidence, and — equally important —
identifies where copying the official behavior would be a **category error** because an external CLI is not an
in-harness child.

Repo: `dsh-agent-alliance` @ `6c22b47`. READ-ONLY audit.

**Status: complete.** Six sections; every official claim quoted from source, every divergence reproduced.

## Answers up front

**(a) Top 3 MUST-CHANGE**

1. **M1 [S] — `DSH_` env prefix scrubbed case-sensitively.** `src/runner.js:50` uses
   `name.startsWith('DSH_')`; official is `key.toUpperCase().startsWith(DSH_ENV_PREFIX)`
   (`subprocess/subprocess/src/index.ts:69`). Proven: a lowercase `dsh_*` ambient variable survives our scrub and
   would be removed by the official one. Fix: `name.toUpperCase().startsWith('DSH_')`.
2. **M2 [M] — failure diagnostics forward raw CLI stderr/stdout.** Four sites
   (`src/provider/{claude,codex,opencode,zcode}.js:52/58/57/64`) throw
   `'…失败 (exit N): ' + (r.stderr || r.stdout).slice(-400)`. Official builds the message from fixed fields only
   (`subagent-codex/src/run.ts:86-105`) and hides the cause (`:122-127`), under the seam contract at
   `subagent/src/types.ts:280-285` ("free of tool inputs, file contents, environment values, credentials, and raw
   protocol payloads"). Fix: new `src/diagnostic.js` + the seven official categories
   (`subagent-codex/src/wire.ts:19-30`), raw text retained on `Error.cause` only.
3. **M3 [S] — forwarded provider `diagnostic` is uncapped.** `src/backend.js:209` attaches it verbatim; official
   enforces `MAX_SUBAGENT_DIAGNOSTIC_BYTES = 4_096` with UTF-8-boundary truncation
   (`subagent/src/out-of-process.ts:19,30-41`).

**(b) The category error (copying official here would be WRONG)** — **one-shot / no-resume**
(`subagent-codex/README.md:95`). The official provider cannot resume because it creates an *ephemeral*
non-persisted thread; there is nothing to resume. Our external CLIs own durable session stores
(`~/.claude/projects/*.jsonl` — `src/provider/claude.js:5`; `~/.codex/sessions/*.jsonl` — `src/provider/codex.js:5`),
which is why `resumeSessionId`, `agent_sessions`, `agent_session_read` and the importer exist at all. Imposing
one-shot to "align" would delete working capability in exchange for conformance with a transport limitation we do
not share. Same shape for `delivery: 'parent'`, provider-minted child ids, `disposeGraceMs`, and a `permissionMode`
pass-through: refuse all of them.

## Method limits (must be stated up front)

- **Neither bundle is installed on this host.** `@deepseek-ai/dsh-subagent-codex` and
  `@deepseek-ai/dsh-subagent-claude-code` are absent from the installed `node_modules`; the plugin manager reports
  both as `availability: "missing"`. Every quote below therefore comes from the **source checkout**
  (`/home/ova/dsh/packages/subagent/`), not from executing the bundles.
- The checkout is `0.2.1-alpha.2` while the installed runtime is `0.2.1-rc.2`. Where the seam differs between the
  two, the installed copy is authoritative for what actually runs, and the difference is called out.
- No bundle was executed, so no behavioral claim below is based on observed runtime output — only on source.

## Sections

1. The official behavioral contract (quoted)
2. Map to our external-CLI path: transferable vs category error
3. Config parity
4. Diagnostic parity
5. Permission-mode parity
6. Final alignment checklist

_(appended below)_

---

## 1. THE OFFICIAL BEHAVIORAL CONTRACT

Nine rules, each quoted from the official source. These are the standard; §2 maps our plugin against them.

### C1 — One fresh process/thread/turn per run; no resume

`subagent-codex/README.md:95` (Design concept):

> "**One fresh process, thread, and turn per run.** Every run spawns a fresh app-server, creates one ephemeral
> thread, and executes exactly one turn; there is no continuation, resume, or pooling."

`subagent-claude-code/README.md` (Known Limitations):

> "**One fresh query and process per run** — there is no continuation, resume, pooling, progress stream, or
> product-session persistence."

### C2 — Credential-scrubbed ambient env, explicit overlay after the scrub

`subagent-codex/README.md:54`:

> "Credential-shaped ambient variables are removed before the explicit `env` overlay, so an API key intended for
> the child must be supplied there."

The mechanism is the shared subprocess seam, `subprocess/subprocess/src/index.ts:47`:

```ts
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i
```

`subprocess/subprocess/src/index.ts:69`:

```ts
if (value !== undefined && !SENSITIVE_ENV_PATTERN.test(key) && !key.toUpperCase().startsWith(DSH_ENV_PREFIX)) env[key] = value
```

Note the **case-insensitive** `DSH_` check — it is `key.toUpperCase().startsWith(...)`, not `key.startsWith(...)`.

### C3 — `permissionMode` is a fixed bundle-row setting, never a per-call parameter

`subagent-codex/README.md:44`:

> "| `permissionMode` | `never` | Native non-interactive approval and sandbox mode fixed for every thread from this
> provider instance |"

The word "fixed" is load-bearing: it is set once on the provider instance and cannot be varied per delegation.
`subagent-claude-code/README.md:45` gives the same shape with default `dontAsk`.

### C4 — SAFE diagnostics: no tool inputs, no file contents, no env values, no credentials, no raw protocol; ≤ 4096 bytes

`subagent/subagent/src/types.ts:279-285` — the seam-level obligation:

```
* Provider-authored, non-assistant failure detail for a non-`completed`
* result. Providers keep this text free of tool inputs, file contents,
* environment values, credentials, and raw protocol payloads, and limit it
* to 4096 UTF-8 bytes. Consumers present it separately from {@link output}.
```

Enforced in `subagent/subagent/src/out-of-process.ts:19` (`MAX_SUBAGENT_DIAGNOSTIC_BYTES = 4_096`) and `:30-41`
(`limitSubagentDiagnostic` truncates on a UTF-8 boundary with `'\n[diagnostic truncated]'`).

The official bundles satisfy this by constructing the diagnostic **from fixed fields only** —
`subagent-codex/src/run.ts:86-105`:

```ts
function failureDiagnostic(facts: CodexFailureFacts): string {
  const fields = [
    'product: Codex',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  if (facts.httpStatus !== undefined) fields.push(`HTTP status: ${facts.httpStatus}`)
  const processFields = [['exit code', facts.outcome?.exitCode], ['signal', facts.outcome?.signal]] as const
  for (const [label, value] of processFields) {
    if (value !== null && value !== undefined) fields.push(`${label}: ${value}`)
  }
  return `Product subagent failure (${fields.join('; ')})`
}
```

Crucially, `codexStartupFailure` hides the real cause behind fixed facts (`run.ts:118-127`):

```ts
export function codexStartupFailure(cause: unknown): Error {
  return new CodexRunFailure({ stage: 'initialize', category: 'unknown' }, cause)
}
```

The cause is retained internally; only the fixed facts reach the model. The README makes the consequence explicit
(`subagent-codex/README.md:81`): "Raw wrapper text stays on Host stderr."

### C5 — Coarse failure taxonomy (7 categories)

`subagent-codex/src/wire.ts:19-30`:

```ts
export interface CodexWireFailureFacts {
  readonly stage: 'turn-start' | 'turn'
  readonly category:
    | 'limit' | 'access-policy' | 'service' | 'transport'
    | 'product-error' | 'invalid-result' | 'unknown'
  readonly httpStatus?: number | undefined
}
```

`run.ts:71-77` extends the stage vocabulary for the provider's own boundaries:
`'initialize' | 'thread-start' | <wire stages> | 'process' | 'teardown'`.

### C6 — Child id is provider-minted, unique, and addresses exactly one activation

`subagent/subagent/src/types.ts:297` (`SubagentRun.id`):

> "Provider-minted id, unique across all parents, providers, and local Sessions in this runtime."

`types.ts:39` (`SubagentActivation`):

> "A managed execution; disposal addresses this exact activation, never a later resume."

External backends allocate their own ids — `types.ts:33`: "Optional reserved identity for a local child; external
backends allocate their own ids."

### C7 — Disposal exactly once, idempotent

`subagent/subagent/src/types.ts:301-304`:

> "Cancel remaining work, reach child quiescence, and release resources.  Idempotent."

and `types.ts:46-49`:

> "Execution result after teardown settles and notifications are sent; capture failures reject. Teardown failures
> are reported by dispose() without replacing a captured result."

### C8 — `delivery: 'parent'` is what notifies the model; the official tool uses it

`subagent/subagent/src/types.ts:36-37`:

> "Parent delivery notifies the model; caller delivery only returns the result. Local children always enter the
> parent catalog."

`subagent/tool-subagent/src/index.ts:475-481` passes `delivery: 'parent'`.

### C9 — Structured error codes on the seam

`subagent/subagent/src/error.ts` in full:

```ts
/** Typed failure for the subagent seam. */
export class SubagentError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SubagentError'
  }
}
```

Correction to a common misreading (mine included): the `code` parameter is a plain `string`, **not** a union type.
The discipline is conventional, not compiler-enforced. The codes actually thrown across the seam are
`ACTIVATION_CLOSING`, `ACTIVATION_LIMIT_REACHED`, `CONTINUATION_UNAVAILABLE`, `DUPLICATE_PROVIDER`, `INPUT_CLOSED`,
`NO_PROVIDER`, `NOT_CONTINUABLE`, `UNAUTHORIZED`, `UNSUPPORTED_CAPABILITY` (enumerated by grep over `subagent/src`).
The transferable rule is **"a stable machine-readable code accompanies the message"**, not "a typed union exists".

---

## 2. MAP TO OUR PLUGIN — transferable vs category error

The honest framing first: **an external CLI is not an in-harness child.** It owns its own process, its own
session store, its own account and authentication. Rules that constrain *how the harness schedules and reports a
child* transfer; rules that constrain *how a child's execution is materialised inside the harness* do not.

| # | Official rule | Our external-CLI path | Transferable? | Verdict |
|---|---|---|---|---|
| C1 | one-shot, fresh per run, no resume | `resumeSessionId` continues an **external** session (`src/tools.js:344`, `src/backend.js:190`) | **No — category error** | **NOT a gap.** The official rule exists because *the official provider* creates an ephemeral thread it must not pretend to resume. Our CLIs have their own durable session stores (`~/.claude/projects/*.jsonl`, `~/.codex/sessions/*.jsonl` — `src/provider/claude.js:5`, `codex.js:5`). Resuming them is a **feature the official path structurally cannot offer**, not a deviation. Removing it to "align" would delete real capability. |
| C2 | credential-scrubbed env, explicit overlay after | `src/runner.js:33` `const CREDENTIAL_NAME = /KEY\|PASSWORD\|SECRET\|TOKEN/i`; scrubbed in `normalizeEnv` (`:47-53`); explicit `extra` layered after (`:53`) | **Yes** | **ALIGNED, with one divergence.** See §2.1. |
| C3 | `permissionMode` fixed on the bundle row | we set no approval/sandbox flag at all; we pass `--skip-git-repo-check` (codex) and let claude use native settings | **Partly** | **ALIGNED by omission.** We never override native policy, which is the same *posture* as "native configuration is authoritative" (`subagent-codex/README.md:96`). See §5. |
| C4 | SAFE diagnostics, ≤4096B, no raw stderr | we throw `'…失败 (exit N): ' + (r.stderr \|\| r.stdout).slice(-400)` | **Yes** | **MUST CHANGE.** See §4. This is the single largest violation. |
| C5 | coarse category taxonomy | free-text messages only | **Yes** | **MUST CHANGE (with C4).** |
| C6 | provider-minted child id, exact-activation disposal | CLI path reports `parsed.sessionId` — the *product's* id, not ours (`src/provider/claude.js:62`) | **Partly — and deliberately different** | **ALIGNED in spirit, divergent in meaning.** Our id is the product's session id because that is what `resumeSessionId` must accept. Renaming it to a DSH-minted id would break resume. The *subagent* backend path already reports a DSH-minted `activation.childId` (`src/backend.js`, `externalSessionId: activation.childId`). |
| C7 | dispose exactly once, idempotent | subagent path disposes in `finally` (`src/backend.js:263-271`); CLI path kills via signal (`src/runner.js:96-99`) | **Yes** | **ALIGNED.** Verified in the earlier audit round. |
| C8 | `delivery: 'parent'` for the official tool | we use `'caller'` (`src/backend.js:241`) and return the text inline | **No — deliberate** | **ALIGNED for our tool, N/A for parity.** A tool that returns the answer inline must not also inject a completion notice. Copying `'parent'` would duplicate output and add a catalog row for a run the model already has. |
| C9 | stable machine-readable error code beside the message | plain `Error` with message strings; one place attaches `error.diagnostic` / `error.stopReason` (`src/backend.js`) | **Yes** | **MUST CHANGE (low).** See §4.3. |

### 2.1 The one real env divergence (C2)

Our pattern matches the host's exactly, and the explicit-layering order is correct. Verified by execution:

```
$ node -e "... normalizeEnv({EXPLICIT_KEY:'allowed'})"
MY_API_KEY     -> (scrubbed)
MY_PASSWORD    -> (scrubbed)
DSH_TOKEN      -> (scrubbed)
SAFE_VAR       -> ok
EXPLICIT_KEY   -> allowed (explicit env survives)
```

The divergence is the `DSH_` prefix test. Official (`subprocess/subprocess/src/index.ts:69`):

```ts
!key.toUpperCase().startsWith(DSH_ENV_PREFIX)
```

Ours (`src/runner.js:50`):

```js
if (name.startsWith('DSH_')) continue
```

`startsWith` on the raw name is case-**sensitive**. Proven leak:

```
lowercase dsh_lowercase_fact survives ours   -> leak?
official would scrub it (toUpperCase().startsWith) true
```

So a lowercase `dsh_*` variable reaches a third-party CLI from our path but would be scrubbed on the official
path. The official code comments explain exactly why this matters: "Windows environment names are
case-insensitive, so a parent `dsh_*` entry would otherwise survive and read back as `$env:DSH_*` in the child"
(`subprocess/subprocess/src/index.ts:57-60`). **MUST CHANGE, S effort** — one `.toUpperCase()`.

### 2.2 Why C1 is the clearest category error

The task asks for one example where copying official behavior would be **wrong**. C1 is it, and the reasoning is
structural rather than stylistic:

- The official provider creates an **ephemeral, non-persisted** product session on every run. It cannot resume
  because there is nothing to resume — `subagent-codex/README.md:95` "no continuation, resume, or pooling".
- Our external CLIs **own durable session stores**. `src/provider/claude.js:5` documents
  `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`; `src/provider/codex.js:5` documents
  `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. The plugin's `agent_sessions` / `agent_session_read` tools
  (`src/tools.js:513,540`) exist precisely because those stores are browsable.
- Therefore "one-shot only" is not a *behavioral standard* to be imitated; it is a **limitation of the official
  transport** that the external-CLI path does not share.

Deleting `resumeSessionId` to match the official bundles would remove a capability the user actually has, in
exchange for conformance with a constraint that does not apply. That is the shape of every category error in this
report: **imitate the contract, not the transport's limits.**

---

## 3. CONFIG PARITY — two vocabularies, and whether that matters

### 3.1 What each side exposes

**Official** (`subagent-codex/README.md:40-46`, declared as Schemastery in `subagent-codex/src/index.ts`):

| Field | Default |
|---|---|
| `providerName` | `codex` |
| `model` | native Codex settings |
| `env` | `{}` |
| `permissionMode` | `never` (claude: `dontAsk`) |
| `disposeGraceMs` | `3000` |

**Ours** (`src/config.js:25-33`):

```js
providers: {
  claude:   { enabled: true },
  codex:    { enabled: true },
  opencode: { enabled: true },
  zcode:    { enabled: false, commandTemplate: '', resumeTemplate: '' },
},
defaults: { timeoutMs: 300000, maxConcurrent: 3, defaultCwd: '' },
```

### 3.2 Should we mirror the official field names?

**No — and the reason is that the fields are not the same thing.** This is a place where the surface similarity is
misleading:

| Official field | What it controls | Our nearest equivalent | Why mirroring would be wrong |
|---|---|---|---|
| `providerName` | registry name on `ctx.subagents` | `providers.<id>` key | We have no registry entry. Adopting `providerName` would imply a registration that does not exist. |
| `model` | fixed for every thread from that provider instance | per-call `model` arg (`src/tools.js:336`) | Official is **instance-fixed**; ours is **per-call**. Same word, opposite scoping. |
| `env` | explicit overlay after the credential scrub | `normalizeEnv(extra)` — same semantics, no config field | Ours is correct but not user-configurable; see below. |
| `permissionMode` | fixed approval/sandbox for every run | **nothing** | See §5 — deliberate. |
| `disposeGraceMs` | termination-tier grace for the managed range | `timeoutMs` | Different concept: theirs is teardown grace, ours is run budget. |

Mirroring the names would create **false concordance**: a user who sets `permissionMode: 'never'` in our config and
sees no effect, because we do not own the approval channel at all, is worse off than a user who reads two clearly
different tables.

**What *is* worth borrowing** is the official `env` field's *shape*, because we already implement the semantics and
simply do not expose it. `src/runner.js:39-53` builds a scrubbed env and layers `extra` after the scrub, but no
config key reaches `extra`. Effort **S**: add `providers.<id>.env` and pass it through, documented as "layered
after the credential scrub, exactly like the official bundles' `env`". That is genuine alignment — same semantics,
same name — without pretending `permissionMode` transfers.

### 3.3 Verdict

- **Do not** rename our fields to match. **Do** add `providers.<id>.env` (S) because the semantics genuinely match.
- The two-vocabulary concern is real but is answered better by documentation than by renaming: our README should
  state that `model` is per-call while the bundle's is per-instance, so a user does not expect the same behaviour.

---

## 4. DIAGNOSTIC PARITY — the largest actual violation

### 4.1 What the official side produces

`subagent-codex/src/run.ts:86-105` builds the message from **fixed fields only** (quoted in full in §1/C4), and the
startup path deliberately discards the cause (`run.ts:122-127`):

```ts
export function codexStartupFailure(cause: unknown): Error {
  return new CodexRunFailure({ stage: 'initialize', category: 'unknown' }, cause)
}
```

The cause is kept as `Error.cause` for Host logs; the model sees
`Product subagent failure (product: Codex; stage: initialize; category: unknown)`.

The seam then enforces the invariant **regardless of provider discipline** — `out-of-process.ts:19,30-41` truncates
at 4096 bytes on a UTF-8 boundary. The README states where raw text goes
(`subagent-codex/README.md:81`): "Raw wrapper text stays on Host stderr."

### 4.2 What we produce

Four call sites, all constructed identically:

```js
// src/provider/claude.js:52
throw new Error('claude dispatch 失败 (exit ' + r.code + '): ' + (r.stderr || r.stdout).slice(-400))
// src/provider/codex.js:58
throw new Error('codex dispatch 失败 (exit ' + r.code + '): ' + (r.stderr || r.stdout).slice(-400))
// src/provider/opencode.js:57
throw new Error('opencode dispatch 失败 (exit ' + r.code + '): ' + (r.stderr || r.stdout).slice(-400))
// src/provider/zcode.js:64
throw new Error('zcode dispatch 失败 (exit ' + r.code + '): ' + (r.stderr || r.stdout).slice(-400))
```

and `src/runner.js:104-108` for spawn failures. The `.slice(-400)` caps **length** but does nothing about **content**.

### 4.3 Why this is worse for us than for the official bundles

Three compounding reasons:

1. **These CLIs print their own diagnostics to the same streams we slice.** The code comments already record this:
   `src/provider/codex.js:53-55` — "these CLIs write their own error messages to stdout ('quota exceeded', '429 Too
   Many Requests')". A CLI error page can contain the request body, a URL with an embedded token, or the full
   prompt.
2. **A CLI's environment is the harness's environment** (minus credentials, per §2.1). Anything the CLI echoes —
   a config dump, a `--verbose` banner — is content we did not author.
3. **Our error reaches the model as a tool result verbatim.** `stopFailure` (`src/backend.js:201-212`) forwards a
   provider-authored `diagnostic` string unchanged; the CLI path throws a message that the tool runtime renders.
   There is no seam-side 4096-byte cap on our path because we are not the seam's consumer — we call the provider
   directly or not at all.

### 4.4 Recommended official-centered form

Mirror the official *construction rule*, not its exact field set — our facts differ.

```js
// src/diagnostic.js (new, shared by all four providers)
/** Coarse categories, mirroring subagent-codex/src/wire.ts:19-30. */
const CATEGORY = /** @type {const} */ ([
  'limit', 'access-policy', 'service', 'transport',
  'product-error', 'invalid-result', 'unknown',
])

/**
 * Reduce a raw CLI failure to fixed safe facts.
 * Raw text is retained only on the Error's `cause` for Host logs.
 * @param {{ provider: string, stage: string, category: string,
 *           exitCode?: number|null, signal?: string|null, cause?: unknown }} facts
 * @returns {Error} message containing only fixed fields
 */
export function cliFailure({ provider, stage, category, exitCode, signal, cause }) {
  const fields = ['product: ' + provider, 'stage: ' + stage, 'category: ' + (CATEGORY.includes(category) ? category : 'unknown')]
  if (exitCode !== undefined && exitCode !== null) fields.push('exit code: ' + exitCode)
  if (signal !== undefined && signal !== null) fields.push('signal: ' + signal)
  const error = new Error('External agent failure (' + fields.join('; ') + ')', cause === undefined ? undefined : { cause })
  error.name = 'ExternalAgentFailure'
  error.category = category
  error.stage = stage
  return error
}
```

and at each call site replace the throw with a classification + fixed facts:

```js
// src/provider/codex.js:58 — BAD (current)
throw new Error('codex dispatch 失败 (exit ' + r.code + '): ' + (r.stderr || r.stdout).slice(-400))

// CORRECT
throw cliFailure({
  provider: 'codex',
  stage: 'turn',
  category: classifyCodexFailure(r),   // limit | access-policy | service | transport | unknown
  exitCode: r.code,
  signal: r.signal ?? null,
  cause: { stdout: r.stdout.slice(-2000), stderr: r.stderr.slice(-2000) },  // Host logs only
})
```

`classifyCodexFailure` is a small mapping over the exit code and the *first line* of stderr — matching on
`429`/`quota`/`rate limit` → `limit`, `403`/`permission`/`sandbox` → `access-policy`, `5xx`/`unavailable` →
`service`, `ECONN`/`timeout` → `transport`, else `product-error` or `unknown`. It classifies from the raw text but
**never emits it**.

### 4.5 Two things this must not lose

- **Debuggability.** The official pattern keeps the cause on `Error.cause`, which the Host logs. We must do the same
  or we trade a leak for an undiagnosable failure.
- **The 4096-byte cap.** Our messages are already short, but once `diagnostic` is attached (`src/backend.js:209`)
  an upstream provider could hand us a long one. Add the same UTF-8-boundary truncation as
  `out-of-process.ts:30-41` when we forward a provider-authored `diagnostic`.

**Effort: M** (one new module, four call-site edits, one classifier per CLI, plus tests).

---

## 5. PERMISSION-MODE PARITY — respect the bundle, do not override

### 5.1 The official stance

`permissionMode` is fixed on the **provider instance**, chosen once in `cordis.patch.yml`, with a safe default
(codex `never`, claude `dontAsk`). `subagent-codex/README.md:44`: "fixed for every thread from this provider
instance". It is **not** a tool parameter: examining `tool-subagent`'s parameter list
(`tool-subagent/src/index.ts:231-265`) shows `cwd`, `description`, `prompt`, and optionally
`agent_preset`/`provider`/`model`/`reasoning_effort` — no approval or sandbox field anywhere.

### 5.2 Our stance

We set no approval or sandbox flag. We pass `--skip-git-repo-check` for codex (`src/provider/codex.js:42`) and
otherwise let each CLI read its **native** settings. The official README endorses exactly this posture
(`subagent-codex/README.md:96`): "Native configuration is authoritative. Codex configuration and authentication stay
native through the parent cwd, `HOME`, and `CODEX_HOME`".

### 5.3 Verdict: ALREADY ALIGNED, and a pass-through would be wrong

We are aligned **in posture** (never override native policy from a tool call) and aligned **in safety**
(no mode is ever set to `dangerously-bypass-approvals-and-sandbox` on the user's behalf). A pass-through parameter
would violate the official principle on two counts:

1. It would let a **model** choose an approval mode mid-run, which the official design forbids by putting the
   setting on the instance. The whole point of instance-fixing is that the model cannot escalate itself.
2. `dangerously-bypass-approvals-and-sandbox` "must be selected explicitly" (`subagent-codex/README.md:49`) — by a
   human editing configuration, not by a tool argument.

If a user wants a different mode, the official-centered answer is: configure the bundle row (for official backends)
or the CLI's own settings (for our CLIs). **Do not add a pass-through. Effort: none — keep as is.**

---

## 6. OFFICIAL BEHAVIOR ALIGNMENT CHECKLIST

Each item is **ALREADY ALIGNED**, **MUST CHANGE** (with file:line and the exact change), or **N/A** (with reason).
MUST CHANGE items are listed first, in priority order.

### MUST CHANGE

**M1 — `DSH_` prefix scrubbed case-sensitively; official is case-insensitive.** *(S)*

- Ours: `src/runner.js:50` — `if (name.startsWith('DSH_')) continue`
- Official: `packages/subprocess/subprocess/src/index.ts:69` —
  `!key.toUpperCase().startsWith(DSH_ENV_PREFIX)`
- Proven: `dsh_lowercase_fact` survives `normalizeEnv()` and would be scrubbed on the official path.
- **Exact change:**

  ```js
  // src/runner.js:50
  - if (name.startsWith('DSH_')) continue
  + if (name.toUpperCase().startsWith('DSH_')) continue
  ```
- Add a regression test asserting a lowercase `dsh_*` ambient var is absent from `normalizeEnv()` while an
  explicit `dsh_*` entry in `extra` survives.

**M2 — failure diagnostics carry raw CLI stderr/stdout.** *(M)*

- Ours: `src/provider/claude.js:52`, `src/provider/codex.js:58`, `src/provider/opencode.js:57`,
  `src/provider/zcode.js:64` — all of the form
  `throw new Error('<name> dispatch 失败 (exit ' + r.code + '): ' + (r.stderr || r.stdout).slice(-400))`
- Official: `packages/subagent/subagent-codex/src/run.ts:86-105` builds the message from fixed fields only
  (`product`, `stage`, `category`, `HTTP status`, `exit code`, `signal`); `run.ts:122-127` hides the cause behind
  `stage: 'initialize', category: 'unknown'`; the contract is stated at
  `packages/subagent/subagent/src/types.ts:280-285` ("free of tool inputs, file contents, environment values,
  credentials, and raw protocol payloads").
- **Exact change:** add `src/diagnostic.js` exporting `cliFailure({ provider, stage, category, exitCode, signal, cause })`
  as specified in §4.4; replace all four throw sites; keep the raw text on `Error.cause` only. Add a classifier per
  CLI mapping exit code + first stderr line onto the official seven categories
  (`limit | access-policy | service | transport | product-error | invalid-result | unknown`,
  `subagent-codex/src/wire.ts:19-30`).

**M3 — forwarded provider `diagnostic` is not length-capped.** *(S)*

- Ours: `src/backend.js:209` — `if (diagnostic !== '') error.diagnostic = diagnostic` (no cap)
- Official: `packages/subagent/subagent/src/out-of-process.ts:19,30-41` — `MAX_SUBAGENT_DIAGNOSTIC_BYTES = 4_096`
  with UTF-8-boundary truncation and `'\n[diagnostic truncated]'`.
- **Exact change:** in `stopFailure`, truncate to 4096 UTF-8 bytes on a code-point boundary before attaching, using
  the same suffix. Add a test with a multi-byte character straddling the boundary.

**M4 — failures carry no machine-readable category.** *(S)*

- Ours: plain `Error` with a message (`src/backend.js:201-212`, `src/provider/*.js`)
- Official: `SubagentError` carries a `code` argument (`packages/subagent/subagent/src/error.ts`), and the runtime
  attaches `category`/`stage` facts (`subagent-codex/src/wire.ts:79-83`).
- **Exact change:** have `cliFailure` set `error.category` and `error.stage` (already in the M2 snippet), and add
  `error.code = 'EXTERNAL_AGENT_FAILURE'`. Do **not** attempt a full code-union rewrite — the official codes are
  plain strings too (`error.ts`: `code: string`).

### ALREADY ALIGNED

**A1 — credential-shaped env names are scrubbed.** `src/runner.js:33` uses `/KEY|PASSWORD|SECRET|TOKEN/i`,
byte-identical to `subprocess/subprocess/src/index.ts:47`, and `extra` is layered **after** the scrub
(`src/runner.js:53`) exactly as the official overlay is (`subagent-codex/README.md:54`). Verified by execution
(§2.1). Only the `DSH_` case sensitivity diverges (M1).

**A2 — never overrides native approval/sandbox policy.** No `permissionMode`-equivalent is set anywhere; we pass
`--skip-git-repo-check` (`src/provider/codex.js:42`) and otherwise defer to the CLI's own settings. This matches
"Native configuration is authoritative" (`subagent-codex/README.md:96`) and avoids the prohibited escalation path
(§5.3).

**A3 — one-shot is not violated, it is simply not imposed.** Our CLIs are invoked once per dispatch; the
`resumeSessionId` capability is an *additional* affordance over a durable external store, not a pretence of
resuming an in-harness child. See §2.2 — this is the category-error boundary, not a gap.

**A4 — cancellation settles rather than hangs.** `src/runner.js:88-91` kills the child on abort; the semaphore
rejects a pre-aborted call before taking a slot (`src/tools.js:54-56`). The official bundles settle an aborted run
as `aborted` (`subagent-codex/README.md:81`); our tool surfaces the abort as a rejected call, which is the
external-CLI equivalent.

**A5 — no host-CLI fallback confusion.** The official bundles explicitly have no host-CLI fallback
(`subagent-codex/README.md:81`: "there is no host-CLI fallback"). Our CLI path **is** the host-CLI path, so the
question does not arise; what matters is that we never claim the official provider fell back to a CLI. After the
`6c22b47`/earlier positioning work, the docs and tool description state the two paths are distinct
(`src/tools.js:318-325`), so this is aligned in substance.

### N/A — with reason

**N1 — one fresh process/thread/turn, no resume** (`subagent-codex/README.md:95`). **N/A.** That is a property of
the official provider's ephemeral transport. An external CLI owns a durable session store (`src/provider/claude.js:5`,
`codex.js:5`); imposing one-shot would delete `resumeSessionId`, `agent_sessions`, `agent_session_read`, and the
importer's purpose. Category error — see §2.2.

**N2 — `delivery: 'parent'`** (`subagent/subagent/src/types.ts:36-37`). **N/A.** Correct for a tool that returns
only a child id. Our tool returns the answer inline; `'parent'` would duplicate it and write a catalog row for a run
the model already holds the result of. See §2.1/C8.

**N3 — provider-minted child id** (`types.ts:297`). **N/A on the CLI path, ALIGNED on the subagent path.** The CLI
path must report the *product's* session id because that is the value `resumeSessionId` accepts; the subagent path
already reports a DSH-minted `activation.childId`. Forcing a DSH-minted id onto the CLI path would break resume.

**N4 — Schemastery `Config` / generated catalog** (official bundles). **N/A by deliberate design.** Exporting
`@deepseek-ai/schemastery` would break the plugin's zero-runtime-dependency rule and still could not validate the
legacy JSON file that no official bundle has. The transferable part — rejecting unknown keys — is tracked
separately in the previous round's backlog. See the O1 report §5 for the full argument.

**N5 — `disposeGraceMs`** (`subagent-codex/README.md:46`). **N/A.** It governs managed-range termination tiers for
a provider that spawns a managed process group. Our `timeoutMs` is a run budget, a different concept; adopting the
name would mislead.

**N6 — `permissionMode` pass-through.** **N/A — actively forbidden.** See §5.3: the official design fixes the mode
on the instance so a model cannot escalate itself. A tool parameter that let the model choose
`dangerously-bypass-approvals-and-sandbox` would invert the guarantee.

---

## Summary

The user's rule — 开发绝对以官方为唯一准则 — resolves, for this plugin, into a precise and narrow set of obligations:

- **Transfer the contract, not the transport.** The official bundles' *transport* is an ephemeral managed process
  with no session store; their *contract* is safe diagnostics, credential scrubbing, instance-fixed permissions,
  no host-CLI fallback, and disciplined cancellation. Only the second list applies to an external CLI.
- **Two real violations, both mechanical:** the `DSH_` case sensitivity (M1, one line) and the raw-stderr
  diagnostics (M2, one module + four call sites). M3 and M4 are the same violation's hardening.
- **Everything else is either already aligned or a category error to copy**, and the category errors are the
  interesting half: one-shot, `delivery: 'parent'`, provider-minted ids, `disposeGraceMs`, and a `permissionMode`
  pass-through must all be **refused** even though they are official behavior, because they belong to a transport
  this plugin does not use.
