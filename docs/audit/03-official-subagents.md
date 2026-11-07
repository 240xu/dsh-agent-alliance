# Audit C — official Codex / Claude Code subagent bundles

Repo: `dsh-agent-alliance` @ `e15fcf8` (v0.2.0). Read-only audit.
Host DSH: `0.2.1-rc.2` at `/usr/local/lib/node_modules/@deepseek-ai/dsh`.

**Status: in progress** — sections are appended as each finding is confirmed.

## Verdict summary

_(placeholder — filled last)_

## Findings

_(appended below)_

## Authorities used

| Role | Path |
|---|---|
| Provider (codex) | `/home/ova/dsh/packages/subagent/subagent-codex/` — `README.md`, `cordis.patch.yml`, `package.json`, `src/index.ts`, `src/run.ts` |
| Provider (claude-code) | `/home/ova/dsh/packages/subagent/subagent-claude-code/` — same set |
| Seam | `.../dsh-subagent/lib/types/types.d.ts`, `.../lib/types/index.d.ts`, `.../lib/types/manager.js`, `.../lib/types/out-of-process.d.ts` |
| Official model-facing tool | `.../dsh-tool-subagent/lib/index.js`, `README.md` |
| Availability | `.../dsh-plugin-manager/lib/index.js`, `.../dsh-app-boot/lib/index.js` (`ON_DEMAND_BUNDLES`, `OFFICIAL_ON_DEMAND_CATALOG`) |

Runtime DSH is `0.2.1-rc.2`; the source checkout is `dsh-v0.2.1-alpha.2`. Neither bundle is installed here
(`@deepseek-ai/dsh-subagent-{codex,claude-code}` absent from `node_modules`), which is exactly the state that
produces `availability: "missing"` — verified live:

```
plugin_manager(list_bundles) →
  {"name":"@deepseek-ai/dsh-subagent-claude-code","official":true,"availability":"missing",
   "installTarget":{"spec":"@deepseek-ai/dsh-subagent-claude-code@0.2.1-rc.2","version":"0.2.1-rc.2"},
   "enabled":false,"installed":false,"optional":false,"removable":false,"rows":[],"overrides":[]}
  {"name":"@deepseek-ai/dsh-subagent-codex", ... same ...}
```

Both are `ON_DEMAND_BUNDLES` (`dsh-app-boot/lib/index.js:2407`), not `OPTIONAL_BUNDLES`, so their metadata comes
from the generated offline catalog and their `installTarget` is derived from the *running* DSH version.

---

## F1 — HIGH — `resumeSessionId` is rejected only **after** a real billed child has been started

**Plugin** `src/backend.js:232-248`:

```js
const activation = await route.service.startActivation({   // :232  ← spawns the real Codex/Claude process
  provider: providerName,
  ...
  delivery: 'caller',
})
let primary
try {
  activation.result.catch(() => {})
  if (hasResumeId(request.resumeSessionId)) throw resumeRejection(providerId, providerName)   // :248
```

The official run has already been spawned and published before the guard fires; the `finally` then disposes it.
The rejection is intentionally designed this way (the comment at `:245-246` only reasons about the promise being
dropped), so the ordering is deliberate, not incidental.

**Official authority** — `packages/subagent/subagent-codex/src/index.ts:64` and `src/run.ts` start a fresh
app-server per accepted run; `subagent-codex/README.md`:

> "**One fresh process, thread, and turn per run.** Every run spawns a fresh app-server, creates one ephemeral
> thread, and executes exactly one turn; there is no continuation, resume, or pooling."

and the same README's failure paragraph:

> "An install that omits optional dependencies, uses an unsupported platform, or loses the selected payload leaves
> the provider dormant and fails the first delegation at `initialize` …"

**Impact**: a model or user that supplies `resumeSessionId` with an official provider pays a full Codex/Claude
process start, an `initialize` handshake, and a `thread/start` / SDK `query()` — each of which spends the target's
quota and can take seconds — purely to receive an error that was knowable before the call. On a machine where the
payload is missing, the user instead sees the *provider's* `initialize` diagnostic rather than the resume message,
because `startActivation` throws first and `:248` is never reached.

**Corrected code** — hoist the guard above `startActivation`:

```js
if (hasResumeId(request.resumeSessionId)) throw resumeRejection(providerId, providerName)
const activation = await route.service.startActivation({ ... })
```

