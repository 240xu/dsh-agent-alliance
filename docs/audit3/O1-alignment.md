# O1 — Official-behavior alignment: our external-agent extension vs the real `ctx.subagents` seam

Scope: line-by-line comparison of `dsh-agent-alliance` @ `519be02` against the official DSH subagent
implementation. Not a documentation review — every claim is quoted from both sides.

**Status: in progress** — sections appended as each is verified.

## Authorities

| Role | Path |
|---|---|
| Service Definition | `packages/subagent/subagent/src/{index,types,manager,out-of-process,child-agent,depth,error}.ts` |
| Consumer / tool | `packages/subagent/tool-subagent/src/index.ts` |
| Providers | `packages/subagent/subagent-spawn-in-process/src/index.ts`, `subagent-fork-in-process/src/index.ts` |
| Composition | `packages/bundle/base/cordis.patch.yml` |
| Ours | `src/backend.js`, `src/tools.js`, `src/config.js`, `src/roundtable.js`, `index.js` |

## Sections

1. Capability seam — what we lose by not being a `SubagentProvider`
2. Tool shape — model-visible differences
3. Positioning decision — become a real provider?
4. Lifecycle / HMR
5. Config catalog
6. Alignment backlog

_(filled below)_

---

## Version skew warning (read this before any quote)

The source checkout and the running runtime are **different releases**, and their seams differ:

| | checkout `/home/ova/dsh` | installed `/usr/local/lib/node_modules/@deepseek-ai/dsh` |
|---|---|---|
| version | `0.2.1-alpha.2` | `0.2.1-rc.2` |
| `SubagentCapabilities` | `agentOptions, outputSchema, depthLimit, **toolFilter, persona**` (`subagent/src/types.ts:123-129`) | `agentOptions, **agentPreset**, outputSchema, depthLimit` (`lib/types/types.d.ts:115-121`) |
| `SubagentStartRequest` | has `toolFilter?`, `persona?` | has `agentPreset?`, **no** `toolFilter`/`persona` |
| spawn provider | `capabilities` with `toolFilter/persona`, `prepareContinuable()` | `{ agentOptions, agentPreset, outputSchema, depthLimit }`, `prepareContinuable()` |

The runtime enforcement matches the **installed** copy: `assertCapabilities` rejects `agentPreset`
(`dsh-subagent/lib/types/index.js:440-442`) and checks exactly `agentOptions`/`outputSchema`/`maxDepth`
(`:443-452`) — `toolFilter`/`persona` appear nowhere in the runtime.

**Consequence for this audit:** every capability statement below is quoted from the **installed rc.2** copy, which
is what actually executes on this machine. Quotes from `packages/` are used only where they agree, and any
disagreement is called out. Anyone re-deriving these findings from the checkout alone will reach the wrong
conclusion about `agentPreset` and will believe `toolFilter`/`persona` are real capabilities — they are not, at
runtime.

---

## 1. CAPABILITY SEAM — what we give up by not being a `SubagentProvider`

### 1.1 The official division of labour

The seam is three roles, each its own package:

| Role | Package | Evidence |
|---|---|---|
| Service Definition | `dsh-subagent` | `SubagentRuntime` class, `startActivation`, `registerProvider` (`lib/types/index.d.ts:105-319`) |
| Provider | `spawn`, `fork`, `codex`, `claude-code`, `acp` | `ctx.subagents.registerProvider(new SpawnInProcessProvider(...))` (`subagent-spawn-in-process/lib/index.js:36`) |
| Consumer | `dsh-tool-subagent` | `runtimeCtx.subagents.startActivation({...})` (`tool-subagent/lib/index.js:475-481`) |

The provider interface is deliberately tiny — one required identity plus two optional execution methods
(`lib/types/types.d.ts:296-342`):

```ts
export interface SubagentProvider {
    readonly name: string;
    readonly capabilities: SubagentCapabilities;
    readonly inheritsParentContext: boolean;
    readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>;
    start?(request: ResolvedSubagentStartRequest): Promise<SubagentRun>;
    prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>;
}
```

Registration is one call, and it is the whole of a provider package's `apply()`:

```ts
// packages/subagent/subagent-spawn-in-process/src/index.ts:67-69
export function apply(ctx: Context, config: Config): void {
  ctx.subagents.registerProvider(new SpawnInProcessProvider(config.providerName))
}
```

