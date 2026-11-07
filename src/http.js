// src/http.js — the panel's HTTP surface, registered on the composition's
// `webServer` as one prefix route at `/__agent-alliance`.
//
// Every handler first runs the connection trust admission copied from the
// plugin spec (rejectionFor). Only then does it answer, and every answer is a
// JSON envelope: `{ ok: true, ... }` on success, `{ ok: false, error, code? }`
// with a matching status on failure.
//
// Panel-initiated work has no Agent identity, so its background jobs are
// UNOWNED: `ctx.jobs.start({ kind, label, run })` without an owner, read with
// `jobs.list(undefined)` / `jobs.readAt(id, from)` and killed with
// `jobs.kill(id, undefined, reason)`.

import { runRoundtable, formatRoundtableText } from './roundtable.js'
import { loadLedger, importOne, sourceKey } from './importer/persist.js'

/** Absolute route prefix served by this module. */
export const ROUTE_PREFIX = '/__agent-alliance'

/** Job kind every job started by this plugin registers. */
const JOB_KIND = 'agent-alliance'

/** Request bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * Resolve the connection trust admission result for one request, verbatim from
 * the plugin spec. Returns `undefined` when the request may proceed, otherwise
 * the HTTP status (401/403/503) refusing it.
 * @param {object} ctx plugin context
 * @param {object} req node:http request (only `headers` is read)
 * @returns {number|undefined} rejection status, or undefined when admitted
 */
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

/** Plain-text bodies answering a trust rejection. */
const REJECTION_TEXT = {
  401: 'unauthorized',
  403: 'forbidden',
  503: 'connection admission unavailable',
}

/**
 * Answer a request the trust fence refused, with a plain-text body.
 * @param {object} res node:http response
 * @param {number} rejection 401, 403, or 503
 * @returns {void}
 */
function sendRejection(res, rejection) {
  const body = REJECTION_TEXT[rejection] ?? 'rejected'
  res.writeHead(rejection, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * JSON response with one envelope body. Sets `cache-control: no-store` because
 * every value served here is live host state.
 * @param {object} res node:http response
 * @param {number} status HTTP status code
 * @param {object} payload complete envelope including the `ok` flag
 * @returns {void}
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Success envelope.
 * @param {object} res node:http response
 * @param {object} [extra] additional fields merged after `ok: true`
 * @returns {void}
 */
function sendOk(res, extra = {}) {
  sendJson(res, 200, { ok: true, ...extra })
}

/**
 * Failure envelope with a matching HTTP status.
 * @param {object} res node:http response
 * @param {number} status HTTP status code
 * @param {unknown} error human-readable failure detail
 * @param {string} [code] stable machine-readable code
 * @returns {void}
 */
function sendError(res, status, error, code) {
  sendJson(res, status, {
    ok: false,
    error: String(error?.message || error),
    ...(code === undefined ? {} : { code }),
  })
}

/**
 * Build a route failure carrying the HTTP status the envelope must use.
 * @param {number} status HTTP status code
 * @param {string} message human-readable failure
 * @param {string} [code] stable machine-readable code
 * @returns {Error} error whose `status`/`code` the route wrapper reads
 */
function failure(status, message, code) {
  const error = new Error(message)
  error.status = status
  if (code !== undefined) error.code = code
  return error
}

/**
 * Read a bounded request body as UTF-8 text.
 * @param {object} req node:http request
 * @returns {Promise<string|undefined>} body text, or undefined past the ceiling
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Parse a JSON object request body.
 * @param {object} req node:http request
 * @returns {Promise<{ value?: object, error?: string }>} parsed object or a failure detail
 */
async function readJson(req) {
  const body = await readBody(req)
  if (body === undefined) return { error: 'request body is too large' }
  if (body.trim() === '') return { value: {} }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    return { error: 'invalid JSON body: ' + String(error?.message || error) }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'request body must be a JSON object' }
  }
  return { value: parsed }
}

/**
 * Parse one request URL against a local base.
 * @param {object} req node:http request
 * @returns {URL} parsed URL
 */
function requestUrl(req) {
  return new URL(req.url ?? '/', 'http://local')
}

