# O1 — Official-behavior alignment: our external-agent extension vs the real `ctx.subagents` seam

Scope: line-by-line comparison of `dsh-agent-alliance` @ `519be02` against the official DSH subagent
implementation. Not a documentation review — every claim is quoted from both sides.

**Status: complete.** Six sections, every claim quoted from both sides.

## The three answers, up front

1. **Positioning (§3):** do **not** register four CLI providers — `codex` collides exactly with the vendor
   bundle's default name and throws `DUPLICATE_PROVIDER`; instead register **one** namespaced provider
   (`alliance`) behind an off-by-default flag, keeping `delivery: 'caller'` and the blocking `agent_dispatch`.
   The mechanism is proved: `observer.start` is unconditional (`manager.js:837`) while only the catalog is gated on
   `delivery === 'parent'` (`manager.js:434`), so a provider registration recovers lifecycle events, pooling and
   uniform results **without** changing our tool's ergonomics.
2. **The highest-value alignment is not structural** — it is four disciplines the seam enforces by contract and we
   do not: `isConcurrencySafe` (we omit it, so our calls are serialized and our own gate never runs), diagnostic
   hygiene (we forward raw CLI stderr), a closed result schema, and capability validation before spend (already
   adopted for two cases).
3. **Manual `loadConfig()` is defensible** — it validates the legacy file that Schemastery cannot reach — but it
   silently accepts unknown keys; a typo like `maxConcurrents: 5` yields `maxConcurrent: 3` with no warning
   (proven).

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

---

## 3. THE POSITIONING DECISION — should we register real `SubagentProvider`s?

Commit `519be02` removed the default `subagentProvider`, so today we are a pure **consumer-side** external-agent
extension: no provider registered, six private tools, private semaphore. The question is whether to go the other
way and register our four CLIs as providers so the **official** `dsh-tool-subagent` can dispatch to them by name.

### 3.1 What the decision actually buys — the decisive mechanism

The intuition is that registering a provider forces us into the official tool's fire-and-forget shape. **That is
false**, and the source says so.

`delivery` is chosen by the **consumer**, not the provider. The official tool picks `'parent'`
(`tool-subagent/src/index.ts:480`), but a provider is a passive participant — it is handed a
`SubagentActivationSpec` and does not get to veto `delivery`. Our own code can call
`startActivation({ delivery: 'caller' })` exactly as it does today (`src/backend.js:241`).

And the two observable side-effects are gated **differently**:

```js
// manager.js:434-436 — catalog rows ONLY for parent delivery
if (spec.delivery === 'parent') {
    establishExternalCatalogChild(parent.session, activation.childId, spec.label);
}
this.announce(activation);
```

```js
// manager.js:837 — lifecycle observer starts UNCONDITIONALLY
observer.start(activationAgent(activation));
```

```js
// lifecycle.js:52 and :54-59
emit('subagent/start', identity, parent);
…
settle: ({ stopReason, output }) => {
    emit('subagent/end', { ...identity, stopReason, ... }, parent);
},
```

So registering as a provider with `delivery: 'caller'` recovers:

| Gains | Source |
|---|---|
| `subagent/start` + `subagent/end` lifecycle events for every external run | `manager.js:837`, `lifecycle.js:52,54-59` |
| `maxActiveSubagents` pooling via `ActivationPool.reserve` | `activation.js` (`ACTIVATION_LIMIT_REACHED`) |
| Uniform `SubagentResult` with the diagnostic-hygiene obligation | `types.d.ts:237-263` |
| Provider lifecycle mirroring: official consumer tools auto-mount/unmount with our provider | `tool-subagent/lib/index.js:498-508` |
| One registration instead of six bespoke call paths for the dispatch half | `registerProvider` |

and does **not** force:

- a completion notice (that requires `delivery: 'parent'`);
- a catalog row (also `'parent'`);
- a change to `agent_dispatch`'s blocking contract — it would become
  `startActivation({provider:'alliance-codex', delivery:'caller'})` + await `result`, which is *precisely* what
  `src/backend.js:224-273` does today, minus the hand-rolled parts.

### 3.2 What breaks — the honest list

**B1. Name collision with the official vendor bundles is real, not hypothetical.**

`registerProvider` fails loud on a duplicate name (`dsh-subagent/lib/types/index.js:379-381`):

```js
if (this.providers.has(name)) {
    throw new SubagentError(`a subagent provider named "${name}" is already registered`, 'DUPLICATE_PROVIDER');
}
```