The `activation.result.catch(() => {})` on `:247` then becomes unnecessary for the resume branch (it is still
harmless as a general guard).

---

## F2 — HIGH — `available: true` is never probed: `/state` reports all four providers usable on a machine with no CLIs

**Plugin** `src/backend.js:363-372`:

```js
const cli = cliLookup(registry, providerId)
if (cli.found) {
  infos.push({ id: providerId, label: ..., kind: 'cli', available: true })   // :369 — unconditional
```

`buildProviders()` (`src/providers.js:24-27`) registers **all four** providers unconditionally, and
`registry.detect()` / `detectAll()` is never called from `index.js`, `src/http.js`, `src/tools.js`, or
`src/backend.js` — grep shows `detectAll` only in `tests/`:

```
src/provider/types.js:28   async detectAll()
tests/providers-factory.test.js:17,30   reg.detectAll()
tests/provider-types.test.js:21         reg.detectAll()
```

There is also no `enabled` check: `config.providers.zcode.enabled` defaults to `false` (`src/config.js:21`) yet
zcode is registered, resolvable and reported `available: true`.

**Official authority** — `dsh-plugin-manager/README.md` defines the vocabulary the panel should be using:

> "`availability` identifies a readable installation-provided or profile package, or `missing`; on-demand catalog
> entries exclude undeclared transitive copies. `installed` only records whether the profile declares the
> dependency."

and the live read above confirms `availability: "missing"` for both bundles.