### 1.2 What our plugin does instead

`dsh-agent-alliance` never touches `ctx.subagents` in a mutating way. Verified across the whole package:

```
$ grep -n "registerProvider" src/*.js index.js   →  (no matches)
$ grep -n "startActivation"    src/*.js index.js →  src/backend.js:377 (a call, in the opt-in path)
```

Our composition is one `apply()` that builds a private registry and registers six raw tools:

```js
// index.js:142
ctx.effect(() => registerTools(ctx, options), 'agent-alliance: tools')
```

```js
// src/tools.js:316-317, 409-410, 512-513, 539-540, 562-563, 609-610
disposers.push(ctx.tools.register({ name: 'agent_dispatch', … }))
disposers.push(ctx.tools.register({ name: 'agent_roundtable', … }))
disposers.push(ctx.tools.register({ name: 'agent_sessions', … }))
disposers.push(ctx.tools.register({ name: 'agent_session_read', … }))
disposers.push(ctx.tools.register({ name: 'agent_import_scan', … }))
disposers.push(ctx.tools.register({ name: 'agent_import', … }))
```

So the Service Definition and Provider roles are both absent, and the plugin acts as its **own** consumer. The
concurrency gate, the cwd resolver, the result normaliser, the resume rejection, and the timeout budget are all
private (`src/tools.js:45-99`, `src/backend.js:206-336`).

### 1.3 Per-capability verdict

Each row below is "what the official seam gives a registered provider" vs "what we have", with a verdict **for an
external-agent extension specifically** — not for a general delegation feature.

| # | Capability | Official source of truth | Our state | Verdict |
|---|---|---|---|---|
| 1 | **Discovery / catalog** (`listChildren`, `listDescendants`) | `manager.js:435` `establishExternalCatalogChild(parent.session, activation.childId, label)` runs **only** for `delivery === 'parent'` | none — we use `delivery: 'caller'` (`src/backend.js:241`), so no catalog row is written | **Acceptable.** A synchronous tool that already returned the answer has nothing to list. Losing it is the price of `'caller'`, and `'caller'` is correct here (see §2.4). |
| 2 | **`subagent/start` + `subagent/end` events** | `lifecycle.js:52` / `:54-59` — emitted for every published activation | none | **Acceptable, with a caveat.** No observer (telemetry, UI child tree, projection) sees our runs. Acceptable because we are not a *child agent*; the caveat is that cost accounting outside the plugin cannot see external spend. |
| 3 | **`maxActiveSubagents` pooling** | `ActivationPool.reserve` throws `ACTIVATION_LIMIT_REACHED` (`activation.js`: "subagent limit reached (active child limit: …)") | our own `createSemaphore(maxConcurrent)`, default 3 (`src/config.js:29-33`) | **Acceptable and arguably better.** The host pool is a *global* cap shared with in-harness children; a separate budget for expensive external CLIs is a feature, not a gap. Documented divergence, not a defect. |
| 4 | **`send_message` steering** | `sendMessage` / `interrupt` (`lib/types/index.d.ts:153-196`), gated on `prepareContinuable` presence — external providers without it get `NOT_CONTINUABLE` (`activation.js`, `requireLocalActivation`) | impossible: external CLIs are one-shot by construction | **Acceptable — forced.** `types.d.ts:329-332`: "Providers without it execute through start and do not accept subsequent messages." Steering an external CLI mid-run is not implementable through its CLI surface. |
| 5 | **Depth limits** (`maxDepth`, `depthLimit`) | `assertCapabilities` rejects `maxDepth` on providers without `depthLimit` (`lib/types/index.js:443-452`); `depth.js` computes child depth | none; our tools have no delegation-depth notion | **Acceptable.** Our external agents are leaves — a Codex CLI cannot delegate back into DSH. There is no recursion to bound. |
| 6 | **Model-selection settings** (`agentOptions`, `modelSelectionSettings`) | requires `capabilities.agentOptions` (`tool-subagent/lib/index.js:366`) | we accept a free-text `model` and pass it to the CLI (`src/tools.js:334`) | **Acceptable but weaker.** Our `model` is unvalidated and unlisted; the official path offers `list_subagent_models` and exact-route preflight. |
| 7 | **Session lineage / parent-child linkage** | `parent.session` catalog + `activation.ancestry` (`manager.js`, `archive-admission`) | none; external runs are invisible to the session graph | **Acceptable for runtime, a real loss for audit.** Nothing in the DSH session log records that an external agent ran, so "what did my agent do" cannot be reconstructed from DSH alone. |
| 8 | **Archive admission** | `archive-admission.js` decides whether a child may be archived with its parent | none — no child exists | **Acceptable, consequence of #1.** |
| 9 | **Capability validation before spend** | `assertCapabilities` runs **before** `provider.start` (`lib/types/index.js:142` then `:149-151`) | partial: we now reject `resumeSessionId` before `startActivation` (`src/backend.js:232`) and the aborted signal before the gate (`src/tools.js:54-56`) | **Acceptable, recently improved.** The seam's "never accepted-then-ignored" discipline was the model for our two guards. |
| 10 | **Uniform `SubagentResult`** | `{ output: ContentBlock[], structured?, diagnostic?, stopReason }` with `diagnostic` free of credentials, ≤4096 bytes (`types.d.ts:237-263`) | our own `{ text, stopReason, externalSessionId, durationMs, backend }` (`src/backend.js:253-259`) | **Acceptable, with one gap.** We do not enforce the 4096-byte/diagnostic-sanitisation rule on CLI stderr, which we slice to 400 bytes but do not scrub (`src/provider/*.js`). |