Official names: `codex` (`subagent-codex/src/index.ts:33` `DEFAULT_PROVIDER_NAME = 'codex'`), `claude-code`
(`subagent-claude-code/src/index.ts:33`), `spawn`, `fork`. Our ids are `claude`, `codex`, `opencode`, `zcode`
(`src/config.js:25-30`) — **`codex` collides exactly**. If both are enabled, whoever applies second throws and
its fiber fails. This is fatal and unavoidable without renaming.

**B2. Renaming breaks every persisted reference.** `subagentProvider` values, `agent_dispatch`'s `provider` enum,
the panel's `kind.*` labels, job labels, and the `providers.<id>` config keys all carry those four names. A rename
to `alliance-codex` etc. is a breaking config change requiring a migration path in `src/config.js`.

**B3. The official tool would expose our CLIs to **every** preset and every model**, with the official tool's
wording.* That wording is derived only from `inheritsParentContext` (`tool-subagent/src/index.ts:225-230`). Setting
it `false` gives "it does not share this conversation's context" — true for a CLI. But the model would then be told
to "start independent delegations … together in one assistant message" by the system-prompt section
(`404`-region), which is the fan-out advice our CLIs can only partly honour (they are one-shot, and their cost is
per-run). That is a *policy* exposure: any model can spend the user's Claude/Codex quota through a generic-looking
`subagent_*` tool.

**B4. `maxActiveSubagents` would then bound our CLIs too** — good in principle, but it is a *global* host setting
shared with in-harness children. A user who sets it to 2 to protect local children would silently throttle
external delegation, and there is no way for the plugin to opt out or keep its own `maxConcurrent`.

**B5. Capability advertisement must be honest.** Our CLI providers can honour none of
`agentOptions`/`agentPreset`/`outputSchema`/`maxDepth`, so they must advertise `NO_START_CAPABILITIES`
(`out-of-process.js:48-53`). That is fine, but it means `maxDepth` must be `'provider-managed'` in any tool row
that mounts them — the same constraint the vendor bundles satisfy
(`subagent-codex/cordis.patch.yml`: `maxDepth: provider-managed`).

**B6. `agent_roundtable` and the session-browsing tools cannot become providers.** They are not "run one task and
return". Only `agent_dispatch`'s dispatch half would move; the other five tools stay. So the plugin would carry
**two** delegation mechanisms — the registered provider for generic models, and `agent_dispatch` for roundtable /
history / inline. That is more surface, not less.

### 3.3 What improves

- **External runs become first-class**: lifecycle events, pooling, a uniform result, and diagnostic hygiene
  enforced by contract rather than by our own discipline.
- **Any model in any preset** can delegate to an external CLI through a tool it already knows (`subagent_*`), with
  wording and depth handling the harness already maintains — instead of learning six bespoke tools.
- **The official consumer maintains the tool lifecycle for us**: `tool-subagent` mounts/unmounts the tool on
  `subagent/provider-added` / `provider-removed` (`lib/index.js:498-508`), so we stop hand-rolling tool registration
  for that half.
- **Duplication risk drops**: with `519be02` we already stopped shadowing the vendor tools; becoming a provider
  would give the *generic* `subagent_*` rows a real external target instead of leaving external reachability
  exclusively in our bespoke tool.

### 3.4 Is there a tool-name collision?

**No — tool names are independent of provider names.** `toolName` is a row-config field
(`tool-subagent/src/index.ts:225`), defaulting to `subagent` (`:314` in the installed copy). Official rows occupy
`subagent`, `subagent_fork` (`bundle/base/cordis.patch.yml:379,390`), `subagent_codex`, `subagent_claude_code`
(vendor bundles). Our six are `agent_dispatch`, `agent_roundtable`, `agent_sessions`, `agent_session_read`,
`agent_import_scan`, `agent_import` (`src/tools.js:317-610`). **Zero overlap.**

But note the constraint from `tool-subagent`'s own docs: "every exposed tool needs a unique `toolName`". Adding
rows for our four CLIs would consume four more global names, and the provider-name collision (B1) is the real
constraint, not the tool-name one.

### 3.5 RECOMMENDATION

**Do not convert the plugin into a `SubagentProvider` package now. Do adopt the provider-shaped seam *internally*
and register exactly one provider under a namespace. Effort: L.**

Precisely:

1. **Register one provider, not four.** A single provider named `alliance` (no collision; not in
   `{spawn, fork, codex, claude-code}`) that dispatches on an embedded target. Rationale: B1 disappears, B2's
   rename shrinks to one config key, and B3's exposure is one tool row the user can see and switch off.
   The per-CLI config keys (`providers.claude|codex|opencode|zcode`) keep their current names — only the
   *registry* name is new.
2. **Keep `delivery: 'caller'`** for `agent_dispatch` internals; let the official tool use `'parent'` when a user
   chooses to mount a `subagent_*` row. Both work through one provider; §3.1 proves the mechanism.
3. **Advertise `NO_START_CAPABILITIES`** and require `maxDepth: 'provider-managed'` in any row that mounts it.
4. **Do not touch `agent_roundtable` / `agent_sessions` / importers** — they are not provider-shaped.
5. **Ship it behind a config flag** defaulting to off, so `519be02`'s positioning remains the default and the
   provider is an opt-in for users who want generic-model reachability.

**Why this exact cut.** Four separate providers collide with the vendor bundles (B1) and quadruple the surface;
zero providers (today) leaves external runs invisible to the harness's own lifecycle machinery. One namespaced
provider gets the events, pooling and hygiene, keeps the collision-free tool namespace, and preserves the blocking
`agent_dispatch` that is this plugin's actual differentiator.

**Why not the full four-provider version even though it is "more official":** the collision is not optional — `codex`
is the official vendor bundle's default name and the most likely one a user enables. A plugin whose `apply()`
throws `DUPLICATE_PROVIDER` when the user turns on the Codex bundle is a worse citizen than one that leaves
delegation to the vendor bundle for that provider.

---

## 4. LIFECYCLE / HMR — are our effects equivalent to the official registration?

### 4.1 The two registration mechanisms

**Official.** `registerProvider` is itself an effect of the *service's* context, and it yields a disposer that
removes the provider and emits a removal event:

```js
// dsh-subagent/lib/types/index.js:374-390
if (provider.start === undefined && provider.prepareContinuable === undefined) {
    throw new SubagentError(`subagent provider "${name}" must implement start or prepareContinuable`, 'UNSUPPORTED_CAPABILITY');
}
return this.ctx.effect(function* () {
    if (this.providers.has(name)) {
        throw new SubagentError(`a subagent provider named "${name}" is already registered`, 'DUPLICATE_PROVIDER');
    }
    this.providers.set(name, provider);
    yield () => {
        this.providers.delete(name);
        this.emitLifecycle('subagent/provider-removed', name);
    };
    this.ctx.emit('subagent/provider-added', provider);
}.bind(this), 'subagents.registerProvider()');
```

Note the `this.ctx` — the effect is owned by the **SubagentRuntime service**, and the caller's context determines
only nothing at all here; the provider package's own `apply()` is what dies on unload, and Cordis unwinds the
`ctx.effect` the service created **because the call happened inside that plugin's apply**. That is the same
mechanism our plugin relies on.

**Ours.** One effect wrapping all six registrations:

```js
// index.js:142
ctx.effect(() => registerTools(ctx, options), 'agent-alliance: tools')
```

```js
// src/tools.js:265-266 (JSDoc)
 * Each registration returns a disposer that the plugin's fiber owns; the caller
 * wraps this function in `ctx.effect()` so an unload unregisters all six tools.
```

The inner loop collects each `ctx.tools.register(...)` disposer and returns one disposer
(`src/tools.js:898-905`-region, `disposers` array). Both mechanisms are "one effect, N registrations, dispose
together".

### 4.2 Verdict: equivalent for HMR, with one asymmetry

**Equivalent on the axis that matters** — unload disposes everything, and there is no half-registered state,
because the tools read `ctx.get('jobs')` etc. lazily rather than at registration.

**Asymmetry that does matter:** the official consumer *reacts* to provider lifecycle events
(`subagent/provider-added` / `provider-removed`, `tool-subagent/lib/index.js:498-508`) so its tool appears and
disappears with the provider. Our tools never appear or disappear in response to anything except our own fiber.
Consequence: if a user disables, say, the `codex` bundle while our plugin stays mounted, nothing changes for us —
we simply keep dispatching through our own CLI wrapper. That is correct behaviour for us, and it is the *reason* the
official mirroring exists: it prevents a tool pointing at a provider that is gone.

**A real defect found here: `src/index.js` is a stale duplicate entry point.**

```
$ ls src/index.js && node -e "console.log(require('./package.json').main)" 
src/index.js
index.js
$ diff index.js src/index.js | wc -l
120
```

