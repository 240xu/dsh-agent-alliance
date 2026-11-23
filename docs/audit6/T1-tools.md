# T1 — `src/tools.js` official-alignment audit and slimming plan

**Analysis only.** No source file was modified; no commit made.

Repo `dsh-agent-alliance` @ HEAD (749-line `src/tools.js`), runtime `/opt/dsh-0222` (`0.2.2-rc.5`).
Baseline verified before and after this audit: **262 tests pass, 0 fail**; `node --check src/tools.js` OK.

## Verdict summary

| Q | Question | Verdict |
|---|---|---|
| 1 | Is `withArgValidation` necessary? | **YES — necessary. Not redundancy. Do not delete.** Confirmed at source. |
| 2 | Is `createSemaphore` duplicating an official mechanism? | **Official has the mechanism but only for in-harness children.** Our use is a genuine gap-fill; it is NOT replaceable by `maxActiveSubagents` or `maxConcurrentJobsPerOwner`. |
| 3 | Is `openOutput` equivalent to an official helper? | **No official equivalent exists for an open object schema.** It is a 2-line local convention, correctly minimal. |
| 4 | Description style vs official | Style matches. The one real duplication (COST_WARNING vs roundtable sentence) **was already fixed** in a prior round — nothing to do. |
| 5 | Slimming candidates | 3 genuine items (~14 lines). Most of the file is load-bearing. |

The headline: **the file is not bloated by redundancy; it is long because it declares six rich tool schemas.** Most "obvious" deletions are load-bearing.

---

## Q1 — `withArgValidation` is necessary (confirming the Lead's finding)

### Evidence

`ctx.tools.register(definition, options)` — the full implementation,
`/opt/dsh-0222/node_modules/@deepseek-ai/dsh-tools/lib/index.js:433-445`:

```js
register(definition, options = {}) {
    const name = definition.name;
    const output = definition.output;
    if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || ...) throw new TypeError(...);
    assertSupportedJsonSchema(output.schema);
    const timeoutMs = definition.timeoutMs;
    if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError(...);
    if (name === "run_code") throw new Error(...);
    return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, {
        definition, when: options.when
    }), { label: "tools.register()" });
}
```

It validates **`output.schema`** (`assertSupportedJsonSchema`) and **`timeoutMs`** — and calls nothing on `definition.parameters` and nothing on the arguments. There is no `validate` in sight.

Contrast `defineTool`, `lib/index.js:322` and `:338-341`:

```js
const validate = (args) => validateJsonSchemaValue(parameters, args, "");
…
async execute(args, exec) {
    const violations = validate(args);
    if (violations.length > 0) throw new ToolArgsError(violations);
    return userExecute(args, exec);
}
```

So the argument check lives **only** in the `defineTool` wrapper. A raw `register()` caller gets `parameters` published to the model as a promise, with **zero** runtime enforcement.

### Consequence if deleted

`agent_dispatch` declares `required: ['prompt']` (`src/tools.js:391` declares `prompt`). Without `withArgValidation`, a model that sends `{}` reaches `execute`, where `String(args.prompt)` yields `"undefined"` and a real external CLI is spawned with the literal string `undefined` — real quota spent on a malformed call. The same applies to `agent_roundtable`'s `rounds` (an `integer`) and `providers` (an `array of string`).

### Conclusion

**`withArgValidation` is the local equivalent of `defineTool`'s wrapper, and is required because we register raw.** It is not a deviation from the official contract — it is the manual implementation of it. The comment at `src/tools.js:271-277` states this correctly and should be preserved.

Test coverage: `tests/tools.test.js:670-693` asserts three malformed shapes (`{}`, `{prompt:123}`, `{prompt:'x',bogus:1}`) all reject with `code === 'INVALID_ARGS'`, and a valid call still dispatches. **Deleting the function fails this test**, which is the desired guard.

---

## Q2 — `createSemaphore`: official has the mechanism, but not for external processes

### What official actually provides

| Mechanism | Where | Scope | Applies to our external CLI? |
|---|---|---|---|
| `maxActiveSubagents` | `dsh-subagent/lib/types/index.d.ts:100`; enforced by `ActivationPool.reserve` (`activation.js:16-24`) | in-harness child Agents **and** external providers dispatched through the seam | **Only if we became a `SubagentProvider`** — see below |
| `maxConcurrentJobsPerOwner` | `dsh-jobs-local/lib/index.js:364,425` | background *jobs*, a different axis entirely | **No** — bounds job records, not processes |
| `maxConcurrentAgents` | `dsh-workflow-ptc` (workflow `agent()` hook) | children started by a workflow script | **No** — only inside a workflow run |
| `maxParallelToolCalls` | agent-loop step scheduler | tool *calls* in one step | **No** — bounds tool calls, and is relaxed by `isConcurrencySafe` |

### The decisive detail

