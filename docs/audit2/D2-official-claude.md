# D2 — Official-behavior audit: `dsh-subagent-claude-code`

**Plugin under audit:** `dsh-agent-alliance` 0.2.0 at `1054bcb`
**Official authority:** `/home/ova/dsh/packages/subagent/subagent-claude-code/`
(package version **`0.2.1-alpha.2`**), plus the seam
`/home/ova/dsh/packages/subagent/subagent/src/types.ts`.

**The bundle is NOT installed** on this host. Everything below is read from the
source checkout, which is the only available authority; I mark any claim that
would need a live run as such rather than implying I executed it.

**Baseline note.** The tree moved eight commits since my A2 review. Every
plugin citation below was re-read at `1054bcb`.

---

## Q1 — `subagentProvider: 'claude-code'` and the duplicate tool

**Verified correct.** `subagent-claude-code/src/index.ts:33`
`const DEFAULT_PROVIDER_NAME = 'claude-code'`, mirrored by the Schemastery
default at `:60` (`providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME)`)
and the runtime fallback at `:125` (`config.providerName ?? DEFAULT_PROVIDER_NAME`).
Our default (`src/config.js:18` `claude: { enabled: true, subagentProvider: 'claude-code' }`)
names exactly that provider. **No mismatch.**

The bundle does install a global tool — `cordis.patch.yml`:

```yaml
- insert:
    - id: subagent-claude-code
      name: '@deepseek-ai/dsh-subagent-claude-code'
    - id: tool-subagent-claude-code
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: claude-code
        toolName: subagent_claude_code
        maxDepth: provider-managed
```

The official README confirms the global-tool effect in prose
(`README.md` "Installing the Bundle"): *"The layer registers the provider and
adds `subagent_claude_code` to every Agent as a global tool; it starts no
native process until delegation."*

**Is `agent_dispatch` a duplicate?** Functionally overlapping, **not a
naming collision**: `agent_dispatch` and `subagent_claude_code` are distinct
names, and `ToolRuntime.register` only rejects the reserved `run_code`, so both
mount cleanly. But they differ in *result arrival*, which is the part that
matters to a model composing a plan:

| | `agent_dispatch` (ours) | `subagent_claude_code` (official) |
| --- | --- | --- |
| delivery | `delivery: 'caller'` (`src/backend.js:245`), awaits `activation.result`, returns the text in the tool result | `delivery: 'parent'`, returns a child id immediately; the answer arrives later as a settlement notice |
| resume | accepts `resumeSessionId` (rejected on this path) | no resume parameter |
| model | per-call `model` arg, silently dropped on this path | per-bundle `model` config only |

Severity: **low**, documented as a model-ergonomics hazard rather than a
breakage. The plugin's description line promising "the official subagent
provider is preferred when the deployment registers one" is accurate, but
nothing tells the model that the *other* global tool exists and blocks
differently.

---

## Q2 — Does the bundle accept our `startActivation` request shape?

**Yes, and the "reject" assertion is real but would never fire for us.**

The bundle advertises the null capability set —
`subagent-claude-code/src/index.ts:74`
`readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES`, and
`subagent/src/out-of-process.ts:56-62`:

```ts
export const NO_START_CAPABILITIES: SubagentCapabilities = Object.freeze({
  agentOptions: false,
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
})
```

The gate that would reject extra fields,
`subagent/src/index.ts:627-644` `assertCapabilities`:

```ts
{ when: request.agentOptions !== undefined, cap: 'agentOptions' },
{ when: request.outputSchema !== undefined, cap: 'outputSchema' },
{ when: request.maxDepth !== undefined, cap: 'depthLimit' },
{ when: request.toolFilter !== undefined, cap: 'toolFilter' },
{ when: request.persona !== undefined, cap: 'persona' },
…
throw new SubagentError(
  `subagent provider "${provider.name}" does not support the "${cap}" capability`,
  'UNSUPPORTED_CAPABILITY',
)
```

**Our request at HEAD** (`src/backend.js:238-249`) sends exactly:

```js
request: {
  prompt: [{ type: 'text', text }],
  parent,
  ...(typeof request.cwd === 'string' && request.cwd !== '' ? { cwd: request.cwd } : {}),
},
signal,
delivery: 'caller',
```