**Impact**: `GET /__agent-alliance/state` (`src/http.js:329-332`) returns four green providers, the panel renders
`state.available` for each (`client.js:586-588`), and every provider appears in the dispatch and roundtable
pickers (`client.js:682`, `:803`, `:941`). On this machine none of `claude`/`codex`/`opencode`/`zcode` exists on
`PATH` (the plugin's own `docs/VERIFICATION-P1.md` records "本机当前**没有**安装 … 任何 CLI（`which` 全部为空）"),
so every one of those green rows is false. The user is told a capability is ready and gets a spawn error instead.

**Corrected code**: call `await registry.detectAll()` once per `/state` request (or cache it with a short TTL) and
merge its `{ available, detail }` into the rows; drop `enabled: false` providers from `providerIds()`:

```js
const detected = await registry.detectAll()
const stateOf = (id) => detected.find((d) => d.id === id)
// in list(): available: stateOf(providerId)?.available === true
//                         detail: stateOf(providerId)?.detail
```

---

## F3 — HIGH — the plugin's `agent_dispatch` duplicates the bundle's own global tool, with opposite ergonomics and an unshared concurrency gate

**Plugin** `src/tools.js:251-268` registers `agent_dispatch` with `providers: claude | codex | opencode | zcode`;
`src/backend.js:324-339` routes `provider: 'codex'` to the official provider whenever
`config.providers.codex.subagentProvider === 'codex'` and a live parent Agent exists (`src/config.js:18-19` makes
that the default).

**Official authority** — enabling the bundle *already* installs a first-class model-facing tool.
`packages/subagent/subagent-codex/cordis.patch.yml`:

```yaml
- insert:
    - id: subagent-codex
      name: '@deepseek-ai/dsh-subagent-codex'
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: codex
        toolName: subagent_codex
        maxDepth: provider-managed
```

(and `subagent-claude-code/cordis.patch.yml` identically with `provider: claude-code`, `toolName: subagent_claude_code`).

`subagent-codex/README.md`:

> "The layer registers the provider and adds `subagent_codex` to every Agent as a global tool; it starts no native
> process until delegation."

`subagent-claude-code/README.md`:

> "The layer registers the provider and adds `subagent_claude_code` to every Agent as a global tool"

So after enabling a bundle the model has **two** tools that reach the *same* provider instance:

| | official `subagent_codex` | plugin `agent_dispatch` |
|---|---|---|
| returns | `started subagent <childId>` immediately (`dsh-tool-subagent/README.md`) | blocks, returns the final answer text |
| delivery | runtime notice injected into the parent (`delivery: 'parent'`) | `delivery: 'caller'`, no notice (`src/backend.js:241`) |
| concurrency | host `maxActiveSubagents` only | plugin semaphore `defaults.maxConcurrent` (`src/tools.js:220`) |
| catalogue | `subagent/catalog` event → visible in child listings | none |
| system prompt | registered section: "Start independent delegations with \`subagent_codex\` …" | none |

The two are not just redundant; they are **contradictory**. The official tool's system-prompt section
(`dsh-tool-subagent/lib/index.js:510-518`) instructs the model to fire delegations together and continue working,
while `agent_dispatch`'s description says "Dispatch one task … and return its answer" and blocks. The official
tool also gets a competing schema in every single request, and the plugin's `maxConcurrent` gate cannot bound the
official tool at all, so a model that mixes the two exceeds the configured limit silently.

There is **no double provider registration** — the plugin registers no `ctx.subagents` provider, so
`DUPLICATE_PROVIDER` (`dsh-subagent/lib/types/index.js:385-387`) cannot trigger. The harm is at the tool layer.

**Corrected wording** in `README.md:19-22` and `docs/SPEC-v2.md:368-371` — say what the user now has:

> Enabling `@deepseek-ai/dsh-subagent-codex` gives your Agents a global `subagent_codex` tool (fire-and-forget,
> result delivered as a completion notice). `dsh-agent-alliance` does **not** replace it: it adds a *synchronous*
> variant, `agent_dispatch`, which also covers OpenCode/ZCode and returns the answer inline. Use `subagent_*` for
> parallel background delegation and `agent_dispatch` when you want the text in the tool result.

Plus one of: (a) suppress `agent_dispatch` for a provider when the official tool for it is mounted, or (b) drop
`codex`/`claude` from `agent_dispatch`'s `providers` enum when `ctx.tools.get('subagent_codex')` is non-undefined
and say so in the description.

---

## F4 — MEDIUM — `externalSessionId` on the subagent path is a DSH-minted per-run UUID, not a resumable external session

**Plugin** `src/backend.js:256`:

```js
externalSessionId: activation.childId ?? null,
```

**Official authority** — `dsh-subagent/lib/types/manager.js:415` (external admission):

```js
const pendingId = brandString(randomUUID());
```

and `types.d.ts:41-42`:

> "Stable identity of the child."
> "A managed execution; disposal addresses this exact activation, never a later resume."

`activation.childId` is generated by the DSH manager for the *external* activation; it is not Codex's thread id
nor Claude's session id, it is never registered with either product, and there is nothing to resume.

**Impact**: `src/tools.js:273` renders the header `'[' + provider + ' session ' + externalSessionId + ']'`, so the
model is shown `[codex session 8f3c…]` and the tool description (`src/tools.js:258`) tells it that
"resumeSessionId continues one of that agent's existing sessions (find ids with `agent_sessions`)". A model that
follows that instruction on the id it was just handed gets F1's wasted spawn plus a hard error. On the CLI path
the field *is* the real resumable id (`src/provider/claude.js:62` → `parsed.sessionId`), which makes the value's
meaning inconsistent across the two paths while sharing one name.

**Corrected code** — report them as different things:

```js
// subagent path
externalSessionId: null,
childId: activation.childId,
```

and render the header without the word "session" when `backend === 'subagent'`.

---

## F5 — MEDIUM — the plugin requires the user to install the bundles, but its own installation docs use a command that does not select the bundle layer

**Plugin** `docs/SPEC-v2.md:368-371`:

```
- Enable the official bundles in Settings → Plugins (or
  `dsh plugin --profile web add @deepseek-ai/dsh-subagent-codex@0.2.1-rc.2` and the same
  for `-claude-code`). The plugin detects them automatically and prefers them for tool
  delegation.
```

**Official authority** — `dsh-plugin-manager/README.md:40`:

> "A bundle toggle changes `package.json`'s ordered `dsh.profile.bundles` list. Disabling retains the dependency;
> enabling appends the bundle at the end, which can change configuration precedence. **Installation enables a new
> bundle by default.**"

That sentence describes `installBundle`, the *service* operation. `dsh plugin` is a different entry point:
`apps/cli/src/args.ts:196` documents it as "pnpm arguments, forwarded verbatim", and
`packages/boot/plugin-manager/README.md:98` separates the two — "Pnpm runs outside the HMR queue; installation
selects the bundle after pnpm succeeds" refers to the service path, while the CLI path
(`apps/cli/src/plugin.ts:105-121`) only calls `runProfilePnpm`/`runPluginCommand` and never calls `selectBundle`.

So `dsh plugin --profile web add @deepseek-ai/dsh-subagent-codex@0.2.1-rc.2` downloads the package and adds the
dependency but leaves `dsh.profile.bundles` untouched: after a restart the bundle is *installed but not selected*,
its `cordis.patch.yml` layer is not applied, and neither the provider nor `subagent_codex` exists. The user follows
the documented command, sees "added", and the plugin still reports the CLI path.

**Also wrong in the same sentence**: the version. The plugin pins `0.2.1-rc.2`, which is the *running DSH* version
here, but the source checkout is `dsh-v0.2.1-alpha.2` and the runtime resolves the target itself
(`officialBundleInstallTarget`, `dsh-plugin-manager/lib/index.js:911`). Hard-coding a runtime version invites a
`not-found` on any other release.

**Corrected wording**:

> Enable **Codex subagent** / **Claude Code subagent** in Settings → Plugins (sidebar **Plugins** page). The card
> already exists offline with `availability: missing`; turning it On installs the target offered by the running Host
> and selects its layer in one step. From a terminal, install *and then enable*:
> `dsh plugin --profile web add @deepseek-ai/dsh-subagent-codex` followed by turning it on in the same page, or set
> it directly in `~/.dsh/profiles/web/package.json` → `dsh.profile.bundles`.

---

## F6 — MEDIUM — `availability: missing` reaches the user only as a red "unavailable" dot, with no install action

**Plugin** `src/backend.js:373-382` produces `available: false` with `detail: 'no CLI provider registered'` or
`'no CLI provider registered; official subagent provider "<name>" needs a live parent agent'`. **Neither reason is
correct in the missing-bundle case.** The truth is that the *package* is not installed
(`availability: "missing"`), not that a registry entry is absent.

`src/http.js:329-332` forwards that list verbatim as `providers`; `client.js:579-588` renders it as
`aall_dot-error` + `state.unavailable` + `provider.detail`, and `client.js:682,803,841` drops every
`available !== true` entry from the dispatch/roundtable pickers. There is no `installTarget`, no link, no mention of
the Plugins page anywhere in `client.js` (grep for `install`/`Plugins` in the state tab: nothing).

**Official authority** — the Host already knows exactly what to do and says so. `plugin_manager(list_bundles)`
returns, for each missing bundle:

```json
"availability": "missing",
"installTarget": { "spec": "@deepseek-ai/dsh-subagent-codex@0.2.1-rc.2", "version": "0.2.1-rc.2" }
```

`dsh-client-ui-plugin-manager/README.md:36`:

> "On-demand Official cards are visible offline before installation. Turning one On opens the existing install
> progress dialog, installs the target offered by the running Host, and selects its layer."

and `dsh-plugin-manager/README.md:44`:

> "`listBundles` marks shipped optional bundles and on-demand catalog entries as `official`, independently of
> package installation. `availability` identifies a readable installation-provided or profile package, or
> `missing` … An absent on-demand entry carries embedded localized metadata and a host-derived `installTarget`
> containing the running DSH version and install spec, without registry access."

**Impact**: the exact state on this machine. A user reads "claude — unavailable", concludes the plugin is broken,
and has no way to learn that the fix is a single switch on a page they have not opened. The plugin also cannot be
blamed for the *provider* being absent, but it is the only surface that mentions the provider at all.

**Corrected code** (in `list()`, `src/backend.js:373-382`):

```js
infos.push({
  id: providerId,
  label: providerId,
  kind: 'cli',
  available: false,
  detail: name === undefined
    ? 'no CLI provider registered'
    : 'official subagent provider "' + name + '" is not registered — install and enable '
      + '`@deepseek-ai/dsh-subagent-' + name + '` in Settings → Plugins',
  installHint: name === undefined ? undefined : '@deepseek-ai/dsh-subagent-' + name,
})
```

and in `client.js`'s state row, render `provider.installHint` as actionable text ("Enable `…` in Settings →
Plugins") instead of a bare red dot. Optionally call `ctx.get('pluginManager')?.listBundles()` from `/state` and pass
the real `availability`/`installTarget` through, which makes the panel able to say "missing" versus "installed but
not selected" — two states the user fixes differently.

---

## F7 — LOW — `permissionMode` / `model` / `env` are never configurable from the plugin, and the docs never say where they live

**Plugin**: `src/config.js:15-31` — the whole schema is `providers.<id>.{enabled, subagentProvider,
commandTemplate, resumeTemplate}` plus `defaults` and `panel`. There is no `model`, `permissionMode`, or `env`
anywhere, and `grep -n "permissionMode\|disposeGraceMs" src/*.js` returns nothing.

That is **correct** — those are per-provider-instance settings on the *bundle's* row, and the plugin must not
duplicate them. But the README (`README.md:19-25`) tells the user to "enable it in Settings → Plugins" and stops
there; nothing explains that the model is fixed on `subagent-codex`'s row config, or which permission mode is in
force by default.

**Official authority** — `subagent-codex/README.md` configuration table:

> | `providerName` | `codex` | Non-empty registry name on `ctx.subagents`; each mounted instance needs a unique value |
> | `model` | native Codex settings | Optional non-empty model name fixed for every thread from this provider instance |
> | `env` | `{}` | Explicit child environment layered over the credential-scrubbed parent environment |
> | `permissionMode` | `never` | Native non-interactive approval and sandbox mode fixed for every thread |
> | `disposeGraceMs` | `3000` | Grace between the shared managed-range owner's termination tiers |

and `subagent-codex/src/index.ts:74-82` confirms the defaults in code (`DEFAULT_PROVIDER_NAME = 'codex'`,
`permissionMode … .default(DEFAULT_CODEX_PERMISSION_MODE)` with `DEFAULT_CODEX_PERMISSION_MODE = 'never'`,
`env: z.dict(z.string()).default({})`). `subagent-claude-code/src/index.ts:33` / `src/run.ts:56` give
`DEFAULT_PROVIDER_NAME = 'claude-code'` and `DEFAULT_CLAUDE_CODE_PERMISSION_MODE = 'dontAsk'`.

**Plugin's own defaults match, so nothing is wrong at runtime** — `src/config.js:18-19` uses exactly `'claude-code'`
and `'codex'`, which are the two official `providerName` defaults. Worth recording as checked and clean.

**Corrected wording** — add one sentence to `README.md:19-25`:

> The model, permission mode, and child environment belong to the bundle's own row, not to this plugin:
> `subagent-codex` defaults to `permissionMode: never` (no sandbox override, never asks) and inherits the native
> Codex model unless `model` is set on its row; `subagent-claude-code` defaults to `dontAsk` (deny what is not
> already authorized). Configure them under Settings → Plugins → the bundle's row, not in
> `~/.dsh/dsh-agent-alliance.json`.

---

## F8 — LOW — `maxDepth` handling is right, but for a reason the SPEC states incorrectly

**Plugin** `docs/SPEC-v2.md:120-121`:

> "**Omit `maxDepth`** — official providers report `NO_START_CAPABILITIES`, so a requested depth limit would be
> rejected as unsupported."

The rule is correct and `src/backend.js` follows it (it never passes `maxDepth`). The *reason* is stated loosely.
`NO_START_CAPABILITIES` also covers `agentOptions`, `agentPreset`, and `outputSchema`, and the rejection happens in
`assertCapabilities` before `start`:

`dsh-subagent/lib/types/out-of-process.js:48-53`:

```js
export const NO_START_CAPABILITIES = Object.freeze({
    agentOptions: false,
    agentPreset: false,
    outputSchema: false,
    depthLimit: false,
});
```

`dsh-subagent/lib/types/index.js:439-452` (`assertCapabilities`) throws
`UNSUPPORTED_CAPABILITY` for each of the four, and the JSDoc at `out-of-process.d.ts:14-19` says:

> "The capability advertisement of an out-of-process backend: NONE. A child in another process cannot honor
> parent-enforced start features (`agentOptions`/`agentPreset`/`outputSchema`/`maxDepth`), so the service rejects
> a request needing any of them before `start` runs — never accepted-then-ignored."

**Corrected wording**: "…official providers advertise `NO_START_CAPABILITIES` (`agentOptions`, `agentPreset`,
`outputSchema`, `depthLimit` all `false`), so any of those four would be rejected with `UNSUPPORTED_CAPABILITY`
before the process starts; the plugin passes none of them." No code change needed.