/**
 * Read a non-negative integer query parameter.
 * @param {URL} url parsed request URL
 * @param {string} name parameter name
 * @param {number} fallback value used when absent or invalid
 * @returns {number} resolved value
 */
function intParam(url, name, fallback) {
  const raw = url.searchParams.get(name)
  const value = Number(raw)
  return raw === null || !Number.isFinite(value) || value < 0 ? fallback : Math.trunc(value)
}

/**
 * Project one JobView into the panel's row shape, omitting absent fields so the
 * value stays lossless JSON.
 * @param {object} view the jobs service projection
 * @returns {object} panel row
 */
function taskRow(view) {
  return {
    id: String(view.id),
    kind: String(view.kind),
    label: String(view.label),
    status: String(view.status),
    ...(view.owner === undefined ? {} : { owner: String(view.owner) }),
    ...(view.progress === undefined ? {} : { progress: String(view.progress) }),
    ...(view.detail === undefined ? {} : { detail: String(view.detail) }),
    startedAt: Number(view.startedAt) || 0,
    ...(view.finishedAt === undefined ? {} : { finishedAt: Number(view.finishedAt) }),
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
 * Read the jobs service when the composition mounts one.
 * @param {object} ctx plugin context
 * @returns {object|null} the jobs service, or null when absent
 */
function jobsOf(ctx) {
  const jobs = serviceOf(ctx, 'jobs')
  return jobs === undefined || jobs === null ? null : jobs
}

/**
 * Register the panel's HTTP routes.
 *
 * Handlers are looked up per request inside the one prefix route, so route
 * collisions cannot occur and a single disposer removes the whole surface. The
 * plugin's fiber owns that disposer, so an unload cannot leave a handler behind.
 * @param {object} webServer the composition's `ctx.webServer`
 * @param {object} options handler dependencies
 * @param {object} options.ctx plugin context (trust admission, jobs, persistence)
 * @param {{ resolve(request: object): object, list(parent?: object): object[] }} options.resolver
 *   backend resolver; HTTP callers carry no Agent, so resolution always takes the CLI path
 * @param {object} options.registry CLI provider registry (`list()` / `get(id)`)
 * @param {object} options.config resolved configuration
 * @param {object} [options.io] context handed to the importer, whose optional
 *   host services are resolved without a bare property read
 * @param {string} [options.home] DSH home directory for the import ledger
 * @returns {() => void} route disposer
 */
export function registerHttp(webServer, { ctx, io, resolver, registry, config, home }) {
  const defaults = config?.defaults || {}
  const timeoutMs = Number(defaults.timeoutMs) || 300000
  const recent = []

  /**
   * Resolve one CLI backend for an HTTP caller. HTTP has no Agent, so the
   * official subagent path is never taken.
   * @param {unknown} providerId provider id from the request
   * @returns {object} backend with `dispatch(request)`
   */
  function backendOf(providerId) {
    return resolver.resolve({ provider: String(providerId ?? '').trim() })
  }

  /**
   * Working directory for one panel request.
   * @param {unknown} requested cwd from the request body
   * @returns {string|undefined} cwd to use, if any
   */
  function cwdOf(requested) {
    const value = typeof requested === 'string' && requested !== '' ? requested : defaults.defaultCwd
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  /**
   * Record one panel dispatch for the state route.
   * @param {object} entry summary of the dispatch
   * @returns {void}
   */
  function remember(entry) {
    recent.push(entry)
    if (recent.length > 50) recent.splice(0, recent.length - 50)
  }

  /**
   * One route of the panel: a method check plus the handler that produces the
   * success envelope.
   * @param {string[]} methods accepted HTTP methods
   * @param {(req: object) => Promise<object>} handler success payload builder
   * @returns {(req: object, res: object) => Promise<void>} route handler answering its own envelope
   */
  function route(methods, handler) {
    return async (req, res) => {
      if (!methods.includes(String(req.method))) {
        const allow = methods.join(', ')
        res.setHeader?.('allow', allow)
        sendError(res, 405, 'method not allowed; allowed: ' + allow, 'method-not-allowed')
        return
      }
      try {
        sendOk(res, await handler(req))
      } catch (error) {
        const status = Number(error?.status) || 500
        ctx.logger?.warn?.('agent-alliance: ' + String(req.method) + ' ' + String(req.url) + ' failed: ' + String(error?.message || error))
        sendError(res, status, error, error?.code)
      }
    }
  }

  /**
   * Path handlers keyed by the path below the prefix.
   * @type {Map<string, (req: object, res: object) => Promise<void>>}
   */
  const routes = new Map()

  routes.set('/state', route(['GET'], async () => ({
    providers: resolver.list(undefined),
    recentDispatches: recent.slice(-20),
  })))

  routes.set('/sessions', route(['GET'], async (req) => {
    const url = requestUrl(req)
    const providerId = url.searchParams.get('provider')
    const query = url.searchParams.get('query') || undefined
    const limit = intParam(url, 'limit', 20)
    const ledger = loadLedger(home)
    const sessions = []
    const targets = providerId ? [providerId] : registry.list().map((provider) => provider.id)
    for (const id of targets) {
      try {
        const provider = registry.get(id)
        for (const session of await provider.listSessions({ query, limit })) {
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
        // A broken provider must not blank the whole listing; the row set from the
        // other providers is still useful, so record the failure instead.
        ctx.logger?.warn?.('agent-alliance: session listing failed for provider ' + id + ': ' + String(error?.message || error))
      }
    }
    return { total: sessions.length, sessions }
  }))

  routes.set('/session-content', route(['GET'], async (req) => {
    const url = requestUrl(req)
    const provider = registry.get(String(url.searchParams.get('provider') ?? ''))
    const content = await provider.readSession(String(url.searchParams.get('id') ?? ''), {
      maxChars: intParam(url, 'maxChars', 12000),
    })
    return { content: JSON.parse(JSON.stringify(content ?? null)) }
  }))

  routes.set('/import', route(['POST'], async (req) => {
    const body = await readJson(req)
    if (body.error !== undefined) throw failure(400, body.error, 'bad-body')
    const provider = String(body.value.provider ?? '')
    const sessionId = String(body.value.sessionId ?? '')
    if (provider === '' || sessionId === '') throw failure(400, 'provider and sessionId are required', 'missing-field')
    const result = await importOne(io ?? ctx, { registry, provider, externalId: sessionId, home })
    return { result }
  }))

  routes.set('/dispatch', route(['POST'], async (req) => {
    const body = await readJson(req)
    if (body.error !== undefined) throw failure(400, body.error, 'bad-body')
    const providerId = String(body.value.provider ?? '')
    const prompt = String(body.value.prompt ?? '')
    if (providerId === '' || prompt === '') throw failure(400, 'provider and prompt are required', 'missing-field')
    const backend = backendOf(providerId)
    const startedAt = Date.now()
    try {
      const result = await backend.dispatch({
        prompt,
        cwd: cwdOf(body.value.cwd),
        model: body.value.model || undefined,
        resumeSessionId: body.value.resumeSessionId || undefined,
        timeoutMs: Number(body.value.timeoutMs) || timeoutMs,
        signal: new AbortController().signal,
      })
      remember({ at: Date.now(), provider: providerId, prompt: prompt.slice(0, 80), ms: Date.now() - startedAt, ok: true })
      return {
        provider: providerId,
        backend: result?.backend ?? backend.kind,
        text: String(result?.text ?? ''),
        stopReason: result?.stopReason ?? null,
        externalSessionId: result?.externalSessionId ?? null,
        durationMs: Number(result?.durationMs) || Date.now() - startedAt,
      }
    } catch (error) {
      remember({ at: Date.now(), provider: providerId, prompt: prompt.slice(0, 80), ok: false, error: String(error?.message || error).slice(0, 200) })
      throw failure(502, String(error?.message || error), 'dispatch-failed')
    }
  }))

  routes.set('/roundtable', route(['POST'], async (req) => {
    const body = await readJson(req)
    if (body.error !== undefined) throw failure(400, body.error, 'bad-body')
    const prompt = String(body.value.prompt ?? '')
    if (prompt.trim() === '') throw failure(400, 'prompt is required', 'missing-field')
    const providerIds = Array.isArray(body.value.providers) ? body.value.providers.map(String) : undefined
    const produce = (signal) => runRoundtable({
      registry,
      prompt,
      providerIds,
      cwd: cwdOf(body.value.cwd),
      rounds: Number(body.value.rounds) || 1,
      timeoutMs: timeoutMs * 2,
      signal,
    })
    const label = 'roundtable: ' + (prompt.replace(/\s+/g, ' ').trim().slice(0, 60) || 'panel')
    const jobs = jobsOf(ctx)
    if (jobs !== null && typeof jobs.start === 'function') {
      const controller = new AbortController()
      let jobId
      try {
        jobId = jobs.start({
          kind: JOB_KIND,
          label,
          run(job) {
            const done = Promise.resolve()
              .then(() => produce(controller.signal))
              .then((result) => {
                const text = formatRoundtableText(result)
                job.append(text)
                return { status: 'completed', result: text }
              }, (error) => ({ status: 'failed', detail: String(error?.message || error).slice(-500) }))
            return {
              cancel(reason) {
                controller.abort(new Error(reason || 'cancelled from the panel'))
              },
              done,
            }
          },
        })
      } catch (error) {
        // A mounted jobs service without a controller refuses the start. Fall
        // through to the inline path so the panel gets an answer, not a 500.
        jobId = undefined
        const logger = ctx?.get?.('logger')
        if (logger !== undefined && typeof logger?.warn === 'function') {
          logger.warn('agent-alliance: panel roundtable running inline: ' + String(error?.message || error))
        }
      }
      if (jobId !== undefined) return { jobId }
    }
    // No usable jobs service: run inline so the panel gets an answer instead of an id.
    const result = await produce(new AbortController().signal)
    return { jobId: null, text: formatRoundtableText(result) }
  }))

  routes.set('/tasks', route(['GET'], async () => {
    const jobs = jobsOf(ctx)
    if (jobs === null || typeof jobs.list !== 'function') throw failure(503, 'jobs service unavailable', 'jobs-unavailable')
    return {
      tasks: jobs.list(undefined)
        .filter((view) => String(view.kind) === JOB_KIND)
        .map(taskRow),
    }
  }))

  routes.set('/tasks/output', route(['GET'], async (req) => {
    const jobs = jobsOf(ctx)
    if (jobs === null || typeof jobs.readAt !== 'function') throw failure(503, 'jobs service unavailable', 'jobs-unavailable')
    const url = requestUrl(req)
    const id = String(url.searchParams.get('id') ?? '')
    if (id === '') throw failure(400, 'id is required', 'missing-field')
    let read
    try {
      read = jobs.readAt(id, intParam(url, 'from', 0), undefined)
    } catch (error) {
      throw failure(404, String(error?.message || error), 'unknown-job')
    }
    return {
      chunks: read.chunks,
      next: read.next,
      lossy: read.lossy,
      job: typeof jobs.get === 'function' ? taskRow(jobs.get(id, undefined)) : null,
    }
  }))

  routes.set('/tasks/kill', route(['POST'], async (req) => {
    const jobs = jobsOf(ctx)
    if (jobs === null || typeof jobs.kill !== 'function') throw failure(503, 'jobs service unavailable', 'jobs-unavailable')
    const body = await readJson(req)
    if (body.error !== undefined) throw failure(400, body.error, 'bad-body')
    const id = String(body.value.id ?? '')
    if (id === '') throw failure(400, 'id is required', 'missing-field')
    let outcome
    try {
      outcome = jobs.kill(id, undefined, String(body.value.reason ?? 'panel'))
    } catch (error) {
      throw failure(404, String(error?.message || error), 'unknown-job')
    }
    return { outcome }
  }))

  return webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      // Trust admission runs before routing, method checks, and dispatch.
      const rejection = rejectionFor(ctx, req)
      if (rejection !== undefined) {
        sendRejection(res, rejection)
        return
      }
      let path
      try {
        path = requestUrl(req).pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/'
      } catch (error) {
        sendError(res, 400, 'invalid request URL: ' + String(error?.message || error), 'bad-url')
        return
      }
      const handler = routes.get(path)
      if (handler === undefined) {
        sendError(res, 404, 'unknown route: ' + path, 'not-found')
        return
      }
      await handler(req, res)
    },
  })
}