`prompt` is `ContentBlock[]` (`{type:'text', text}`) — matches
`SubagentStartRequest.prompt: ContentBlock[]` (`subagent/src/types.ts:142`).
`cwd` is optional and absolute-checked downstream
(`subagent/src/types.ts:138` "relative paths resolve against the parent's
current directory"). **None of `maxDepth`/`agentOptions`/`outputSchema`/
`toolFilter`/`persona` is sent**, so `assertCapabilities` cannot throw.
Clean.

`delivery: 'caller'` is valid for an external one-shot provider and suppresses
the parent notice (`subagent/src/index.ts` `notifySettlement`: `if
(!activation.announced || activation.delivery === 'caller') return`), which is
what we want because we return the text ourselves.

---

## Q3 — `permissionMode: 'dontAsk'` and file-editing delegations

**Verdict: the default does NOT make edits fail — the blunter truth is that
*every* permission request is denied by our own callback regardless of mode.
`dontAsk` is not what gates editing; our `canUseTool` is.**

### The official table (verbatim)

`subagent-claude-code/README.md`, configuration section:

| `permissionMode` value | Native behavior |
|---|---|
| `dontAsk` | Deny operations that are not already authorized instead of prompting |
| `acceptEdits` | Accept file edits; any remaining permission prompt is denied by the unattended callback |
| `auto` | Let Claude Code's native classifier allow or deny permission requests |
| `plan` | Run in native planning mode, deny execution approval, and return the completed plan as the final answer |
| `bypassPermissions` | Explicitly set the SDK's dangerous confirmation and bypass permission checks |

Default, from the same table: `permissionMode` | `dontAsk` | "Native
non-interactive permission policy fixed for every run from this provider
instance". In code: `src/run.ts:56`
`DEFAULT_CLAUDE_CODE_PERMISSION_MODE: ClaudeCodePermissionMode = 'dontAsk'`
with the comment `/** Safe default for unattended Claude Code runs. */`.

### What actually happens on a tool permission request

`src/run.ts:337-352` `claudeQueryOptions` — for every mode **except**
`bypassPermissions`, the SDK gets a `canUseTool` that unconditionally denies:

```ts
...spec.permissionMode === 'bypassPermissions'
  ? { allowDangerouslySkipPermissions: true }
  : {
    canUseTool: () => {
      captureDiagnostic(unattendedDiagnostic(spec.permissionMode, 'tool permission',
        'denied', 'the provider does not request human approval'))
      return Promise.resolve({
        behavior: 'deny' as const,
        message: 'This unattended Claude Code subagent cannot request human approval.',
      })
    },
  },
```

So `dontAsk` and `acceptEdits` differ only in **who** denies: `dontAsk` lets
the native layer decide "not already authorized" and never reaches the
callback; `acceptEdits` reaches the callback for everything the edits
acceptance did not cover and gets denied there. Either way the child **cannot
complete a file-editing task that requires an approval**, and the mode does not
change that. `plan` additionally disallows `AskUserQuestion`/`ExitPlanMode`
(`:336-338`).

### Does it fail *silently*?

**No — but our plugin discards the evidence.** The denial is reported to the
SDK's diagnostic sink and surfaced as
`Claude Code unattended decision (mode: …; request: tool permission; decision:
denied): the provider does not request human approval`
(`unattendedDiagnostic`, `src/run.ts:138-145`). That text rides in
`SubagentResult.diagnostic`, which the seam documents as "Provider-authored,
non-assistant failure detail for a non-`completed` result"
(`subagent/src/types.ts`). Our code reads it **only** when the run did not
complete and produced no text (`src/backend.js` `stopFailure`), so a run that
*completes* while having silently skipped edits — because Claude Code gives up
on the denied tool and writes a plausible "here is what you should do" answer —
is returned to the model as a normal success. **That is the real risk: not a
hard failure, but a confident non-answer presented as an answer.**

### Should the plugin set a different mode?

**It cannot.** `permissionMode` is bundle row config
(`subagent-claude-code/src/index.ts:59-66`), not a `startActivation` field, and
`agentOptions`-style overrides are exactly what NO_START_CAPABILITIES forbids
(Q2). Our plugin has no channel to set it.

**So the actionable requirement is a warning**, and it is currently missing.
`src/tools.js` tool descriptions say only "This spends the target agent's
quota and it may read or write files in its cwd" (`COST_WARNING`). For the
official path the accurate statement is the opposite: *the official backend
cannot ask for approval, so any operation outside the session's pre-authorized
set is denied and may leave the task incomplete.* A user delegating "refactor
this module" through `agent_dispatch` on `claude-code` will reasonably expect
edits and will instead get prose unless their Claude settings already
pre-authorize the tools.

**Severity: high for the doc/tool-description gap, not for the mode itself.**
Recommended wording change, in both the description and the README's
"设计：两层派发" table: state that the official path is
approval-incapable, that `permissionMode` defaults to `dontAsk`, and that
`bypassPermissions`/`acceptEdits` can only be changed on the bundle's row.

---

## Q4 — The credential-scrubbing claim

**The premise is wrong: our plugin's README never claims the bundle scrubs
credentials.** I searched every plugin document — `README.md`, `README.zh.md`
(nonexistent), `docs/SPEC.md`, `docs/SPEC-v2.md`, `docs/MIGRATION-0.2.md`,
`docs/ROADMAP.md` — plus `git log --all -S"credential-scrubbed"` and
`-S"scrub"`. The only occurrences of that wording in the entire repository are
inside `docs/audit/03-official-subagents.md:364`, **a prior audit report
quoting the official table**, not a plugin claim. Our README's only environment
statement is `README.md:93`: *"宿主环境缺失时 runner 自动补 PATH/HOME/TMPDIR"*
("when the host environment is missing, the runner fills in PATH/HOME/TMPDIR").

So there is no doc claim implying safety we do not provide. **However the
underlying asymmetry the lead suspected is real and worth recording**, because
the two paths genuinely differ:

### The official sentence (verbatim, for the record)

`subagent-claude-code/README.md`, configuration section:

> Credential-shaped ambient variables are removed before the explicit `env`
> overlay, so an API key intended for the child must be supplied there.

and the table row: `| env | {} | Explicit SDK/CLI environment layered over the
credential-scrubbed parent environment |`.

Implementation, `subprocess/subprocess/src/index.ts:43-45`:

```ts
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i
```

`scrubbedParentEnv()` (`:66-80`) drops every matching name **and** every
`DSH_*` name before handing the map to the child. The bundle applies it at
`subagent-claude-code/src/run.ts:329`:
`env: { ...scrubbedParentEnv(), ...spec.env }`.

### Our CLI path does the opposite

`src/runner.js:20-21` `normalizeEnv`:

```js
const merged = { ...process.env, ...(extra || {}) }
```

It starts from the **raw parent environment** and only ever *adds* fallbacks
(PATH/HOME/TMPDIR). There is no scrub, no `DSH_*` filter, and no
`SENSITIVE_ENV_PATTERN` equivalent anywhere in the plugin
(`grep -rn "scrub\|SENSITIVE" src/` → no matches). Verified by driving the real
function with planted credentials:

```
DEEPSEEK_API_KEY     forwarded to child? true
MY_PASSWORD          forwarded to child? true
GITHUB_TOKEN         forwarded to child? true
DSH_INTERNAL         forwarded to child? true
plugin forwards 36 env vars wholesale
```

against the official scrubber's verdict on the same names:

```
DEEPSEEK_API_KEY   official scrub removes? true
MY_PASSWORD        official scrub removes? true
GITHUB_TOKEN       official scrub removes? true
DSH_X              official scrub removes? true
HOME               official scrub removes? false
PATH               official scrub removes? false
```

### Assessment

**Not a documentation defect** (no claim is made), **but a genuine security
asymmetry that the docs should state**, because the plugin presents the two
paths as interchangeable fallbacks (`README.md` "设计：两层派发" table lists
them as order 1 and order 2 of the same operation). A user who delegates with
`agent_dispatch` gets the scrubbed environment on the official path and the
**fully unscrubbed host environment** on the CLI path — including the DSH
host's own `DEEPSEEK_API_KEY`, every `DSH_*` internal, and any cloud token the
harness process happens to carry. The panel (`src/http.js` `backendOf`) always
takes the unscrubbed CLI path, so panel-initiated dispatches *never* get the
scrub.

Severity: **medium** — no credential leaves the machine, but it contradicts the
principle the harness applies to every other child spawn, and it is invisible
to the user because both paths are described as equivalents.

**Compliant form.** Port the same regex to `src/runner.js`
(`{ ...scrubbed-like-process.env, ...extra }` with
`/KEY|PASSWORD|SECRET|TOKEN/i` and a `DSH_` prefix filter, before the
PATH/HOME/TMPDIR fallbacks), and add one line to the README's two-layer table
saying the CLI path inherits the full host environment. The plugin must stay
dependency-free, so a local copy of the five-line scrubber is the right shape —
it must not import `@deepseek-ai/dsh-subprocess`.

---

## Q5 — "Never falls back to the host `claude` executable"

**Verified true, and the implication for a proxy-configured user is
significant.**

Official sentence, `subagent-claude-code/README.md` (intro): *"The
platform-pinned runtime starts on demand and never falls back to the host
`claude` executable."* Restated in the configuration section: *"It does not
copy or filter those files, create or modify login state, inspect `PATH`, or
fall back to a host `claude` executable."* And `README.md:138`: *"The
executable version comes from the Bundle's pinned SDK platform payload."*

Mechanism: the run is a Claude **Agent SDK** query
(`src/run.ts:309` `claudeQueryOptions` → `Options` with
`spawnClaudeCodeProcess` at `:369-375`), so the CLI binary comes from the
`@anthropic-ai/claude-agent-sdk` dependency's platform payload, not from
`PATH`. Our own CLI provider, by contrast, hardcodes a Termux path
(`src/provider/claude.js:16`
`paths.claudeBin = prefix() + '/lib/node_modules/@anthropic-ai/claude-code-linux-arm64/claude'`
invoked through `grun`).

**What this means for a user with a proxy-configured `claude` on `PATH`:**

- The **official path ignores their proxy/CLI configuration entirely.** It does
  not read their `~/.claude` login state, does not use their `claude` binary,
  and does not honor a shell wrapper. It *does* read native settings files
  (see below), which is a different thing from their executable setup.
- It **does** honor native settings: *"The provider omits the SDK
  `settingSources` option, so Claude Code reads the host's normal user,
  project, and local settings relative to the selected child working
  directory."* So `ANTHROPIC_BASE_URL`-style configuration living in settings
  files applies, but an `ANTHROPIC_BASE_URL` exported only in the user's shell
  environment **does survive** — not because the bundle forwards it, but
  because `scrubbedParentEnv()` only strips `KEY|PASSWORD|SECRET|TOKEN` and
  `DSH_*`, and `ANTHROPIC_BASE_URL` matches neither. (I checked the pattern:
  the name contains no key/password/secret/token substring.)
- A proxy configured as an **API key env var** is stripped by the scrub and
  will *not* reach the official child unless the user adds it to the bundle's
  `env` row — which the official README states explicitly: *"an API key
  intended for the child must be supplied there."*

**Is our documentation wrong about this?** Our README does not mention it at
all — `README.md:22-23` only names the packages and the provider ids. So it is
**an omission, not a contradiction**: a user who has a working `claude` CLI
(possibly proxied, possibly Termux-installed) has no way to learn from our docs
that the official path will not use it, and that their proxy may need to be
re-declared on the bundle row. Severity **low** (no incorrect statement;
missing guidance), worth one sentence.

---

## Q6 — `maxConcurrent` vs `maxActiveSubagents`

**They are independent limits on different layers, and the tighter one wins;
today the plugin's gate is usually the tighter for CLI work and irrelevant for
official work.**

- **`maxConcurrent`** — ours. `src/config.js:26` default `3`;
  consumed only by `createSemaphore` in `src/tools.js:245`
  (`Math.max(1, Number(defaults.maxConcurrent) || 3)`) and applied to
  `dispatchForeground` (`src/tools.js:258`) and the background dispatch job
  (`src/tools.js:344`).
- **`maxActiveSubagents`** — the seam's. `subagent/src/index.ts` Config,
  default **8**, enforced by `ActivationPool.reserve`:
  `if (this.slots.size >= capacity) throw new SubagentError('subagent limit
  reached (active child limit: ${capacity})…', 'ACTIVATION_LIMIT_REACHED')`.

**Do they double-bound?** Yes on the official path — both apply, and the
**smaller** wins in practice. With defaults, our gate admits 3 concurrent
dispatches, so only 3 official activations are ever live at once and the seam's
limit of 8 is never reached *through `agent_dispatch`*. Conversely if a user
raises `maxConcurrent` above 8, the seam throws
`ACTIVATION_LIMIT_REACHED` from `startActivation`, which our `execute` surfaces
as a structured tool error (contained by the registry) rather than a crash.

**But the gate does not cover everything, so "which wins" is per-path:**

| path | passes through our gate? | bounded by `maxActiveSubagents`? |
| --- | --- | --- |
| `agent_dispatch` foreground | yes (`src/tools.js:258`) | yes (official path) |
| `agent_dispatch` background job | yes (`src/tools.js:344`) | yes |
| `agent_roundtable` inline | **no** | yes |
| `agent_roundtable` background | **no** | yes |
| panel `/dispatch` | **no** — `src/http.js` calls `backend.dispatch` directly with no gate | yes |
| panel `/roundtable` | **no** | yes |

So roundtable and both panel routes are bounded only by the seam's 8 (and, on
the CLI path, by nothing at all — `maxActiveSubagents` is a subagent-service
concept and the CLI path never enters it). This is the residual of the
`maxConcurrent` finding I raised in A2; commit `e6054d7` fixed the queue
promotion but did not extend the gate to roundtable or the panel.