---

## F9 — LOW — `delivery: 'caller'` is the right choice, and the SPEC does not say what it buys

**Plugin** `src/backend.js:241` passes `delivery: 'caller'`; `docs/SPEC-v2.md:117` prescribes it without rationale.

**Official authority** — `dsh-subagent/lib/types/types.d.ts:36-37`:

> "Parent delivery notifies the model; caller delivery only returns the result. Local children always enter the
> parent catalog."

`manager.js:1061-1063` makes it concrete:

```js
notifySettlement(activation, terminal) {
    if (!activation.announced || activation.delivery === 'caller')
        return;
```

and `manager.js:434-436` shows the other observable difference — only `delivery === 'parent'` writes the durable
`subagent/catalog` row that `listChildren`/`listDescendants` read.

So for a **synchronous tool**, `'caller'` is correct: the answer is already in the tool result, and a second copy as
a `subagent-settled` user message would duplicate it in the parent's context (the official global tool uses
`delivery: 'parent'` precisely because it returns only a child id). The cost is real but acceptable: the run is
invisible to `listChildren`, so a parent Session's durable child catalog does not contain `agent_dispatch` runs.

**Corrected wording** — state the trade-off in the SPEC rather than just the value:

> `delivery: 'caller'` because this tool returns the final text inline; `'parent'` would inject a duplicate
> completion notice. The price is that these runs do not appear in the parent's durable `subagent/catalog`, so
> `listChildren` shows only delegations started through `subagent_*`.