`package.json` loads `index.js` only (`"main": "index.js"`, `"exports": { ".": "./index.js" }`). The `src/index.js`
copy has *different* import specifiers (`./config.js` vs `./src/config.js`), a different JSDoc contract, and — the
part that matters — it registers its effects **without** an `agent-alliance:` label on some of them. It is dead
code that a maintainer will eventually edit by mistake. Effort **S**: delete it, or make it a one-line re-export.

### 4.3 The `inject` question

We declare only `['tools']` (`index.js:27`) and reach everything else through `ctx.get(...)`
(`index.js:44-56`). The official providers declare exactly the services they need
(`subagent-spawn-in-process/src/index.ts:24` — `export const inject = ['subagents']`), and `tool-subagent`
declares four (`const inject = ['tools', 'subagents', 'systemPrompt', 'sessionProjections']`).

**Not a defect for us** — a third-party plugin that must survive a composition without `jobs`/`webServer` genuinely
benefits from lazy resolution, and the previous audit already recorded the trade-off. But it is the reason a
misconfiguration is silent rather than loud, and if we ever register a provider (§3) we must add `'subagents'` to
`inject`, because `registerProvider` on a non-injected service throws.

---

## 5. CONFIG-CATALOG — Schemastery `Config` vs manual `loadConfig()`

### 5.1 Both sides

**Official** declares a Schemastery schema and exports it as `Config`:

```ts
// subagent-spawn-in-process/src/index.ts:30-32
export const Config: z<Config> = z.object({
  providerName: z.string().default('spawn'),
})
```

```ts
// subagent-codex/src/index.ts:58-65 (checkout)
export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  model: z.string().min(1),
  env: z.dict(z.string()).default({}),
  permissionMode: z.union([...CODEX_PERMISSION_MODES]).default(DEFAULT_CODEX_PERMISSION_MODE),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})
```

**Ours** validates by hand:

```js
// src/config.js:86-127
function validateLayer(layer, origin) {
  if (!isPlainObject(layer)) invalid('config', 'a JSON object', origin)
  …
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') invalid(key + '.enabled', 'a boolean', origin)
  …
  if (defaults.timeoutMs !== undefined && (typeof defaults.timeoutMs !== 'number' || !Number.isFinite(defaults.timeoutMs) || defaults.timeoutMs <= 0)) {
    invalid('defaults.timeoutMs', 'a positive finite number', origin)
  }
```

and merges three layers itself (`src/config.js:167-178`: defaults < legacy file < row config).

### 5.2 What we lose — measured, not assumed

`export const Config` is what makes a plugin's config **introspectable**. The live Host exposes this through the
Cordis Inspect `Config` provider (`cordis_inspect_list` → `{"platform":"host","id":"Config","methods":["listConfigs"]}`),
whose contract is "paged entry directory with schema status, then one entry's exact JSON Schema".

The official rows appear in that directory. Our single row does **not**: we export no `Config`, so the Loader has
no schema to project, and `cordis.patch.yml` cannot validate our row's keys. That is the concrete loss:

| Lost | Consequence |
|---|---|
| `Config.listConfigs` entry | our row is invisible to the config inspector; users cannot discover our keys from the UI |
| Generated config catalog (`docs/config-catalog.md` equivalent) | three layers of merge precedence live only in prose (`README.md`, `docs/SPEC-v2.md`) |
| `dump-config-schema` | `dsh --profile web --dump-config` shows our row without its schema |
| Load-time validation by the Loader | a typo like `maxConcurrents` is accepted silently; `validateLayer` only rejects *known* keys that are wrong-typed, never unknown ones |
| Defaults in one place | official defaults live in the schema; ours live in `defaultConfig()` **and** are re-stated in README/SPEC |

### 5.3 Is manual validation defensible?

**Yes, for the specific reason this plugin exists** — but the gap that matters is narrower than "we lack a schema".

The plugin's stated non-goal is zero runtime dependency on `@deepseek-ai/*`
(`docs/SPEC-v2.md`: "No runtime dependency on any `@deepseek-ai/*` package"), and its whole survival strategy is
"plain ESM that keeps working across rc bumps". Importing `@deepseek-ai/schemastery` (which is **not** a
`@deepseek-ai/dsh-*` package and is versioned independently) would technically respect the letter of that rule,
but it would add the first runtime dependency and make the plugin's config layer require a package the profile must
resolve.