Severity **medium**; the fix is to construct the semaphore once in
`registerTools`/`registerHttp` and thread it into `runRoundtable`, rather than
relying on two different limit systems that overlap on one path and miss the
other three.

---

## Q7 — Contradicted doc claims and misleading errors on official-run failure

### 7a. Claims the official source contradicts

I checked every Claude-related sentence in our docs against the official
source. Result — **no outright contradiction; four material omissions**, which
in aggregate let a reader form a picture the official source does not support.

| Our doc | What it says | Official reality | Verdict |
| --- | --- | --- | --- |
| `README.md:15-16` two-layer table | official backend "托管生命周期、模型、权限与沙箱；一次性、隔离、只回最终答复" ("manages lifecycle, model, permissions and sandbox; one-shot, isolated, final answer only") | Accurate as far as it goes — but "权限" reads as *permissions are handled for you*. It cannot be told from our docs that the official default `permissionMode: dontAsk` **denies anything not pre-authorized** and that the provider supplies an unconditional `canUseTool` denial (`src/run.ts:337-352`) | **omission, misleading in practice** |
| `README.md:19-23` | "在「设置 → 插件」里启用即可，插件会自动探测" ("just enable it in Settings → Plugins; the plugin detects it automatically") | "自动探测" overstates. We check only whether the name is registered on `ctx.subagents` (`src/backend.js` `usableSubagentService`). We do **not** probe whether the SDK platform payload exists, and the official bundle explicitly documents that a missing payload "leaves the provider dormant and fails the first delegation at the SDK startup boundary" (`README.md:83`) | **overstated** |
| `README.md:92-93` | "各家探测：claude 经 grun" ("provider detection: claude via grun") | Only true for **our CLI path**. The official path never uses `grun` or a host binary at all (`official README.md:12` "never falls back to the host `claude` executable") | **path-ambiguous** |
| `README.md` (whole) | silent on `permissionMode`, `model`, `env`, payload size | All four are bundle-row config the user must know about (`official README.md:44-52`, `:187` 92 MB packed / 325 MB unpacked) | **omission** |

