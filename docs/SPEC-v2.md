# dsh-agent-alliance v2 — rewrite contract

Pinned interfaces for the 0.2.0 rewrite against DSH `0.2.1-rc.2`. This file is the
authority for cross-module boundaries; modules may change internals freely but must
keep the exported names and data shapes below.

## Why

The 0.1.0 plugin was written against DSH `0.1.0-rc.6`. It is now wrong in five
independent ways:

1. **Peer dependency is unsatisfiable.** `peerDependencies: {"@deepseek-ai/dsh-tools": "^0.1.0-rc.6"}`
   excludes `0.2.x`, and `^0.1.0-rc.6` also excludes it, so `import { defineTool } from '@deepseek-ai/dsh-tools'`
   fails at runtime. Three suites fail with `ERR_MODULE_NOT_FOUND` for that reason
   (`tests/apply.test.js`, `tests/tools.test.js`, `tests/smoke.test.js`).
2. **The official experimental Codex and Claude Code subagent bundles now exist**
   (`@deepseek-ai/dsh-subagent-codex`, `@deepseek-ai/dsh-subagent-claude-code`, both
   `official: true`). Re-implementing their CLI argv, stream parsing, and session
   resume logic is duplicate maintenance that already drifted.
3. **The jobs contract changed.** `job.owner` is a `SessionId`, not an `Agent`;
   `ctx.jobs.start()` returns a `JobId` string, not a handle; polling is
   `readAt(id, from)` returning `chunks`/`next`/`lossy`, not `read(id)` returning
   `text`/`snapshot`.
4. **The session format changed.** `SESSION_FORMAT_VERSION` is `4`;
   `sessionPersistence.create(header)` takes a full immutable header and returns a
   `SessionHandle` (append/flush/close live on the handle). `assistant/chunk` no
   longer exists; assistant output is one `assistant/message` event carrying a
   `stream: AssistantStreamRecord[]`.
5. **The browser half is stale.** Sidebar DOM injection with `MutationObserver`, a
   hand-appended React root, and `require('react-dom/client')` are outside the
   current client-module contract, which expects a factory returning
   `{ inject, apply }` that registers into `main` / `sidebar.panellist` slots and
   routes copy through `ctx.locale`.

Additionally the HTTP surface is unauthenticated: every route must pass the
connection trust admission (`ctx.connection.admit` / `requestRejection`) before it
dispatches an external agent.

## Non-goals

- No runtime dependency on any `@deepseek-ai/*` package. Third-party bundles in this
  deployment are zero-dep plain ESM; that is what keeps them working across rc bumps.
- No ACP bridge script. The official bundles cover Codex and Claude Code; other ACP
  agents are mounted with `@deepseek-ai/dsh-subagent-acp` by the user.
- No new session event types. Import writes only the current `SessionEventMap` vocabulary.

## Package layout

```
index.js                    host entry: name / inject / apply(ctx, config)
client.js                   browser entry: __ModuleLoader__.load({ id: package name })
cordis.patch.yml            one inserted row `agent-alliance`
package.json                exports ".", "./client", "./locale/*.json", "./icon"
icon.svg
locale/en.json, locale/zh.json   meta.title, meta.description, panel strings
src/config.js               loadConfig(rowConfig) -> resolved config (loud validation)
src/backend.js              createBackendResolver({ ctx, registry, config })
src/providers.js            buildProviders({ config, deps }) -> CLI provider registry
src/provider/{types,claude,codex,opencode,zcode}.js   CLI providers (unchanged role)
src/runner.js               spawn-based CLI runner (unchanged role)
src/parse.js                per-CLI stdout parsers (unchanged role)
src/roundtable.js           runRoundtable / formatRoundtableText
src/http.js                 registerHttp(webServer, {...}) -> disposer
src/tools.js                registerTools(ctx, {...}) -> disposer
src/importer/convert.js     convertToDshEvents({...}) -> v4 SessionEvent[]
src/importer/persist.js     importOne / ledger helpers
tests/                      node --test
```

`src/provider/*`, `src/runner.js`, `src/parse.js` keep their current internal
contracts (`defineProvider`, `createRegistry`, `spawnCli`, `parseClaudeStreamJson`,
`parseOpencodeEvents`, `parseCodexOutput`). Only `src/importer/*`, `index.js`,
`src/tools.js`, `src/http.js`, `src/config.js` and the client half are rewritten;
`src/backend.js` is new.