**The defensible position:** manual validation is fine *for values*, and it is genuinely better than the official
bundles on one axis — it validates the **legacy file** (`~/.dsh/dsh-agent-alliance.json`), which Schemastery cannot
reach because it only validates the Cordis row config. The official bundles have no legacy-file path at all.

**The indefensible part:** unknown keys are silently accepted.

```js
// src/config.js:91-105 — iterates the KNOWN keys of each entry; never checks for extras
for (const [id, entry] of Object.entries(providers)) {
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') …
  …
}
```

A user who writes `maxConcurrents: 5` gets the default `3` with no warning — the same class of silent
misconfiguration the previous audit treated as a defect elsewhere. Effort **S**: add an unknown-key check per
layer.

### 5.4 Recommendation

**Do not export a Schemastery `Config` now. Do add strict unknown-key rejection. Effort: S.**

Rationale: exporting `Config` buys discoverability but costs the zero-dependency property that is the plugin's
stated reason to exist, and it would still not validate the legacy file. Unknown-key rejection buys the *correctness*
half of the same benefit for a few lines and no dependency. If the plugin later registers a provider (§3), revisit
this — at that point it is already deep in the seam and `Config` becomes cheap.

---

## 6. Official-alignment backlog

Prioritized by (user-visible harm ÷ effort). `S` ≈ under an hour, `M` ≈ a day, `L` ≈ multi-day.

### 6.1 SHOULD do

| # | Item | Evidence | Why it matters | Effort |
|---|---|---|---|---|
| 1 | **Declare `isConcurrencySafe: () => true` on `agent_dispatch`, `agent_sessions`, `agent_session_read`, `agent_import_scan`** | official: `isConcurrencySafe: () => true` (`tool-subagent/src/index.ts:279`); scheduler: `const group = mode === 'parallel' ? planned.slice(next) : [first]` (`tool-calls.ts:89-90`); ours: no classifier anywhere | Without it every call is exclusive, so a model that emits two `agent_dispatch` calls in one message runs them strictly serially and our own `maxConcurrent` gate is never exercised from a single step. Declaring safe is correct *because* the semaphore bounds concurrency. | **S** |
| 2 | **Reject unknown config keys in `validateLayer()`** | ourselves: `src/config.js:91-105` iterates known keys only; proven: `loadConfig({defaults:{maxConcurrents:5}})` returns `maxConcurrent: 3` with the typo retained and no error | Silent misconfiguration — the exact failure class the rest of this project treats as a defect. | **S** |
| 3 | **Delete the stale `src/index.js` duplicate entry point** | `package.json` `main: index.js`; `diff index.js src/index.js` = 120 lines, different import specifiers and effect labels | Dead code a maintainer will eventually edit instead of the live file, producing a silent no-op change. | **S** |
| 4 | **Sanitize `diagnostic` text before surfacing it** | official contract: "Providers keep this text free of tool inputs, file contents, environment values, credentials, and raw protocol payloads, and limit it to 4096 UTF-8 bytes" (`types.d.ts:280-286`); ours: raw `stderr` sliced to 400 bytes (`src/provider/claude.js:52`, `codex.js:58`, `opencode.js:57`, `zcode.js:63`) | A failing CLI can print an API key or a full prompt to stderr; we forward it into the model's context verbatim. | **M** |
| 5 | **Register one namespaced provider (`alliance`) behind an off-by-default flag** | §3.1 mechanism: `observer.start` is unconditional (`manager.js:837`) while only the catalog is gated on `delivery === 'parent'` (`manager.js:434`); collision hazard: `DUPLICATE_PROVIDER` (`lib/types/index.js:379-381`) vs official default name `codex` | Recovers lifecycle events, `maxActiveSubagents` pooling and uniform results for external runs **without** giving up `delivery: 'caller'` or the blocking tool. The single largest alignment gain available. | **L** |
| 6 | **Close the result schema on `agent_dispatch`** | official: closed `{kind: const, subagentId}` with `additionalProperties: false` (`tool-subagent/src/index.ts:268-278`); ours: `{ type: 'object', additionalProperties: true }` (`src/tools.js:243-245`) | PTC consumers get an untyped value for a stable shape; the model is told nothing about what comes back. | **M** (needs union check against `ValueSchemaSpec`) |

### 6.2 Explicitly NOT do