Two further official facts our docs never mention, both with user-visible
consequences:
- **The payload is platform-pinned and large** — `official README.md:187`
  "about 92 MB … unpacks to about 325 MB".
- **No resume, ever** — our README says this (`:25-26`), so this one is
  **correct** and worth recording as checked-and-clean.

### 7b. Error text that would mislead a user whose official run fails at `initialize`

The failure is well-formed on the official side.
`subagent-claude-code/src/run.ts:81-96` `failureDiagnostic`:

```
Product subagent failure (product: Claude Code; stage: query-start; category: unknown)
```

wrapped by `ClaudeCodeFailure` as
`subagent-claude-code: Product subagent failure (…)`
(`src/run.ts:98-109`), and the official README calls this "a safe
`query-start` / `unknown` failure fact" with "the original product error … on
the internal cause chain and in the provider's Host log" (`README.md:83`).

**What our plugin does with it.** The error reaches
`SubagentRuntime.startActivation` → `manager.startExternal` →
`materializeTracked`, whose `inputs.start(...)` rejects; that propagates out of
our `await route.service.startActivation(...)` (`src/backend.js:239`) and
becomes a structured tool error via the registry. Two problems:

1. **The cause chain is dropped.** `dsh-tools` `errorInfo`
   (`dsh-tools/lib/index.js:2709-2718`) only carries
   `{name, code}` for a `HarnessError`; `ClaudeCodeFailure` is a plain `Error`
   with `name: 'ClaudeCodeFailure'`, so the model sees the message text and
   nothing else. The official README says the actionable detail is on the
   **cause chain and Host log** — exactly the two places a model-facing tool
   result does not reach. A user reading the tool error gets
   `stage: query-start; category: unknown` and no hint that the likely cause is
   a missing 325 MB payload or an unsupported platform.
