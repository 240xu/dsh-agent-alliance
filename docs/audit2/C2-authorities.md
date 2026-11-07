# C2 — Framework authorities from the installed DSH 0.2.1-rc.2 tree

Verification of every framework citation our audits rely on. Each claim is
checked against the installed packages and, where useful, the source checkout.

- **Installed tree:** `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
- **Source checkout:** `/home/ova/dsh/packages/`
- **Method:** exact `grep -n` / `sed -n` quotation; line numbers are from the installed `lib/` files.

Status: skeleton first, citations appended as each is confirmed.

## Summary

| # | Claim | Verdict |
|---|---|---|
| 1 | jobs throw + `servesOwner` + sole `attachController` caller | _pending_ |
| 2 | `ToolExecutionInput.agent` optional + copy site | _pending_ |
| 3 | `NO_START_CAPABILITIES` + rejection assertion | _pending_ |
| 4 | three v4 session-format throws | _pending_ |
| 5 | `WebRoute` prefix semantics + `/__agent-allianceX` | _pending_ |
| 6 | 0.2.2-era upstream changes | _pending_ |

---

<!-- SECTIONS APPENDED BELOW -->
## 1. Jobs: the "no job controller serves this agent" throw, `servesOwner()`, and who attaches a controller

**Verdict: CORRECT.** The cited line number is exact.

### The throw — `dsh-jobs-local/lib/index.js:414`

```js
		if (!this.servesOwner(owner)) throw new Error("background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)");
```

It is the first statement of `start()` after `resolveOwner`, so it runs before any
job id is issued or state is touched
(`dsh-jobs-local/lib/index.js:412-414`):

```js
	start(spec) {
		const owner = this.resolveOwner(spec.owner);
		if (!this.servesOwner(owner)) throw new Error("background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)");
```

### What counts as a serving controller — `dsh-jobs-local/lib/index.js:545-556`

```js
	/**
	* Whether an attached job controller can collect and stop work owned by
	* `owner`. The global layer holds every controller attached from an unscoped
	* context — a host composition's own controls — and therefore serves every
	* owner; a scoped controller serves exactly the agents composed under it.
	* @param owner - the job's owner, or undefined when unowned work.
	* @returns whether some reachable controller serves the owner.
	*/
	servesOwner(owner) {
		if (!this.layers.global.controllers.isEmpty()) return true;
		return this.layers.chainLayers(owner === void 0 ? void 0 : scopeOf(owner.ctx)).some((layer) => !layer.controllers.isEmpty());
	}
```

Two acceptance paths: any controller attached from an **unscoped** context serves
every owner (`global.controllers`), otherwise at least one controller must sit in
the owner's scope chain. Note `owner === void 0` (an **unowned** job) still needs a
serving controller — the check is not owner-specific.

`attachController` itself (`dsh-jobs-local/lib/index.js:528-531`):

```js
	attachController(name) {
		const token = Symbol(name);
		return this.layers.effect(this.ctx, (layer) => layer.controllers.append(token), { label: "jobs.attachController()" });
	}
```

### Sole production caller: **yes**, `dsh-tool-jobs`

Whole-installed-tree search (`grep -rn attachController` over
`/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`) returns
exactly four hits, of which one is the definition and one is a docs catalogue string:

| File:line | Kind |
|---|---|
| `dsh-jobs-local/lib/index.js:528` | definition |
| `dsh-jobs-local/lib/index.js:530` | the definition's own `layers.effect` |
| `dsh-tool-cordis/lib/types/api-catalog.js:1351` | quoted signature inside a docs catalogue (`'abstract attachController(name: string): () => void'`) |
| `dsh-tool-jobs/lib/index.js:256` | **the only production call** |

```js
	ctx.jobs.attachController("tool-jobs");
```

The source checkout agrees — every other hit is a test or the abstract
declaration (`packages/jobs/tool-jobs/src/index.ts:247` is the only production
call site; the rest are `packages/**/tests/*.spec.ts`, `jobs/src/index.ts:192`
abstract, `jobs-local/src/index.ts:342` definition, `tool-cordis/src/api-catalog.ts:1400`
catalogue string).

**Consequence for us:** without `@deepseek-ai/dsh-tool-jobs` in the composition,
`ctx.jobs.start(...)` throws this exact error — for owned *and* unowned jobs. Our
plugin's fallback ("run inline when `ctx.jobs` is absent") only covers a *missing
service*; it does not cover a mounted `jobs` service whose controller is missing.

## 2. `ToolExecutionInput.agent` is optional, and the registry copies it from the caller

**Verdict: CORRECT**, with one precision: the field lives on
`ToolExecutionInput` (which `ToolExecution` and `ToolRunContext` extend), so the
optionality reaches `execute(args, exec)`'s `exec` too — but the *copy* is a
conditional spread in `createExecution`, not a plain field copy.

### The declaration — `dsh-tools/lib/types/index.d.ts:229`

```ts
    /** The agent on whose behalf the call runs (set by the agent loop). */
    readonly agent?: Agent;
```

Inside `ToolExecutionInput` (`dsh-tools/lib/types/index.d.ts:216-243`), whose other
members are `callId`, `name`, `arguments`, `signal` (required) plus optional
`rootCallId`, `schema`, `agent`, `parent`.

### It reaches the tool body — `dsh-tools/lib/types/index.d.ts:282` and `:305`

```ts
export interface ToolExecution extends ToolExecutionInput {
```

```ts
export interface ToolRunContext extends ToolExecution {
```

### The copy from the caller — `dsh-tools/lib/types/index.js:783` and `:802`

```js
        const agent = exec.agent;
```

```js
            ...agent !== undefined ? { agent } : {},
```

The spread is **conditional**, so an agent-less caller produces an execution
object with **no `agent` key at all** rather than `agent: undefined`
(`...agent !== undefined ? { agent } : {}`). Tools must therefore treat
`exec.agent` as possibly missing — `exec.agent?.sessionId` is the correct read.

### The tool body receives that same object — `dsh-tools/lib/types/index.js:959`

```js
            const returned = await tool.execute(exec.arguments, exec);
```

### Secondary occurrence — `dsh-tools/lib/types/index.d.ts:265`

`PtcDispatchLog.agent?: Agent` is a *different* type (the PTC dispatch log), also
optional:

```ts
    /** The calling agent (the scope routing key and the spill owner), when the outer call has one. */
    readonly agent?: Agent;
```

An audit citing "`dsh-tools` declares `agent` optional" is right; if it cites line
229 it is citing `ToolExecutionInput`, which is the one that matters for tools.