---

## F10 — LOW — README overstates what the plugin "detects"; it never looks at the Host's bundle inventory

**Plugin** `README.md:19-22`:

> "官方后端来自这两个包，在「设置 → 插件」里启用即可，插件会自动探测："

"自动探测" (auto-detects) implies the plugin observes install/availability state. In fact `src/backend.js:55-73`
only asks `ctx.subagents.list()` for a registered provider name — which is the *right* mechanism, but it means the
plugin cannot distinguish "bundle not installed", "bundle installed but layer not selected", and "bundle selected
but the provider failed to load". All three collapse into the one misleading `detail` string from F6.

`docs/MIGRATION-0.2.md:18` repeats it: "插件启动时会探测 `ctx.subagents`，探测到就优先走官方后端，不需要额外配置。"

**Corrected wording**: "插件在运行时向 `ctx.subagents.list()` 查询是否注册了 provider `<name>`；它看不到插件市场里的安装/启用状态。若 bundle 已安装但未在 `dsh.profile.bundles` 中启用，provider 不会出现，插件会走 CLI 路径。"

---

## F11 — LOW — MIGRATION claims the official payload and the system CLI never interact; that is true only for the subagent path

**Plugin** `docs/MIGRATION-0.2.md:142-143`:

> "官方子代理包自带原生 Codex / Claude Code payload，与系统里单独装的 CLI 互不影响；
> `subagentProvider` 走官方包时不使用 `claude`/`codex` 的系统 PATH。"