2. **Our own wrapper never adds the actionable hint.** Nothing in
   `src/backend.js` inspects the error message for `stage: query-start` to
   annotate it. The single most useful sentence — the one the official README
   already wrote for this case — is:

   > An install that omits optional dependencies, uses an unsupported platform,
   > or loses the selected payload leaves the provider dormant and fails the
   > first delegation at the SDK startup boundary with a safe `query-start` /
   > `unknown` failure fact; there is no host-CLI fallback.
   > — `subagent-claude-code/README.md:83`

**Fix (small).** In the `catch` around `startActivation`, if
`/stage: query-start/` matches, append:
`"(the official Claude Code SDK payload is missing or unsupported on this platform; reinstall the bundle — a host `claude` executable cannot be used)"`.
Also worth surfacing in `agent_dispatch`'s `presentResult`, which currently
hardcodes `card:'terminal'` + `exitCode: 0` and would render a failed official
start as a successful terminal run.

Severity: **medium** — the error is safe and non-crashing, but it is the exact
moment where a user needs the payload explanation and we give them
`category: unknown`.

---

## Q8 — `never` vs `dontAsk`: which default is riskier unattended?

Side by side, verbatim from the two official configuration tables:

| bundle | default | official row |
| --- | --- | --- |
| `dsh-subagent-codex` | **`never`** | "Never ask for approval; execution failures return to the model under the native sandbox" — `thread/start` fields: `approvalPolicy: never`; **sandbox omitted** |
| `dsh-subagent-claude-code` | **`dontAsk`** | "Deny operations that are not already authorized instead of prompting" |