| # | Item | Reason |
|---|---|---|
| 1 | **Register all four CLIs as separate providers named `claude`/`codex`/`opencode`/`zcode`** | `codex` is the vendor bundle's default `providerName` (`subagent-codex/src/index.ts:33`), so enabling both throws `DUPLICATE_PROVIDER` and fails a fiber (`lib/types/index.js:379-381`). A plugin that breaks when the user turns on the official Codex bundle is worse than one that leaves that provider alone. |
| 2 | **Switch `agent_dispatch` to `delivery: 'parent'` to "match" official tools** | It returns the answer inline; `'parent'` would inject a duplicate completion notice into the parent context and add a catalog row for a run nobody can query (`manager.js:434`, `types.ts:36-37`). This would be a regression dressed as alignment. |
| 3 | **Export a Schemastery `Config` to get catalog discoverability** | Costs the zero-dependency property that is this plugin's stated survival strategy (`docs/SPEC-v2.md`, non-goals), and Schemastery still cannot validate the legacy JSON file — the one config layer that actually needs validation. Add unknown-key rejection instead (#2). |
| 4 | **Add `send_message` / steering support for external CLIs** | `types.d.ts:329-332`: "Providers without it execute through start and do not accept subsequent messages." The external CLIs are one-shot by construction; there is no transport for mid-run steering through their CLI surface. |
| 5 | **Bound external delegation by `maxActiveSubagents`** | It is a global host setting shared with in-harness children. Reusing it would let a user who protects local children silently throttle external delegation, and the plugin could not opt out. The private `maxConcurrent` is the better instrument. |
| 6 | **Add depth limits to our tools** | Our external agents are leaves — a Codex CLI cannot delegate back into DSH. There is no recursion to bound, so `maxDepth: 'provider-managed'` is the honest answer wherever a tool row mounts us. |

### 6.3 Needs a product decision

| # | Question | Trade-off |
|---|---|---|
| 1 | Should external runs be **visible in the DSH session graph** (a `subagent/catalog` row or a session event)? | Today an external delegation that spends money and edits files leaves **no** DSH record (§1.3 #7), which contradicts the harness's "model-visible ⟺ logged" invariant. Fixing it requires either `delivery: 'parent'` (duplicate notices) or a new event type — a product call about whether third-party plugins may write session events. |
| 2 | Should external delegation be **reachable by any model in any preset** via generic `subagent_*` rows? | Today it is reachable only through our bespoke tools. Making it generic (item 6.1 #5) improves ergonomics but lets any model spend the user's Claude/Codex quota through a tool that looks like the cheap in-harness one. |
| 3 | Is the **zero-runtime-dependency** rule still absolute? | It blocks `Config` export, model catalogues, and any future use of `dsh-*` helpers. If it is negotiable, several M/L items collapse to S. |
| 4 | Should `agent_roundtable` become provider-backed? | It cannot: it is an orchestrator, not a one-task execution. But a user may expect its members to be the same agents as `agent_dispatch`'s — today they share the resolver, which is the right answer and should be stated explicitly in the docs rather than left implicit. |

---

## Closing judgment: what "official alignment" means for an external-agent extension

The official seam exists to manage **in-harness children** — it owns their sessions, compositions, inboxes, and
teardown. An external CLI is not a child: it has its own account, its own session store, and its own lifecycle. Most
of what we "lose" by not being a `SubagentProvider` (§1.3: catalog, steering, depth, archive admission) is lost
*because it does not apply*, and forcing it would be alignment theatre.

Alignment that genuinely pays off is the part the seam enforces as **discipline rather than structure**:

- **capability honesty** — reject unsupported requests before spending (`assertCapabilities` before `start`,
  `lib/types/index.js:142` then `:149-151`); we already adopted this pattern for `resumeSessionId`
  (`src/backend.js:232`) and pre-aborted signals (`src/tools.js:54-56`);
- **diagnostic hygiene** — the 4096-byte, credential-free contract (`types.d.ts:280-286`), which we do not honour
  (6.1 #4);
- **result shape discipline** — a closed, documented value (`tool-subagent/src/index.ts:268-278`), which we do not
  have (6.1 #6);
- **scheduler cooperation** — `isConcurrencySafe` (`:279`), which we omit and which actively harms fan-out
  (6.1 #1).

Those four are worth more than provider registration, cost far less, and none of them require a dependency or a
breaking rename. Provider registration (6.1 #5) is the one structural item worth doing, and only in the single
namespaced, opt-in form — because it is the only way to make external runs visible to the harness's own lifecycle
machinery, and because the four-provider version collides with the vendor bundles on the provider name a user is
most likely to enable.