`maxActiveSubagents` is enforced inside `materialize()`, which **both** the local and the external path go through
(`dsh-subagent/lib/types/manager.js:629-637`):

```js
materialize(inputs) {
    this.assertAdmitting(inputs.root);
    inputs.signal.throwIfAborted();
    const pool = this.rootPool(inputs.root);
    const releaseSlot = pool.reserve(this.maxActiveSubagents());
    return this.materializeTracked(inputs, releaseSlot).catch((error) => { releaseSlot(); throw error; });
}
```

and `materialize` is what the external branch calls (`:420`, `start: signal => this.host.startExternal(...)`).

**So the official pool WOULD bound our external CLIs — but only if we registered a `SubagentProvider` and dispatched
through `ctx.subagents`.** Today we do not: `grep -n "registerProvider" src/*.js index.js` → **no matches**. We call
`backend.dispatch()` directly, entirely outside the seam.

### Conclusion

`createSemaphore` is **not duplicating an available official mechanism; it fills a real gap** given our current
architecture. It is also **not** a "should have used official jobs" case: jobs bound job records per owner, which is
orthogonal to how many external *processes* are alive at once.

Two honest caveats worth recording:

1. **If** the plugin ever registers a provider (the O1 report's §3 recommendation), `maxActiveSubagents` would
   apply and our semaphore would become redundant *for that path* — but not for the panel/HTTP path, which has no
   Agent and therefore no pool. A semaphore would still be needed there.
2. Our semaphore bounds **per plugin instance**, while `maxActiveSubagents` bounds **per root Agent tree**. Those
   are genuinely different policies. A user running three Sessions would see 3× our limit but only 1× the official
   one. This is a deliberate design choice worth stating in the config docs (currently `maxConcurrent` is
   documented as "同时派发…的在飞数量" without saying per-instance).

**Verdict: keep.** Not redundancy. Add one sentence to the config docs clarifying the scope.

---

## Q3 — `openOutput` / `renderDispatch` vs official output conventions

### Official pattern

`register()` requires an `output` object with a `render` function and a schema passing `assertSupportedJsonSchema`
(`lib/index.js:436-437`). Official tools declare a **closed** schema. E.g. `tool-subagent`:

```ts
output: {
  schema: { type: 'object', additionalProperties: false,
            properties: { kind: {type:'string', required:true, const:'activation'}, subagentId: {type:'string', required:true} } },
  render: (_args, value) => [{ type: 'text', text: `started subagent ${value.subagentId}` }],
}
```

### Ours

```js
function openOutput(render) {
  return { schema: { type: 'object', additionalProperties: true }, render }
}
```

`{type:'object', additionalProperties:true}` is **within** the enforced subset (`dsh-tools` json-schema.ts accepts an
object root with boolean `additionalProperties`), so `register()` accepts it — verified: the suite registers all six
tools successfully. There is **no official helper** that produces an "open object" output; every official tool
hand-writes its closed schema.

**Verdict: keep — it is the minimal correct form for a tool whose value has two shapes** (foreground result object
vs `{kind:'background', jobId}`). A closed schema would need `oneOf`, which the subset *does* support, but the two
shapes have different key sets and the union would be materially larger than the 3-line helper. `renderDispatch` is
called by exactly **1** tool (`agent_dispatch`, `src/tools.js:403`); its other 5 callers use `openOutput` with an
inline renderer. It is a 9-line helper with 1 call site — borderline, but its header-formatting logic (truncate at
4000 chars, prepend `[provider session id]`) is behaviour the tests observe.

---

## Q4 — Description style vs official

Official uses a **computed template** (`tool-subagent/src/index.ts:131-160`, `providerWording`) that branches on
`provider.inheritsParentContext` so wording is never false. Ours uses hand-written string arrays per tool.

Style check against the official habit:

| Tool | Opens with an imperative naming the effect | States the cost/side effect | Points at the better tool when one exists |
|---|---|---|---|
| `agent_dispatch` | ✅ "Dispatch one task to an EXTERNAL coding agent…" | ✅ | ✅ "prefer `subagent`/`subagent_fork` for anything an in-harness child can do" |
| `agent_roundtable` | ✅ | ✅ (member-accurate variant) | ✅ |
| `agent_sessions` / `session_read` | ✅ | — (read-only, correctly omitted) | — |
| `agent_import_scan` / `agent_import` | ✅ | ✅ (import writes a session) | — |

### The `COST_WARNING` duplication — already resolved

The Lead flagged this as a near-miss. At current HEAD it is **already fixed**, with the reasoning recorded in a
comment (`src/tools.js:475-478`):

```js
// COST_WARNING says "the target agent"; for a roundtable every member is
// a target, so one member-accurate sentence replaces both the shared
// warning and the duplicate that repeated it.
'Every member spends its own quota and may read or write files in its cwd; confirm before important work.',
```

So `agent_dispatch` keeps `COST_WARNING` (`:378`) and `agent_roundtable` carries its own member-accurate sentence
(`:478`) — **not** both. There is no duplication left, and **no action needed**. This confirms the Lead's instinct
that the two sentences are "same warning, different context": the fix kept both registers deliberately.

**Verdict: no change.** Any merge would either lose the "every member" accuracy or reintroduce the duplicate.

---

## Q5 — Slimming candidates (with criteria)

Criteria columns: **call sites** (occurrences in `src/tools.js`), **tests** (direct test refs / indirect behavioural
coverage), **contract?** (is it model-visible or part of a persisted value?).

| # | Item | Location | Verdict | Call sites | Tests | Contract? | Risk | Effort |
|---|---|---|---|---|---|---|---|---|
| 1 | `renderDispatch` inline-able into `agent_dispatch` | `:227-236` (10 lines) | **Merge** (optional) | 1 | indirect (tool value round-trip) | no | low | S |
| 2 | `openOutput` doc-comment block | `:211-216` (6 lines of JSDoc for a 2-line fn) | **Trim** | 6 | n/a | no | none | S |
| 3 | `withArgValidation` `integer` + `array` branches | `:281-287` (7 lines) | **KEEP — reachable** | `rounds` integer `:486`, `providers` array `:484` | yes | no | **would regress** | — |
| 4 | `withArgValidation` `number` branch | `:280` | **KEEP — reachable** | four `number` params: `timeoutMs` `:396`, `limit` `:590`,`:654`, `maxChars` `:624` | yes | no | would regress | — |
| 5 | `lossless()` | `:28-30` | **KEEP** | 13 | yes (`tools.test.js:216,382`) | yes (persisted value) | **high** | — |
| 6 | `labelOf()` | `:37-41` | **KEEP** | 5 | yes (`http.test.js:500`, `tools.test.js:238`) | yes (job label) | med | — |
| 7 | `resolveCwd()` | `:191-196` | **KEEP** | 4 | indirect | yes (cwd passed to CLI) | med | — |
| 8 | `params()` | `:203-209` | **KEEP** | 7 | yes (schema shape test) | **yes — model-visible schema** | high | — |
| 9 | `createSemaphore` | `:48-119` | **KEEP** (see Q2) | 2 | yes (`tools.test.js` concurrency tests) | config-facing | high | — |
| 10 | `startJob` / `jobHooks` | `:126-176` | **KEEP** | 3/3 | yes (`tools.test.js` job tests) | yes (job contract) | high | — |
| 11 | per-tool `presentCall` blocks | 6 sites | **KEEP** | 1 each | yes | **yes — UI card** | high | — |

**Realistic slimming: items 1–2 only, ≈ 15–18 lines net** (749 → ~732). Everything else is load-bearing.

### Explicitly: "looks deletable but is NOT"

These four are the ones a future maintainer is most likely to remove by mistake. Each has a named test that fails.

1. **`withArgValidation`** — Q1. `register()` does not validate arguments. Test: `tools.test.js:670-693`.
2. **`lossless()`** — the tool registry snapshots values as **lossless JSON**; a `undefined`/function/symbol leaking
   into a returned object makes the registry reject the result. 13 call sites. Test: `tools.test.js:216`.
3. **`params()`** — builds the *model-visible* schema. Deleting or "simplifying" it changes the tool contract the
   model reads. Test: `tools.test.js:140-168` asserts every tool's `parameters` is a complete object schema with a
   `required` array and no DSL `required: true` markers.
4. **The `integer`/`array` branches inside `withArgValidation`** — they look like defensive dead code (a previous
   comment even said so) but `rounds: {type:'integer'}` and `providers: {type:'array', items:{type:'string'}}` are
   live. Removing them silently lets `rounds: "2"` through to `Math.min(3, "2")` coercion.

---

## Recommendations

1. **Do not touch Q1–Q4 items.** The evidence says they are correct as written.
2. **Optional S-effort cleanup:** inline `renderDispatch` into `agent_dispatch`, trim the `openOutput` JSDoc block.
   Net ≈ 15 lines. Low value — the file's length is dominated by six schema declarations, not by helpers.
3. **Documentation-only fix (recommended):** state in the config docs that `defaults.maxConcurrent` is
   **per plugin instance**, not per Session or per Agent tree — the distinction from official `maxActiveSubagents`
   that Q2 surfaced.
4. **If the plugin ever registers a `SubagentProvider`** (O1 §3), revisit `createSemaphore`: it would then be
   redundant for the tool path but still required for the panel/HTTP path, which has no Agent and therefore no pool.

## Method note

All line numbers are against the working tree at audit time (749 lines). Test baseline: `node --test
'tests/*.test.js'` → **262 pass, 0 fail**; `node --check src/tools.js` → OK. Both re-run after writing this file;
no source change was made, so the counts are unchanged by definition.