### 1.4 What this section actually establishes

Two of the ten losses are **substantive**, not cosmetic:

- **#7 session lineage.** An external delegation leaves no trace in the DSH session log. The plugin's own job
  record and the optional import ledger are the only record, and neither is part of the Host's session format.
  For a harness whose stated invariant is "model-visible ⟺ logged", an external agent that spends money and edits
  files while leaving no session event is a genuine hole. It is not fixable without becoming a provider (#3).
- **#10 diagnostic hygiene.** The seam *requires* providers to keep credentials and raw protocol out of
  `diagnostic`. Our CLI wrappers surface raw stderr slices. See §6 for the recommended narrowing.

The other eight are consequences of a correct architectural choice — an external CLI is not an in-harness child,
so catalog, steering, depth, pooling and archive admission have nothing to act on.

---

## 2. TOOL SHAPE — what the model actually experiences

### 2.1 Side by side

| Aspect | Official `subagent` / `subagent_fork` / `subagent_codex` | Our `agent_dispatch` |
|---|---|---|
| Registration | `defineTool({ name: toolName, … })` with `toolName` from row config (`tool-subagent/src/index.ts:223-225`) | raw `ctx.tools.register({ name: 'agent_dispatch', … })` (`src/tools.js:316-317`) |
| Required args | `description` + `prompt` (`:236-245`) | `prompt` only (`src/tools.js:344`) |
| Optional args | `cwd`, plus `provider`/`model`/`reasoning_effort` **only when** `modelSelectionSettings` is on (`:246-265`) | `provider`, `cwd`, `resumeSessionId`, `model`, `background`, `timeoutMs` |
| Output schema | closed: `{ kind: const 'activation', subagentId: string }`, `additionalProperties: false` (`:268-278`) | open: `{ type: 'object', additionalProperties: true }` (`src/tools.js:243-245`) |
| Return value | `{ kind: 'activation', subagentId }` → renders `started subagent <id>` (`:277`) | final answer text inline (`src/tools.js:338-342`) |
| Timing | returns **immediately**, result arrives later as a notice | **blocks** for the whole run |
| Concurrency classifier | `isConcurrencySafe: () => true` (`:279`) | **none declared** |
| Follow-up | provider-dependent: `send_message` when `prepareContinuable` present, else "does not accept follow-up messages" (`:227-229`) | `resumeSessionId` only (CLI path) |
| Cancellation | `exec.signal` before publication; later cancellation via `dispose` | `exec.signal` + semaphore queue abort |

### 2.2 The scheduler finding — our tools are serialized against each other

This is the sharpest model-visible difference and it is **not** about blocking vs notifying.

`executionMode` (`packages/core/tools/src/index.ts:1310-1318`):

```ts
executionMode(exec: ToolExecutionInput): ToolExecutionMode {
    const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== undefined)
    if (!tool?.isConcurrencySafe) return { kind: 'exclusive' }
    try {
      const concurrencySafe: unknown = tool.isConcurrencySafe(exec.arguments)
      return concurrencySafe === true ? { kind: 'parallel' } : { kind: 'exclusive' }
    } catch {
      return { kind: 'exclusive' }
    }
}
```

and the step scheduler (`packages/core/agent-loop/src/tool-calls.ts:89-90`):

```ts
const mode = ctx.tools.executionMode(first.exec).kind
const group = mode === 'parallel' ? planned.slice(next) : [first]
```

So an **exclusive** call is its own group of one: the next call in the same step cannot even be *classified* until
the previous one settles. Two consequences:

1. A model that emits `agent_dispatch(a)` **and** `agent_dispatch(b)` **and** `subagent(code)` in one assistant
   message gets them run strictly one after another. Our own `maxConcurrent` semaphore can never be exercised from
   a single step — it only ever sees one in-flight call from that path. It is still meaningful across *steps*,
   across background jobs, and via the HTTP route, but the "fan out in one message" pattern does not work.
2. The official tools *do* fan out: `isConcurrencySafe: () => true` is exactly what makes the official delegation
   tools composable, and the system-prompt section says so —

   > "Start independent delegations with `subagent` or `subagent_fork` together in one assistant message and
   > continue useful work while they run." (`tool-subagent/lib/index.js:510-518`)

   Our tool is invisible to that advice and cannot benefit from it.

**Verdict: a real defect, not an alignment nicety.** Declaring `isConcurrencySafe: () => true` on
`agent_dispatch` is correct *because* the plugin has its own semaphore: concurrency is bounded by
`maxConcurrent`, not by the scheduler. The two mechanisms compose instead of fighting. `agent_sessions`,
`agent_session_read`, `agent_import_scan` are read-only and also safe to parallelise; `agent_import` and
`agent_roundtable` are not (one writes a session, the other already fans out internally and would multiply).

### 2.3 Output schema: open vs closed

The official tool's closed schema is a promise the model can plan against: it knows the call yields an id, not an
answer. Our `additionalProperties: true` (`src/tools.js:243-245`) tells the model nothing; the shape is discovered
only by reading the rendered text. It also means PTC (`run_code`) consumers get an untyped `any` for a value whose
keys are known and stable (`provider`, `text`, `backend`, `externalSessionId`, `stopReason`, `durationMs`).

Two shapes are possible here because `agent_dispatch` has **two** return kinds:

```js
// background:true
{ kind: 'background', jobId }
// foreground
{ provider, text, backend, externalSessionId, stopReason, durationMs }
```

A closed schema would need `oneOf`-style union support; the repo's own tool contract
(`docs/cookbook/adding-a-tool.md`) permits object/array/scalar roots but the registry's `ValueSchemaSpec` subset
would have to be checked before promising it. This is a **S**-sized improvement with an **M**-sized risk if the
schema subset cannot express the union — worth verifying before attempting.

### 2.4 Why `delivery: 'caller'` is the right call for *our* tool

Official tools use `delivery: 'parent'` (`tool-subagent/src/index.ts:480`) because they return only an id; the
answer must arrive some other way. We return the answer inside the tool result, so a completion notice would
duplicate it in the parent's context. The seam documents the trade-off (`types.ts:36-37`):

> "Parent delivery notifies the model; caller delivery only returns the result. Local children always enter the
> parent catalog."

Our choice is correct **and** the catalog loss is inherent to it — this is the #1 row in §1.3 and it is not a bug.
The residual issue is only that the value we report as `externalSessionId` is a DSH-minted per-run UUID, not a
resumable external session id; that was already logged in the previous audit and is unchanged.

### 2.5 Description quality — currently better than official, in one respect

Our description now explicitly positions against the built-in tools (`src/tools.js:318-325`):

> "These are agents the built-in delegation tools cannot reach: `subagent` and `subagent_fork` delegate to
> in-harness children, so prefer them for anything an in-harness child can do"

The official tool cannot say this — it does not know other tools exist. This is a genuine advantage of being a
consumer-side plugin and worth keeping. It is also the answer to the "tool duplication" concern from the previous
round: the descriptions now differentiate by *reachability* (external vs in-harness), not by ergonomics.