**These are not the same kind of default, and that inverts the intuitive
reading.** Codex's `never` is an *approval-policy* default: it suppresses
prompts and lets execution proceed **inside Codex's native sandbox** (the
sandbox field is omitted, so Codex's own default applies). It does not deny
work; it removes the human from the approval loop and relies on the sandbox.
Claude's `dontAsk` is a *permission-answer* default: anything not already
authorized is denied outright, with no sandbox to fall back on.

Consequences for an unattended delegation that must edit files in the cwd:

- **Codex `never`** — will generally *perform* the edits (workspace-sandboxed),
  silently and without asking. Risk: **doing too much**. Nothing prompts, and
  the parent model is told only "final answer".
- **Claude `dontAsk`** — may *not* perform them, and our plugin will not notice
  (Q3/Q7: a `completed` run with prose is accepted as success). Risk:
  **plausibly doing nothing**.

Our plugin sets neither, structurally (Q2/Q3 — `permissionMode` is bundle-row
config, and `agentOptions`-style overrides are what `NO_START_CAPABILITIES`
forbids).

**Which is riskier? For *this* plugin: Claude Code's `dontAsk`.** The decisive
factor is not how much authority each mode grants — Codex's is plainly the more
permissive — but **whether the plugin can detect that the delegation was
hollowed out.** A Codex run that could not act fails inside the sandbox and
reports through its stop reason. A Claude run that was denied every tool still
finishes its turn, and our success test

```js
if (stopReason !== 'completed' && outputText === '') throw stopFailure(providerName, result)
```
(`src/backend.js:252`)

treats it as a **success**. So the riskier combination is: a restrictive
backend default + a plugin that only checks `stopReason`. The failure is
invisible at exactly the layer that decides whether to trust the result.

**Severity: high for the missing guidance; the `dontAsk` default itself is
sane.** Recommended README paragraph:

> The official backends cannot ask for approval. `claude-code` defaults to
> `dontAsk`, which denies any operation the session is not already authorized
> for; the agent may still return a confident prose answer having changed
> nothing. If a delegated task must edit files, either set
> `permissionMode: acceptEdits` (or `bypassPermissions`) on the
> `subagent-claude-code` bundle row, or use the CLI path — and verify the
> result rather than trusting the summary. `codex` defaults to `never`, which
> suppresses prompts but still runs under Codex's native sandbox.

---

## Verdict summary

| Q | Question | Verdict | Severity |
| --- | --- | --- | --- |
| 1 | `subagentProvider: 'claude-code'` + duplicate tool | **Correct**; provider name matches exactly (`DEFAULT_PROVIDER_NAME = 'claude-code'`). Global `subagent_claude_code` tool does mount, but names differ so both register cleanly. Overlap is an ergonomics hazard, not a breakage. | low |
| 2 | Our `startActivation` request accepted | **Yes.** `prompt` as `ContentBlock[]`, optional `cwd`, and none of `maxDepth`/`agentOptions`/`outputSchema`/`toolFilter`/`persona` — so `assertCapabilities` (`subagent/src/index.ts:627-644`) cannot fire. Clean. | none |
| 3 | `dontAsk` and file-editing delegations | **Edits are denied, but not by `dontAsk`** — our own `canUseTool` denies every request in every mode except `bypassPermissions`. Not silent at the SDK layer (a diagnostic is recorded), but **our plugin discards it** and returns a `completed` prose answer as success. | **high** (doc gap) |
| 4 | Credential-scrubbing claim | **Premise false — no such claim exists in the plugin's docs.** But the underlying asymmetry is real: official path scrubs (`/KEY|PASSWORD|SECRET|TOKEN/i` + `DSH_*`), our CLI path forwards **all 36** host vars unscrubbed, and the panel always uses the CLI path. | medium (security asymmetry) |
| 5 | "Never falls back to host `claude`" | **True and verified.** Official path is SDK-payload-pinned (`@anthropic-ai/claude-agent-sdk@0.3.263`), never inspects `PATH`. Our docs omit this, so a proxy-configured `claude` user is not told their setup is bypassed and their API key is scrubbed. | low (omission) |
| 6 | `maxConcurrent` vs `maxActiveSubagents` | Both apply on the official path; the smaller wins (our 3 < seam's 8). But the gate covers only `agent_dispatch`; roundtable **and both panel routes** bypass it entirely. | medium |
| 7 | Contradicted docs / misleading errors | **No outright contradiction; four omissions.** Worst: `query-start`/`unknown` failures reach the model with the cause chain dropped and no hint that the likely cause is a missing 325 MB payload — the exact explanation the official README already wrote. | medium |
| 8 | `never` vs `dontAsk` risk | **Claude's `dontAsk` is riskier for this plugin**, though it is the *less* permissive mode. Codex's `never` suppresses prompts but still executes under Codex's native sandbox (sandbox field omitted); Claude's `dontAsk` denies outright. The danger is that our success test (`stopReason !== 'completed' && outputText === ''`) accepts a hollowed-out Claude run as success. | **high** (doc gap) |

### The one-line Q3 answer

> `dontAsk` does not cause the edit failure — our plugin's own `canUseTool`
> denies every permission request in every mode except `bypassPermissions`, so a
> delegated Claude Code task **cannot** edit files it lacks pre-authorization
> for; the failure is not silent at the SDK layer but **is** silent at our
> layer, because a `completed` run carrying only prose is returned as success.

### Method limits

- The bundle is **not installed**; every claim is from source
  (`subagent-claude-code@0.2.1-alpha.2`) and the seam
  (`subagent/src/types.ts`, `out-of-process.ts`). I did not execute an
  official Claude Code run, so Q3's "the agent usually returns prose after a
  denial" is a documented-behavior inference from the `canUseTool` message
  contract and the `plan` mode rationale, not an observation. It is flagged as
  an inference wherever it drives a severity.
- Everything about *our* code was verified by reading and, where cheap, by
  executing (Q4's env forwarding used the real `normalizeEnv`; Q2's shape was
  checked field-by-field against `SubagentStartRequest`).
- Q6's "which wins" follows from `maxConcurrent` default 3 < `maxActiveSubagents`
  default 8; a user who raises `maxConcurrent` above 8 inverts it.
