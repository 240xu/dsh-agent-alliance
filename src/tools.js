// src/tools.js — the model-facing tools: agent_dispatch / agent_roundtable /
// agent_sessions / agent_session_read / agent_import_scan / agent_import.
//
// Registrations use raw `ctx.tools.register({ ... })` because the registry hands
// `parameters` to the model verbatim, so each definition carries a complete
// JSON-Schema object. Every description keeps the quota/cwd warning: a dispatch
// spends the target agent's quota and may read or write files in its cwd.
//
// Background work goes through `ctx.jobs.start(spec)`, which returns a JobId
// string; the job owner is the caller's SessionId string, never the Agent.
// Without `ctx.jobs` the same call runs inline and returns its foreground value.

import { runRoundtable, formatRoundtableText } from './roundtable.js'
import { loadLedger, importOne, sourceKey } from './importer/persist.js'

/** Cost and side-effect warning repeated in every tool description. */
const COST_WARNING = 'This spends the target agent\'s quota and it may read or write files in its cwd; confirm before important work.'

/**
 * Strip values that are not lossless JSON (undefined, functions, symbols) so the
 * registry can persist and replay the canonical tool value.
 * @param {unknown} value arbitrary tool value
 * @returns {unknown} lossless JSON projection
 */
function lossless(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

/**
 * Trim a prompt to a one-line label for job titles and UI cards.
 * @param {unknown} prompt raw prompt
 * @returns {string} flattened, length-bounded label
 */
function labelOf(prompt) {
  const text = String(prompt ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 60 ? text.slice(0, 60) + '…' : text
}

/**
 * Bounded concurrency gate for external dispatches. A signal that aborts while
 * queued rejects immediately instead of holding a slot.
 * @param {number} limit maximum concurrent runs
 * @returns {{ run(signal: AbortSignal|undefined, fn: () => Promise<unknown>): Promise<unknown> }} gate
 */
function createSemaphore(limit) {
  let active = 0
  const queue = []
  return {
    run(signal, fn) {
      // The queued branch below rejects an already-aborted signal, but the fast
      // path used to take a free slot and launch fn() regardless. The tool
      // pipeline happens to refuse an aborted call before the body runs
      // (`dsh-tools` resolves ABORTED_BEFORE_DISPATCH first), so this guard is
      // redundant on the model-tool path — but the panel's HTTP handlers call
      // dispatch without any pipeline in front of them, and a signal can also be
      // aborted between admission and the gate. Keep it as the one place that
      // guarantees no external process starts for a cancelled call.
      if (signal?.aborted === true) {
        return Promise.reject(new Error('aborted before start (maxConcurrent=' + limit + ')'))
      }
      return new Promise((resolveRun, rejectRun) => {
        let started = false
        const entry = {
          begin() {
            if (started) return
            started = true
            // A promoted queue entry takes the slot its predecessor just freed.
            // Without this the counter only ever decrements on completion, so
            // `active` drifts below the true in-flight count and each later
            // batch exceeds `limit` (measured: 2 -> 4 on the second roundtable).
            active += 1
            if (signal && onAbort) signal.removeEventListener('abort', onAbort)
            let pending
            try {
              pending = Promise.resolve(fn())
            } catch (error) {
              pending = Promise.reject(error)
            }
            pending.then(resolveRun, rejectRun).finally(() => {
              active -= 1
              if (queue.length > 0) queue.shift().begin()
            })
          },
        }
        function onAbort() {
          const index = queue.indexOf(entry)
          if (index >= 0) queue.splice(index, 1)
          if (signal) signal.removeEventListener('abort', onAbort)
          rejectRun(new Error('aborted while queued (maxConcurrent=' + limit + ')'))
        }
        entry.onAbort = onAbort
        if (active < limit) {
          // `begin()` owns the increment so a promoted entry is counted too.
          entry.begin()
          return
        }
        queue.push(entry)
        if (signal) {
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
      })
    },
  }
}

/**
 * Read one optional Cordis service without declaring it in `inject`.
 *
 * `ctx.get(name)` returns undefined for a service this plugin did not inject.
 * A bare property read would throw "cannot get property ... without inject", so
 * it is only attempted as a fallback for fake contexts (tests, plain objects).
 * @param {object} ctx plugin context
 * @param {string} service service name
 * @returns {object|undefined} the service, or undefined when absent
 */
function serviceOf(ctx, service) {
  if (typeof ctx?.get === 'function') {
    try {
      const resolved = ctx.get(service)
      if (resolved !== undefined) return resolved
    } catch {
      // `get` threw for a service outside the injected set: treat as absent.
    }
  }
  try {
    return ctx?.[service] ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Report through the plugin logger when the context offers one.
 *
 * `logger` is a Cordis built-in accessor, not a registered service, so
 * `ctx.get('logger')` is always undefined; only the property access works.
 * @param {object} ctx plugin context
 * @param {string} message diagnostic text
 * @returns {void}
 */
function warn(ctx, message) {
  try {
    ctx?.logger?.warn?.(message)
  } catch { /* a context without a logger must not break the caller */ }
}

/**
 * Start one background job through the jobs service.
 *
 * `jobs.start()` throws when the composition mounts `ctx.jobs` but no job
 * controller serves the owner: `dsh-jobs-local` requires a controller, which
 * only `dsh-tool-jobs` or an equivalent `attachController` caller provides.
 * Callers treat `undefined` as "run this inline", so a refused start must
 * degrade instead of escaping as an exception.
 * @param {object} ctx plugin context; `jobs` may be absent or unusable
 * @param {object} spec `{ kind, label, owner?, outputLimitBytes?, run(job) }`
 * @returns {string|undefined} the JobId string, or undefined when the job cannot start
 */
function startJob(ctx, spec) {
  const jobs = serviceOf(ctx, 'jobs')
  if (jobs === undefined || jobs === null || typeof jobs.start !== 'function') return undefined
  try {
    return jobs.start(spec)
  } catch (error) {
    const message = String(error?.message || error)
    // Only the missing-controller refusal may degrade to inline execution. A
    // capacity cap ("background job limit reached") or an invalid spec is a
    // real refusal: silently running inline would spend up to the foreground
    // budget with no job id to cancel.
    if (!message.includes('no job controller serves')) throw error
    warn(ctx, 'agent-alliance: no job controller in this composition; running inline instead of background')
    return undefined
  }
}

/**
 * Build the JobHooks for one background producer.
 *
 * `cancel` aborts the produced work; `done` never rejects, so a broken dispatch
 * settles the job `failed` instead of failing the job substrate.
 * @param {AbortController} controller cancellation of the produced work
 * @param {Promise<{ status: string, detail?: string, result?: string }>} produced
 *   promise settling with the JobOutcome
 * @returns {{ cancel(reason?: string): void, done: Promise<object> }} JobHooks
 */
function jobHooks(controller, produced) {
  return {
    cancel(reason) {
      controller.abort(new Error(reason || 'cancelled'))
    },
    done: Promise.resolve(produced).then(
      (outcome) => outcome,
      (error) => ({ status: 'failed', detail: String(error?.message || error).slice(-500) }),
    ),
  }
}

/**
 * Resolve the configured default cwd for a call.
 * @param {object} defaults resolved `config.defaults`
 * @param {unknown} requested cwd supplied by the model
 * @returns {string|undefined} cwd to use, if any
 */
function resolveCwd(defaults, requested) {
  const value = typeof requested === 'string' && requested !== '' ? requested : defaults.defaultCwd
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The JSON-Schema parameter block shared by definitions, kept as a helper so
 * every tool is guaranteed a complete object schema.
 * @param {Record<string, object>} properties JSON-Schema property nodes
 * @param {string[]} [required] required property names
 * @returns {object} object-rooted JSON Schema
 */
function params(properties, required = []) {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  }
}

/**
 * The output declaration shared by tools whose value is an open object.
 * @param {(args: any, value: any) => Array<{ type: 'text', text: string }>} render content projector
 * @returns {{ schema: object, render: Function }} output declaration
 */
function openOutput(render) {
  return { schema: { type: 'object', additionalProperties: true }, render }
}

/**
 * Render one dispatch-like result as a single text block.
 * @param {string} header leading line naming the backend and session
 * @param {unknown} value dispatch value
 * @returns {Array<{ type: 'text', text: string }>} content blocks
 */
function renderDispatch(header, value) {
  if (value !== null && typeof value === 'object' && typeof value.text === 'string') {
    const text = value.text.length > 4000 ? value.text.slice(0, 4000) + '\n…(truncated)' : value.text
    return [{ type: 'text', text: header + '\n' + text }]
  }
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * Register every model-facing tool of the plugin.
 *
 * Each registration returns a disposer that the plugin's fiber owns; the caller
 * wraps this function in `ctx.effect()` so an unload unregisters all six tools.
 * @param {object} ctx plugin context; uses `ctx.tools`, `ctx.jobs`, and `ctx.get`
 * @param {object} options tool dependencies
 * @param {{ resolve(request: object): object, list(parent?: object): object[] }} options.resolver
 *   backend resolver; `resolve` returns a backend with `dispatch(request)`
 * @param {object} options.registry CLI provider registry (`list()` / `get(id)`)
 * @param {object} options.config resolved configuration
 * @param {object} [options.io] context handed to the importer, whose optional
 *   host services are resolved without a bare property read
 * @param {string} [options.home] DSH home directory for the import ledger
 * @returns {() => void} disposer unregistering every tool this call registered
 */
export function registerTools(ctx, { resolver, registry, config, home, io }) {
  const defaults = config?.defaults || {}
  const defaultTimeout = Number(defaults.timeoutMs) || 300000
  const gate = createSemaphore(Math.max(1, Number(defaults.maxConcurrent) || 3))
  const disposers = []

  /**
   * Dispatch one prompt to one backend, in the foreground.
   * @param {object} backend resolved backend
   * @param {string} providerId provider id reported to the caller
   * @param {object} args tool arguments
   * @param {AbortSignal|undefined} signal caller cancellation
   * @returns {Promise<object>} lossless dispatch value
   */
  async function dispatchForeground(backend, providerId, args, signal) {
    const startedAt = Date.now()
    const result = await gate.run(signal, () => backend.dispatch({
      prompt: String(args.prompt),
      cwd: resolveCwd(defaults, args.cwd),
      resumeSessionId: args.resumeSessionId || undefined,
      model: args.model || undefined,
      timeoutMs: Math.min(Number(args.timeoutMs) || defaultTimeout, defaultTimeout * 4),
      signal,
    }))
    return lossless({
      provider: providerId,
      text: result?.text ?? '',
      backend: result?.backend ?? backend.kind,
      externalSessionId: result?.externalSessionId ?? null,
      stopReason: result?.stopReason ?? null,
      durationMs: Date.now() - startedAt,
    })
  }

  disposers.push(ctx.tools.register({
    name: 'agent_dispatch',
    description: [
      'Dispatch one task headlessly to an external coding agent as a subagent and return its answer.',
      'Providers: claude | codex | opencode | zcode. The official subagent provider is preferred when the deployment registers one for a live parent agent.',
      COST_WARNING,
      'background:true starts a background job and returns its id; without a jobs service the call runs inline and returns the foreground value.',
      'resumeSessionId continues one of that agent\'s existing sessions (find ids with agent_sessions).',
    ].join('\n'),
    parameters: params({
      provider: { type: 'string', description: 'Target agent: claude | codex | opencode | zcode' },
      prompt: { type: 'string', description: 'The task to hand to that agent' },
      cwd: { type: 'string', description: 'Working directory; defaults to config.defaults.defaultCwd' },
      resumeSessionId: { type: 'string', description: 'External session id to continue' },
      model: { type: 'string', description: 'Override the target model' },
      background: { type: 'boolean', description: 'true starts a background job and returns its id' },
      timeoutMs: { type: 'number', description: 'Foreground timeout in milliseconds (default ' + defaultTimeout + ')' },
    }, ['prompt']),
    output: openOutput((_args, value) => {
      if (value !== null && typeof value === 'object' && value.kind === 'background') {
        return [{ type: 'text', text: 'started background job ' + value.jobId }]
      }
      const header = '[' + value.provider + (value.externalSessionId ? ' session ' + value.externalSessionId : '') + ']'
      return renderDispatch(header, value)
    }),
    presentCall(args) {
      const label = labelOf(args.prompt)
      if (args.background === true) {
        return {
          card: 'generic',
          title: args.provider + ': ' + label,
          kind: 'execute',
          rawInput: String(args.prompt ?? ''),
          content: [{ type: 'text', text: 'Background dispatch to ' + args.provider + '; collect the result with job_output' }],
        }
      }
      return {
        card: 'terminal',
        title: args.provider + ': ' + label,
        description: 'External agent subagent dispatch' + (args.resumeSessionId ? ' (resume ' + args.resumeSessionId + ')' : ''),
        ...(args.cwd ? { cwd: args.cwd } : {}),
      }
    },
    presentResult(args, result) {
      const block = result.content.length === 1 ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      return {
        card: 'terminal',
        output: block.text,
        ...(result.isError ? {} : { exitCode: 0 }),
      }
    },
    async execute(args, exec) {
      const providerId = String(args.provider ?? '').trim()
      const backend = resolver.resolve({ provider: providerId, parent: exec?.agent })
      const background = args.background === true
      if (!background) return dispatchForeground(backend, providerId, args, exec?.signal)

      const controller = new AbortController()
      const label = providerId + ': ' + labelOf(args.prompt)
      let startedAt = 0
      const jobId = startJob(ctx, {
        kind: 'agent-alliance',
        label,
        owner: exec?.agent?.sessionId,
        outputLimitBytes: 65536,
        run(job) {
          startedAt = Date.now()
          const produced = gate.run(controller.signal, () => backend.dispatch({
            prompt: String(args.prompt),
            cwd: resolveCwd(defaults, args.cwd),
            resumeSessionId: args.resumeSessionId || undefined,
            model: args.model || undefined,
            timeoutMs: defaultTimeout,
            signal: controller.signal,
          })).then((result) => {
            const header = '[' + providerId + (result?.externalSessionId ? ' session ' + result.externalSessionId : '') + ' in ' + (Date.now() - startedAt) + 'ms]'
            const text = header + '\n' + String(result?.text ?? '')
            job.append(text)
            return { status: 'completed', result: text }
          })
          return jobHooks(controller, produced)
        },
      })
      if (jobId === undefined) return dispatchForeground(backend, providerId, args, exec?.signal)
      return lossless({ kind: 'background', jobId })
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'agent_roundtable',
    description: [
      'Run a roundtable: send the same question to several external agents concurrently and return their answers side by side for your own synthesis.',
      COST_WARNING,
      'Every member spends quota and may read or write files in its cwd.',
      'rounds is clamped to 1..3; from round 2 on each member sees the others\' previous answers. Default providers are every configured backend.',
      'background defaults to true and returns a job id; false waits for every member in the foreground.',
    ].join('\n'),
    parameters: params({
      prompt: { type: 'string', description: 'The question every participating agent receives' },
      providers: { type: 'array', items: { type: 'string' }, description: 'Provider ids to include; defaults to every configured backend' },
      cwd: { type: 'string', description: 'Working directory' },
      rounds: { type: 'integer', description: 'Debate rounds, clamped to 1..3', default: 1 },
      background: { type: 'boolean', description: 'Defaults to true; false waits in the foreground' },
    }, ['prompt']),
    output: openOutput((_args, value) => {
      if (value !== null && typeof value === 'object' && value.kind === 'background') {
        return [{ type: 'text', text: 'started background job ' + value.jobId }]
      }
      if (value !== null && typeof value === 'object' && typeof value.text === 'string') {
        return [{ type: 'text', text: value.text }]
      }
      return [{ type: 'text', text: JSON.stringify(value) }]
    }),
    presentCall(args) {
      return {
        card: 'generic',
        title: 'roundtable: ' + labelOf(args.prompt),
        kind: 'execute',
        rawInput: String(args.prompt ?? ''),
        content: [{ type: 'text', text: 'Fan out to every available agent and return the answers for comparison' }],
      }
    },
    async execute(args, exec) {
      const parent = exec?.agent
      const providerIds = Array.isArray(args.providers) ? args.providers.map(String) : undefined
      // runRoundtable consumes a provider registry (`list()` / `get(id)`), so adapt the
      // backend resolver into that minimal interface; both official and CLI backends
      // expose the same `dispatch(request)`.
      const roundtableRegistry = {
        list: () => resolver.list(parent).map((info) => ({ id: info.id, label: info.label })),
        get(id) {
          const info = resolver.list(parent).find((entry) => entry.id === id)
          if (info === undefined) throw new Error('unknown provider: ' + String(id))
          if (info.available === false) {
            throw new Error('provider ' + String(id) + ' is unavailable' + (info.detail ? ': ' + info.detail : ''))
          }
          return resolver.resolve({ provider: id, parent })
        },
      }
      // Every member dispatch goes through the same bounded gate as a single
      // agent_dispatch. Without it a fan-out opens one process per member (and
      // multiple stacked roundtables multiply that), which turns a provider 429
      // into silently missing members.
      const gatedRegistry = {
        list: () => roundtableRegistry.list(),
        get(id) {
          const backend = roundtableRegistry.get(id)
          return {
            ...backend,
            dispatch: (request) => gate.run(request.signal, () => backend.dispatch(request)),
          }
        },
      }
      const runOnce = (signal) => runRoundtable({
        registry: gatedRegistry,
        prompt: String(args.prompt),
        rounds: args.rounds,
        providerIds,
        cwd: resolveCwd(defaults, args.cwd),
        timeoutMs: defaultTimeout * 2,
        signal,
      })
      if (args.background === false) {
        const result = await runOnce(exec?.signal)
        return lossless({ text: formatRoundtableText(result), rounds: result.rounds.length })
      }
      const controller = new AbortController()
      const jobId = startJob(ctx, {
        kind: 'agent-alliance',
        label: 'roundtable: ' + labelOf(args.prompt),
        owner: exec?.agent?.sessionId,
        outputLimitBytes: 262144,
        run(job) {
          const produced = runOnce(controller.signal).then((result) => {
            const text = formatRoundtableText(result)
            job.append(text)
            return { status: 'completed', result: text }
          })
          return jobHooks(controller, produced)
        },
      })
      if (jobId === undefined) {
        const result = await runOnce(exec?.signal)
        return lossless({ text: formatRoundtableText(result), rounds: result.rounds.length })
      }
      return lossless({ kind: 'background', jobId })
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'agent_sessions',
    description: [
      'List the local session history of one external agent (claude | codex | opencode | zcode), optionally filtered by text.',
      'Read-only. Use it to find a session id to resume with agent_dispatch or to import with agent_import.',
    ].join('\n'),
    parameters: params({
      provider: { type: 'string', description: 'claude | codex | opencode | zcode' },
      query: { type: 'string', description: 'Filter by title, cwd, or id substring' },
      limit: { type: 'number', description: 'Maximum rows to return (default 20)' },
    }, ['provider']),
    output: openOutput((_args, value) => {
      const rows = (value.sessions || []).map((session) => '- [' + session.id + '] ' + (session.title || '(untitled)')
        + (session.cwd ? ' @' + session.cwd : '')
        + (session.createdAt ? ' ' + new Date(session.createdAt).toISOString().slice(0, 16) : ''))
      return [{ type: 'text', text: rows.join('\n') || '(no sessions)' }]
    }),
    async execute(args) {
      const provider = registry.get(String(args.provider ?? '').trim())
      const sessions = await provider.listSessions({
        query: args.query || undefined,
        limit: Number(args.limit) || 20,
      })
      return lossless({ sessions })
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'agent_session_read',
    description: [
      'Read the transcript of one external agent session, truncated to maxChars, to recover context before continuing or importing it.',
      'Read-only.',
    ].join('\n'),
    parameters: params({
      provider: { type: 'string', description: 'claude | codex | opencode | zcode' },
      sessionId: { type: 'string', description: 'External session id returned by agent_sessions' },
      maxChars: { type: 'number', description: 'Maximum characters to return (default 8000)' },
    }, ['provider', 'sessionId']),
    output: openOutput((_args, value) => {
      const lines = (value.messages || []).map((message) => (message.role === 'user' ? '[user] ' : '[assistant] ') + message.text)
      return [{ type: 'text', text: lines.join('\n\n') || '(empty session)' }]
    }),
    async execute(args) {
      const provider = registry.get(String(args.provider ?? '').trim())
      return lossless(await provider.readSession(String(args.sessionId), {
        maxChars: Number(args.maxChars) || 8000,
      }))
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'agent_import_scan',
    description: [
      'Scan the local session history of the supported external agents (claude | codex | opencode | zcode) and report what can be imported and what already was.',
      'Read-only; writes nothing.',
    ].join('\n'),
    parameters: params({
      provider: { type: 'string', description: 'Scan only this provider; omit to scan every one' },
      query: { type: 'string', description: 'Filter by title, cwd, or id substring' },
      limit: { type: 'number', description: 'Maximum rows per provider (default 20)' },
    }),
    output: openOutput((_args, value) => {
      const rows = (value.sessions || []).map((session) => '- [' + session.provider + '/' + session.id + '] '
        + (session.title || '(untitled)')
        + (session.imported ? ' [imported]' : '')
        + (session.cwd ? ' @' + session.cwd : ''))
      return [{ type: 'text', text: (rows.join('\n') || '(no sessions)') + '\n' + value.total + ' total' }]
    }),
    async execute(args) {
      const ledger = loadLedger(home)
      const wanted = args.provider ? [String(args.provider)] : registry.list().map((provider) => provider.id)
      const sessions = []
      for (const id of wanted) {
        try {
          const provider = registry.get(id)
          const listed = await provider.listSessions({
            query: args.query || undefined,
            limit: Number(args.limit) || 20,
          })
          for (const session of listed) {
            sessions.push({
              provider: id,
              id: String(session.id),
              title: session.title ?? null,
              cwd: session.cwd ?? null,
              createdAt: session.createdAt ?? null,
              imported: Boolean(ledger[sourceKey(id, String(session.id))]?.dshSessionId),
            })
          }
        } catch (error) {
          ctx.logger?.warn?.('agent-alliance: agent_import_scan failed for provider ' + id + ': ' + String(error?.message || error))
        }
      }
      return lossless({ total: sessions.length, sessions })
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'agent_import',
    description: [
      'Import one external agent session as a resumable DSH session, reconstructed at the event level. Idempotent: importing twice is skipped.',
      'Use agent_import_scan to find a sessionId first.',
    ].join('\n'),
    parameters: params({
      provider: { type: 'string', description: 'claude | codex | opencode | zcode' },
      sessionId: { type: 'string', description: 'External session id' },
    }, ['provider', 'sessionId']),
    output: openOutput((_args, value) => {
      if (value.status === 'imported') return [{ type: 'text', text: 'imported as DSH session ' + value.dshSessionId + ' (' + value.turns + ' turns)' }]
      if (value.status === 'already-imported') return [{ type: 'text', text: 'already imported: ' + value.dshSessionId + ' (skipped)' }]
      if (value.status === 'skipped') return [{ type: 'text', text: 'skipped: ' + (value.reason || '') }]
      return [{ type: 'text', text: JSON.stringify(value) }]
    }),
    presentCall(args) {
      return {
        card: 'generic',
        title: 'Import ' + args.provider + '/' + args.sessionId,
        kind: 'execute',
        rawInput: JSON.stringify(args),
        content: [{ type: 'text', text: 'Reconstruct the external session as a DSH session (idempotent)' }],
      }
    },
    async execute(args) {
      return lossless(await importOne(io ?? ctx, {
        registry,
        provider: String(args.provider),
        externalId: String(args.sessionId),
        home,
      }))
    },
  }))

  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
  }
}