## Backend resolution (the alignment with official subagents)

`src/backend.js` exports:

```js
/**
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx  plugin context
 * @param {{list(): object[], get(id: string): object}} options.registry  CLI providers
 * @param {object} options.config  resolved config
 * @returns {{ resolve(request: {provider: string, parent?: object}): Backend, list(parent?: object): BackendInfo[] }}
 */
export function createBackendResolver(options)
```

`Backend`:

```js
{
  id: string,                 // the id the model/users pass
  label: string,
  kind: 'subagent' | 'cli',
  available: boolean,
  detail?: string,
  /**
   * @returns {Promise<{ text: string, stopReason?: string, externalSessionId?: string|null,
   *                     durationMs: number, backend: 'subagent' | 'cli' }>}
   */
  async dispatch({ prompt, cwd, model, signal, timeoutMs, resumeSessionId })
}
```

Resolution order for `resolve({ provider, parent })`:

1. If `config.providers[provider].subagentProvider` names a provider registered on
   `ctx.subagents` **and** `parent` is a live Agent, return a `subagent` backend.
2. Otherwise return the CLI backend from `registry` (throws `unknown provider: <id>`
   exactly as today).

Rules for the `subagent` backend:

- Start through `ctx.subagents.startActivation({ provider, label, request, signal, delivery: 'caller' })`.
  Never call a provider's `start()` directly; the service owns lifecycle and limits.
- `request` is `{ prompt: [{ type: 'text', text }], parent }` plus `cwd` when supplied.
  **Omit `maxDepth`** — official providers report `NO_START_CAPABILITIES`, so a
  requested depth limit would be rejected as unsupported.
- Resolve with `activation.result`, then **always** `await activation.dispose()` in a
  `finally`. Return `externalSessionId = activation.childId`.
- Map `result.output` text blocks to `text`; `stopReason !== 'completed'` carries
  `diagnostic` through as the thrown error message when `text` is empty.
- `resumeSessionId` is unsupported on this path: reject with an explicit message that
  says to use the CLI provider for external-session resume (official providers are
  one-shot).

HTTP callers have no Agent, so `registerHttp` must resolve without `parent` and
therefore always takes the CLI path. Every HTTP payload reports `backend` so the panel
can label which path ran.

## Config

`src/config.js` exports `loadConfig(rowConfig)` and `defaultConfig()`.

Precedence: row `config` from `cordis.patch.yml` > `~/.dsh/dsh-agent-alliance.json`
(read only when `legacyConfigFile !== false`) > built-in defaults. Every layer is
deep-merged; invalid types or a malformed JSON file throw with the file path.

```js
{
  providers: {
    claude:   { enabled: true, subagentProvider: 'claude-code' },
    codex:    { enabled: true, subagentProvider: 'codex' },
    opencode: { enabled: true },
    zcode:    { enabled: false, commandTemplate: '', resumeTemplate: '' },
  },
  defaults: { timeoutMs: 300000, maxConcurrent: 3, defaultCwd: '' },
  panel: { enabled: true },
  legacyConfigFile: true,
}
```

`subagentProvider` is optional; omitting it keeps a provider CLI-only.

## Tools

`src/tools.js` exports `registerTools(ctx, { resolver, registry, config, home })`.

Registered with raw `ctx.tools.register({...})` definitions, **not** `defineTool`:

- `parameters` is a full JSON-Schema object
  (`{ type: 'object', additionalProperties: false, properties: {...}, required: [...] }`),
  because the registry hands `parameters` to the model verbatim.
- `output` is `{ schema, render }`; `schema` must be a supported object schema
  (`{ type: 'object', additionalProperties: true }` is accepted).

Tool set (names unchanged from 0.1.0):

| Tool | Notes |
|---|---|
| `agent_dispatch` | prefers the official backend when a parent Agent exists; `background: true` starts a job |
| `agent_roundtable` | fans out across resolved backends; `rounds` clamps to 1..3 |
| `agent_sessions` | CLI provider history only |
| `agent_session_read` | CLI provider history only |
| `agent_import_scan` | CLI provider history + ledger import state |
| `agent_import` | writes a v4 session through `src/importer/persist.js` |

Background jobs:

```js
const jobId = ctx.jobs.start({
  kind: 'agent-alliance',
  label,
  owner: exec.agent?.sessionId,   // SessionId, NOT the Agent
  outputLimitBytes,
  run(job) {
    // job.append(text) / job.updateProgress(line) are available
    return { cancel(reason) { ac.abort(...) }, done }   // JobHooks
  },
})
```