The first clause is correct for the official path. `subagent-claude-code/README.md`:

> "The platform-pinned runtime starts on demand and never falls back to the host `claude` executable."

> "The provider … does not copy or filter those files, create or modify login state, inspect `PATH`, or fall back to
> a host `claude` executable."

and `subagent-codex/README.md`:

> "The provider does not … select `modelProvider` or `serviceTier`, or set a fallback."
> "The Bundle supplies the CLI but does not create an account, log in, trust a project, or rewrite Codex settings"

**But the second clause is only true while the official path is taken.** The plugin's fallback CLI providers
(`src/provider/claude.js:23-28`, `src/provider/codex.js:24-27`) hard-code Termux paths
(`/data/data/com.termux/files/usr/lib/node_modules/...`) and shell out to the host binary. The same
`~/.dsh/dsh-agent-alliance.json` config drives both paths, and a run silently switches to the CLI path whenever
`parent` is not a live Agent (`src/backend.js:78`) — e.g. everything from the Web panel. So "互不影响" is wrong as
written: the payloads do not interact, but the *plugin's choice of payload* changes per call.

**Corrected wording**: separate the two facts — "the official bundle never executes the host CLI; but `dsh-agent-alliance` still has its own CLI wrappers, which are used for panel-initiated dispatches, `resumeSessionId`, and OpenCode/ZCode. Those read the host CLIs and the host session stores."