`ctx.jobs.start()` returns the id string. When `ctx.jobs` is unavailable the tool
runs inline and returns the foreground result instead of a job id.

Every tool description keeps the existing cost warning: a dispatch spends the target
agent's quota and may read or write files in its cwd; confirm before important work.

## HTTP

`src/http.js` exports `registerHttp(webServer, { ctx, resolver, registry, config, home })`
returning the disposer from `webServer.register`.

Routes are registered with `kind: 'prefix'`, `path: '/__agent-alliance'`. **Every
handler first runs trust admission**:

```js
function rejectionFor(ctx, req) {
  let connection
  try { connection = ctx.get('connection') } catch { connection = undefined }
  if (connection === undefined) return undefined
  if (typeof connection.admit === 'function') {
    const admission = connection.admit({ headers: req.headers })
    if (admission === undefined) return undefined
    return typeof admission === 'object' && admission !== null ? admission.rejection : 403
  }
  if (typeof connection.requestRejection === 'function') {
    return connection.requestRejection({ headers: req.headers })
  }
  return 503
}
```

Responses are JSON `{ ok: true, ... }` on success and
`{ ok: false, error, code? }` with a matching status on failure.

| Method + path | Purpose |
|---|---|
| `GET /state` | provider list (id, label, kind, available, detail) + recent dispatches |
| `GET /sessions?provider=&query=&limit=` | external session listing with `imported` flag |
| `GET /session-content?provider=&id=&maxChars=` | one external session transcript |
| `POST /import` | `{ provider, sessionId }` -> `importOne` result |
| `POST /dispatch` | `{ provider, prompt, cwd, model, resumeSessionId }` -> CLI-backend result |
| `POST /roundtable` | starts an **unowned** job, returns `{ jobId }` |
| `GET /tasks` | `{ tasks: JobView[] }` for kind `agent-alliance` |
| `GET /tasks/output?id=&from=` | `readAt` projection: `{ chunks, next, lossy, job }` |
| `POST /tasks/kill` | `{ id, reason }` -> `{ outcome }` |

Panel-initiated work uses **unowned** jobs (no Agent identity): `ctx.jobs.start({ kind, label, run })`.
`jobs.list(undefined)` and `jobs.readAt(id, from)` see unowned jobs, so the panel needs
no session binding. Cancellation is `jobs.kill(id, undefined, reason)`.

## Importer (current session format)

`convertToDshEvents({ id, cwd, createdAt, title, turns })` returns an array of v4
events with `seq` equal to the array index starting at 0 and lossless-JSON data.

Per turn `n` (1-based), in this order:

1. `turn/start` `{ turn }`
2. `step/start` `{ turn, step: 1 }`
3. `user/message` (when the turn has user text) with
   `{ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }`
   and surface intent `{ surfaceOp: 'append' }`
4. `assistant/message` — **always before** any `tool/call` in the turn. Its `content`
   advertises every tool call in that turn, then carries the assistant prose:
   `content: [{ type: 'tool-call', id: callId, name, arguments: <raw JSON string> }, …, { type: 'text', text }]`
   (text block omitted when the turn has no prose), with
   `message = { id, role: 'assistant', source: { kind: 'model', provider, model }, content }`,
   `stream = [{ type: 'text-chunks', time0, index: 0, dt: [], texts: [text] }]`
   (omit `stream` entirely for a tool-only turn with no text), surface intent `{ surfaceOp: 'append' }`
5. per tool call: `tool/call` `{ turn, step: 1, callId, name, arguments: <JSON string> }`,
   whose `name`/`arguments` must be byte-identical to the advertising block, then
   `tool/result` `{ turn, step: 1, message }` with
   `message = { id, role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
                content: [{ type: 'text', text }], isError }`
   and `{ surfaceOp: 'append', sourceEventSeqs: [callSeq] }`
6. `step/end` `{ turn, step: 1 }`
7. `turn/end` `{ turn, reason: { kind: 'completed' } }`

Three rules here are enforced by the installed validators and are not stylistic:

- **No `tool-result` wrapper.** `dsh-session-format-v3-to-v4` rejects any stored content
  containing a `{ type: 'tool-result' }` block ("must not contain a released tool-result
  wrapper"); v4 carries `isError` on the message and plain text blocks in `content`.
- **Tool calls must be advertised first.** `assertReleasedV4Relationships` (run on every
  read by `dsh-session-persistence-jsonl`) throws
  "tool/call <id> has no advertised tool lifecycle" unless an earlier
  `assistant/message` declared `{ type: 'tool-call', id, name, arguments }`.
- **`dt` is a gap array.** `dsh-llm`'s stream expansion requires
  `dt.length === texts.length - 1`, so a single text fragment needs `dt: []`.

Finally one `session/title` `{ title, messageSeqs, source: { kind: 'fallback' } }`,
where `messageSeqs` lists the `user/message` seqs.

`importOne(ctx, { registry, provider, externalId, home })` writes through the current
host API:

```js
const handle = await ctx.sessionPersistence.create({
  version: 4, id: SessionId, createdAt, cwd, isSeeded: false,
})
await handle.append(events)
await handle.flush()
await handle.close()
```

`version` must be `4`. Do **not** call `sessionPersistence.append(id, events)`; that
method does not exist on the service. After a successful flush, warm the projection
cache (`ctx.sessionProjectionCache?.coldSnapshot(id)`, ignored on failure) and attach
the session to a workspace with `ctx.workspaceRegistry.resolveByPath(cwd)` plus
`workspace.insertSessionBefore(sessionId)` when `cwd` is a real non-home directory.

Ledger stays under `<home>/agent-alliance/imports.json` keyed by `provider:externalId`,
written atomically (temp file + rename) and idempotent.

## Client half

`client.js` registers the package id and returns a plugin object:

```js
window.__ModuleLoader__.load({
  id: 'dsh-agent-alliance',
  factory(require) {
    const React = require('react')
    // ... components ...
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind('agentAlliance')
        ctx.effect(() => ctx.locale.register('agentAlliance', { zh: DICT.zh, en: DICT.en }), '...')
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'agent-alliance', locale: 'agentAlliance' }, Page))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'agent-alliance', order: 30, locale: 'agentAlliance',
            label: () => t('panel') }, Icon))
      },
    }
  },
})
```

Rules:

- Only `require('react')` plus plain globals. No `react-dom/client`, no `document.body`
  appending, no `MutationObserver`, no sidebar DOM injection.
- Every visible string goes through `ctx.locale` dictionaries (`zh` + `en`).
- Only `--dsw-alias-*` theme tokens for layout/color. Icons may carry their own artwork.
- Data comes from `fetch('/__agent-alliance/...', { credentials: 'same-origin', cache: 'no-store' })`.
- A failed request renders an inline error row with a retry affordance, never a blank page.

## Testing

`node --test tests/*.test.js` must be green with **no** DSH package resolvable.

- `tests/smoke.test.js` — host exports `name`/`inject`/`apply`; client entry declares the
  package id and an `apply`-bearing factory.
- `tests/config.test.js` — defaults, file+row merge precedence, loud errors.
- `tests/backend.test.js` — resolver prefers a registered official provider when a parent
  Agent exists, falls back to CLI without one, and rejects `resumeSessionId` on the
  subagent path; the fake activation is disposed exactly once.
- `tests/tools.test.js` — raw definition shapes (JSON-Schema `required` array), job start
  receives `owner: <session id>` and returns the id string, inline fallback without jobs.
- `tests/http.test.js` — admission rejection short-circuits before dispatch; every route
  reports `{ ok }`; task routes use `readAt`.
- `tests/importer.test.js` — v4 event stream: contiguous seqs, `assistant/message` instead
  of `assistant/chunk`, `tool/result.message` carries `role: 'tool'` + `toolCallId`,
  surface intent on every surface event, and `handle.append/flush/close` called in order.
- `tests/manifest-guard.test.js` — client declaration implies a present, loadable
  `./client` entry (kept, retargeted at `client.js`).
- Existing provider/parse/runner/roundtable suites stay green with their current fixtures.

## Migration notes for users

- Enable the official bundles in Settings → Plugins (or
  `dsh plugin --profile web add @deepseek-ai/dsh-subagent-codex@0.2.1-rc.2` and the same
  for `-claude-code`). The plugin detects them automatically and prefers them for tool
  delegation.
- The ACP bridge script is gone. Mount `@deepseek-ai/dsh-subagent-acp` for OpenCode and
  point `providers.opencode.subagentProvider` at the registered provider name.
- `~/.dsh/dsh-agent-alliance.json` keeps working; set `legacyConfigFile: false` to make
  the patch row authoritative.
