// Tests for src/http.js: trust admission before dispatch, the { ok } envelope on
// every route, unowned panel jobs, and readAt-based task output.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { registerHttp, ROUTE_PREFIX } from '../src/http.js'
import { createRegistry } from '../src/provider/types.js'

/**
 * Fresh temp directory used as the plugin home (import ledger).
 * @returns {string} absolute path
 */
function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aa-http-'))
}

/**
 * Fake webServer recording registrations.
 * @returns {object} `{ webServer, routes }`
 */
function mockWebServer() {
  const routes = []
  return {
    routes,
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
  }
}

/**
 * Drive one request through the single registered prefix route.
 *
 * The fake request is an async iterable of body chunks, matching what
 * `for await (const chunk of req)` reads in the handler.
 * @param {object} routes registered routes
 * @param {string} method HTTP method
 * @param {string} target path with query string
 * @param {object} [body] JSON body
 * @param {object} [options] extra request fields
 * @returns {Promise<{ status: number, headers: object, text: string, json: any }>} response
 */
async function request(routes, method, target, body, options = {}) {
  const route = routes.find((entry) => target === entry.path || target.startsWith(entry.path + '/'))
  assert.ok(route, 'no route matched ' + target)
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = {
    method,
    url: target,
    headers: options.headers ?? {},
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload)
    },
  }
  const chunks = []
  const res = {
    statusCode: 0,
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
    },
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk))
      this.done = true
    },
  }
  await route.handler(req, res)
  const text = Buffer.concat(chunks).toString('utf8')
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.statusCode, headers: res.headers, text, json }
}

/**
 * A CLI provider used by the HTTP routes.
 * @param {object} [overrides] provider overrides
 * @returns {object} provider
 */
function fakeProvider(overrides = {}) {
  return {
    id: 'p1',
    label: 'P1',
    detect: async () => ({ available: true, version: '1.0' }),
    dispatch: async ({ prompt }) => ({ text: 'R:' + prompt, externalSessionId: 'x9' }),
    listSessions: async () => [{ id: 's1', title: 't', createdAt: null, messageCount: null }],
    readSession: async (id) => ({ title: 'T', messages: [{ role: 'user', text: 'q-' + id }] }),
    ...overrides,
  }
}

/**
 * Resolver stub over a CLI registry, shaped like src/backend.js.
 * @param {object[]} providers CLI providers
 * @param {object} [options] behaviour switches
 * @returns {object} resolver
 */
function mockResolver(providers, options = {}) {
  return {
    list() {
      return providers.map((provider) => ({ id: provider.id, label: provider.label, kind: 'cli', available: true }))
    },
    resolve(request) {
      if (options.onResolve) options.onResolve(request)
      const provider = providers.find((entry) => entry.id === request.provider)
      if (provider === undefined) throw new Error('unknown provider: ' + String(request.provider))
      return {
        id: provider.id,
        label: provider.label,
        kind: 'cli',
        available: true,
        async dispatch(dispatchRequest) {
          const result = await provider.dispatch(dispatchRequest)
          return { text: result.text, externalSessionId: result.externalSessionId ?? null, durationMs: 2, backend: 'cli' }
        },
      }
    },
  }
}

/**
 * Build the shared registration options.
 * @param {object} [options] overrides
 * @returns {object} options for registerHttp
 */
/**
 * Build a test context whose trust fence admits, layering any test-specific
 * services (jobs, sessionPersistence) on top.
 * @param {object} [override] optional custom ctx from a test
 * @returns {object} ctx with both the trust fence and the custom services
 */
function optionsCtx(override) {
  const customGet = override && typeof override.get === 'function' ? override.get.bind(override) : () => undefined
  const customConnection = customGet('connection')
  const explicitlyNoConnection = override !== undefined && Object.prototype.hasOwnProperty.call(override, 'noConnection')
  return {
    ...(override || {}),
    get: (name) => {
      // A test that supplies its own connection (rejecting, malformed, or
      // absent-on-purpose) must win; do not overwrite its trust behavior.
      if (name === 'connection' && customConnection === undefined && !explicitlyNoConnection) {
        return { requestRejection: () => undefined }
      }
      return customGet(name)
    },
  }
}

function options(overrides = {}) {
  const providers = overrides.providers ?? [fakeProvider()]
  return {
    // The official trust fence is mandatory. A test may override ctx to inject
    // `jobs` or `sessionPersistence`; merge the admitting connection into that
    // override instead of dropping the fence.
    ctx: optionsCtx(overrides.ctx),
    resolver: overrides.resolver ?? mockResolver(providers),
    registry: overrides.registry ?? createRegistry(providers),
    config: overrides.config ?? { defaults: { timeoutMs: 5000 }, panel: { enabled: true } },
    home: overrides.home ?? tmpHome(),
  }
}

/**
 * Fake jobs service matching the DSH 0.2.1-rc.2 contract.
 * @param {object} [views] job views keyed by job id
 * @returns {object} `{ jobs, calls }`
 */
function fakeJobs(views = {}) {
  const calls = { list: [], readAt: [], kill: [], start: [] }
  const jobs = {
    start(spec) {
      calls.start.push(spec)
      return 'agent-alliance-job-7'
    },
    list(caller) {
      calls.list.push(caller)
      return Object.values(views)
    },
    readAt(id, from, caller) {
      calls.readAt.push({ id, from, caller })
      if (!(id in views)) throw new Error('unknown job ' + id)
      return {
        chunks: [{ at: from, text: 'partial output' }],
        next: from + 14,
        lossy: false,
      }
    },
    get(id, caller) {
      calls.readAt.push({ get: id, caller })
      if (!(id in views)) throw new Error('unknown job ' + id)
      return views[id]
    },
    kill(id, caller, reason) {
      calls.kill.push({ id, caller, reason })
      return 'requested'
    },
  }
  return { jobs, calls }
}

/**
 * A persistence service satisfying both the legacy `create(id)`+`append(id, events)`
 * and the v4 `create(header)` → handle contract, so the import route is exercised
 * without depending on another module's internals.
 * @param {(header: object) => void} [onCreate] observer for each created header
 * @returns {object} persistence service stub
 */
function persistenceFake(onCreate) {
  const handle = {
    append: async () => {},
    flush: async () => {},
    close: async () => {},
  }
  return {
    create: async (header) => {
      onCreate?.(header)
      return handle
    },
  }
}

test('registers exactly one prefix route at /__agent-alliance', () => {
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options())
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, ROUTE_PREFIX)
  assert.equal(typeof routes[0].handler, 'function')
})

test('returns a disposer that removes the route', () => {
  const { webServer, routes } = mockWebServer()
  const dispose = registerHttp(webServer, options())
  assert.equal(typeof dispose, 'function')
  assert.equal(routes.length, 1)
  dispose()
  assert.equal(routes.length, 0)
})

test('unknown paths answer a 404 envelope', async () => {
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options())
  const response = await request(routes, 'GET', ROUTE_PREFIX + '/nope')
  assert.equal(response.status, 404)
  assert.equal(response.json.ok, false)
  assert.match(response.json.error, /unknown route/)
})

test('wrong methods answer a 405 envelope naming the allowed methods', async () => {
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options())
  const response = await request(routes, 'GET', ROUTE_PREFIX + '/dispatch')
  assert.equal(response.status, 405)
  assert.equal(response.json.ok, false)
  assert.equal(response.json.code, 'method-not-allowed')
  assert.match(response.json.error, /POST/)
})

test('admission rejection short-circuits before dispatch on every route', async () => {
  const routesAndPaths = [
    ['GET', '/state', undefined],
    ['GET', '/sessions', undefined],
    ['GET', '/session-content?provider=p1&id=s1', undefined],
    ['POST', '/import', { provider: 'p1', sessionId: 's1' }],
    ['POST', '/dispatch', { provider: 'p1', prompt: 'hi' }],
    ['POST', '/roundtable', { prompt: 'hi' }],
    ['GET', '/tasks', undefined],
    ['GET', '/tasks/output?id=agent-alliance-job-7', undefined],
    ['POST', '/tasks/kill', { id: 'agent-alliance-job-7' }],
  ]
  let dispatches = 0
  let resolutions = 0
  const provider = fakeProvider({
    dispatch: async () => {
      dispatches += 1
      return { text: 'should not run' }
    },
  })
  const ctx = {
    get(name) {
      if (name === 'connection') return { admit: () => ({ rejection: 403 }) }
      return undefined
    },
  }
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options({
    ctx,
    providers: [provider],
    resolver: mockResolver([provider], { onResolve: () => { resolutions += 1 } }),
  }))
  for (const [method, target, body] of routesAndPaths) {
    const response = await request(routes, method, ROUTE_PREFIX + target, body)
    assert.equal(response.status, 403, method + ' ' + target + ' must be rejected')
    assert.equal(response.json, undefined, method + ' ' + target + ' must answer plain text, not JSON')
    assert.match(response.headers['content-type'], /text\/plain/)
  }
  assert.equal(dispatches, 0, 'no provider dispatch may run for a rejected request')
  assert.equal(resolutions, 0, 'no backend resolution may run for a rejected request')
})

test('admission rejection statuses are propagated verbatim', async () => {
  for (const rejection of [401, 403, 503]) {
    const ctx = { get: () => ({ admit: () => ({ rejection }) }) }
    const { webServer, routes } = mockWebServer()
    registerHttp(webServer, options({ ctx }))
    const response = await request(routes, 'GET', ROUTE_PREFIX + '/state')
    assert.equal(response.status, rejection)
  }
})

test('a connection service with requestRejection gates the route', async () => {
  let called = 0
  const ctx = {
    get() {
      return {
        requestRejection() {
          called += 1
          return 401
        },
      }
    },
  }
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options({ ctx }))
  const response = await request(routes, 'GET', ROUTE_PREFIX + '/state')
  assert.equal(response.status, 401)
  assert.equal(called, 1)
})

test('a connection service with neither admission method answers 503', async () => {
  const ctx = { get: () => ({}) }
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options({ ctx }))
  const response = await request(routes, 'GET', ROUTE_PREFIX + '/state')
  assert.equal(response.status, 503)
})

test('a missing connection service fails closed instead of admitting', async () => {
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options({ ctx: { noConnection: true, get: () => undefined } }))
  const response = await request(routes, 'GET', ROUTE_PREFIX + '/state')
  // Official open-in-app treats the trust service as mandatory. These routes
  // spawn processes and spend quota, so a missing fence must not fail open.
  assert.equal(response.status, 503)
})

test('every route answers with the { ok } envelope on success', async () => {
  const { jobs } = fakeJobs({ 'agent-alliance-job-7': { id: 'agent-alliance-job-7', kind: 'agent-alliance', label: 'x', status: 'running', startedAt: 1 } })
  const provider = fakeProvider({
    exportSession: async () => ({ title: 'T', createdAt: 1, cwd: '/w', turns: [{ user: 'u', assistant: 'a' }] }),
  })
  const ctx = {
    get(name) {
      if (name === 'jobs') return jobs
      if (name === 'sessionPersistence') return persistenceFake()
      return undefined
    },
  }
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options({ ctx, providers: [provider] }))
  const calls = [
    ['GET', '/state', undefined],
    ['GET', '/sessions?provider=p1', undefined],
    ['GET', '/session-content?provider=p1&id=s1', undefined],
    ['POST', '/import', { provider: 'p1', sessionId: 's1' }],
    ['POST', '/dispatch', { provider: 'p1', prompt: 'hi' }],
    ['GET', '/tasks', undefined],
    ['GET', '/tasks/output?id=agent-alliance-job-7', undefined],
    ['POST', '/tasks/kill', { id: 'agent-alliance-job-7' }],
  ]
  for (const [method, target, body] of calls) {
    const response = await request(routes, method, ROUTE_PREFIX + target, body)
    assert.equal(response.status, 200, method + ' ' + target + ': ' + response.text)
    assert.ok(response.json !== null && typeof response.json === 'object', method + ' ' + target + ' must answer JSON')
    assert.equal(response.json.ok, true, method + ' ' + target + ' must carry ok: true')
  }
})

test('failures answer { ok: false } with a matching status', async () => {
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options())
  const missingField = await request(routes, 'POST', ROUTE_PREFIX + '/dispatch', { provider: 'p1' })
  assert.equal(missingField.status, 400)
  assert.equal(missingField.json.ok, false)
  assert.equal(missingField.json.code, 'missing-field')
  assert.match(missingField.json.error, /prompt/)

  const badJson = await request(routes, 'POST', ROUTE_PREFIX + '/dispatch', undefined, {})
  const route = routes[0]
  const req = {
    method: 'POST',
    url: ROUTE_PREFIX + '/dispatch',
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{oops')
    },
  }
  const chunks = []
  const res = {
    writeHead(status, headers) { this.statusCode = status; this.headers = headers },
    setHeader() {},
    end(chunk) { if (chunk !== undefined) chunks.push(Buffer.from(chunk)) },
  }
  await route.handler(req, res)
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(Buffer.concat(chunks).toString('utf8')).code, 'bad-body')
  void badJson
})

test('dispatch failures answer 502 with the adapter error', async () => {
  const provider = fakeProvider({ dispatch: async () => { throw new Error('provider exploded') } })
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options({ providers: [provider] }))
  const response = await request(routes, 'POST', ROUTE_PREFIX + '/dispatch', { provider: 'p1', prompt: 'hi' })
  assert.equal(response.status, 502)
  assert.equal(response.json.ok, false)
  assert.equal(response.json.code, 'dispatch-failed')
  assert.match(response.json.error, /provider exploded/)
})

test('GET state lists resolver backends and recent dispatches', async () => {
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options())
  await request(routes, 'POST', ROUTE_PREFIX + '/dispatch', { provider: 'p1', prompt: 'warm up' })
  const response = await request(routes, 'GET', ROUTE_PREFIX + '/state')
  assert.equal(response.status, 200)
  assert.deepEqual(response.json.providers, [{ id: 'p1', label: 'P1', kind: 'cli', available: true }])
  assert.equal(response.json.recentDispatches.length, 1)
  assert.equal(response.json.recentDispatches[0].provider, 'p1')
  assert.equal(response.json.recentDispatches[0].ok, true)
})

test('POST dispatch reports the CLI backend and its session id', async () => {
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options())
  const response = await request(routes, 'POST', ROUTE_PREFIX + '/dispatch', { provider: 'p1', prompt: 'hi' })
  assert.equal(response.status, 200)
  assert.equal(response.json.text, 'R:hi')
  assert.equal(response.json.backend, 'cli')
  assert.equal(response.json.externalSessionId, 'x9')
})

test('HTTP dispatch never passes a parent agent to the resolver', async () => {
  const seen = []
  const provider = fakeProvider()
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options({ providers: [provider], resolver: mockResolver([provider], { onResolve: (request) => seen.push(request) }) }))
  await request(routes, 'POST', ROUTE_PREFIX + '/dispatch', { provider: 'p1', prompt: 'hi' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].parent, undefined)
})

test('GET sessions marks imported sessions and lists every provider', async () => {
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options())
  const response = await request(routes, 'GET', ROUTE_PREFIX + '/sessions?provider=p1')
  assert.equal(response.status, 200)
  assert.equal(response.json.total, 1)
  assert.equal(response.json.sessions[0].provider, 'p1')
  assert.equal(response.json.sessions[0].imported, false)
})

test('GET session-content returns the provider transcript', async () => {
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options())
  const response = await request(routes, 'GET', ROUTE_PREFIX + '/session-content?provider=p1&id=s1')
  assert.equal(response.status, 200)
  assert.equal(response.json.content.title, 'T')
  assert.equal(response.json.content.messages[0].text, 'q-s1')
})

test('POST roundtable starts an UNOWNED job and returns its id', async () => {
  const { jobs, calls } = fakeJobs()
  const ctx = { get: (name) => (name === 'jobs' ? jobs : undefined) }
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options({ ctx }))
  const response = await request(routes, 'POST', ROUTE_PREFIX + '/roundtable', { prompt: 'compare these' })
  assert.equal(response.status, 200)
  assert.equal(response.json.jobId, 'agent-alliance-job-7')
  assert.equal(calls.start.length, 1)
  const spec = calls.start[0]
  assert.equal(spec.kind, 'agent-alliance')
  assert.match(spec.label, /roundtable/)
  assert.equal('owner' in spec, false, 'panel jobs must be unowned: no owner key at all')
  assert.equal(typeof spec.run, 'function')
})

test('POST roundtable without a jobs service runs inline and reports no job id', async () => {
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options())
  const response = await request(routes, 'POST', ROUTE_PREFIX + '/roundtable', { prompt: 'compare' })
  assert.equal(response.status, 200)
  assert.equal(response.json.jobId, null)
  assert.match(response.json.text, /R:compare/)
})

test('panel roundtable job settles completed with the formatted text', async () => {
  const { jobs, calls } = fakeJobs()
  const ctx = { get: (name) => (name === 'jobs' ? jobs : undefined) }
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options({ ctx }))
  await request(routes, 'POST', ROUTE_PREFIX + '/roundtable', { prompt: 'discuss' })
  const appended = []
  const hooks = calls.start[0].run({ append: (text) => appended.push(text), updateProgress: () => {} })
  const outcome = await hooks.done
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.result, /R:discuss/)
  assert.match(appended.join('\n'), /R:discuss/)
})

test('GET tasks lists only agent-alliance jobs through the unowned view', async () => {
  const { jobs, calls } = fakeJobs({
    'agent-alliance-1': { id: 'agent-alliance-1', kind: 'agent-alliance', label: 'mine', status: 'running', startedAt: 5 },
    'bash-9': { id: 'bash-9', kind: 'bash', label: 'theirs', status: 'completed', startedAt: 6 },
  })
  const ctx = { get: (name) => (name === 'jobs' ? jobs : undefined) }
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options({ ctx }))
  const response = await request(routes, 'GET', ROUTE_PREFIX + '/tasks')
  assert.equal(response.status, 200)
  assert.equal(response.json.tasks.length, 1)
  assert.equal(response.json.tasks[0].id, 'agent-alliance-1')
  assert.equal(response.json.tasks[0].status, 'running')
  assert.deepEqual(calls.list, [undefined], 'the panel must list unowned jobs')
})

test('GET tasks answers 503 when no jobs service is mounted', async () => {
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options())
  for (const [method, target, body] of [
    ['GET', '/tasks', undefined],
    ['GET', '/tasks/output?id=x', undefined],
    ['POST', '/tasks/kill', { id: 'x' }],
  ]) {
    const response = await request(routes, method, ROUTE_PREFIX + target, body)
    assert.equal(response.status, 503, method + ' ' + target)
    assert.equal(response.json.ok, false)
    assert.equal(response.json.code, 'jobs-unavailable')
  }
})

test('task output uses readAt with the from offset and returns the projection', async () => {
  const { jobs, calls } = fakeJobs({
    'agent-alliance-1': { id: 'agent-alliance-1', kind: 'agent-alliance', label: 'mine', status: 'completed', startedAt: 5, finishedAt: 9 },
  })
  const ctx = { get: (name) => (name === 'jobs' ? jobs : undefined) }
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options({ ctx }))
  const response = await request(routes, 'GET', ROUTE_PREFIX + '/tasks/output?id=agent-alliance-1&from=32')
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.deepEqual(response.json.chunks, [{ at: 32, text: 'partial output' }])
  assert.equal(response.json.next, 46)
  assert.equal(response.json.lossy, false)
  assert.equal(response.json.job.id, 'agent-alliance-1')
  const read = calls.readAt.find((entry) => entry.id === 'agent-alliance-1' && entry.get === undefined)
  assert.ok(read, 'readAt must be called')
  assert.equal(read.from, 32)
  assert.equal(read.id, 'agent-alliance-1')
})

test('task output answers 404 for an unknown job', async () => {
  const { jobs } = fakeJobs()
  const ctx = { get: (name) => (name === 'jobs' ? jobs : undefined) }
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options({ ctx }))
  const response = await request(routes, 'GET', ROUTE_PREFIX + '/tasks/output?id=nope')
  assert.equal(response.status, 404)
  assert.equal(response.json.ok, false)
  assert.equal(response.json.code, 'unknown-job')
})

test('task kill passes an undefined caller and the reason', async () => {
  const { jobs, calls } = fakeJobs({ 'agent-alliance-1': { id: 'agent-alliance-1', kind: 'agent-alliance', label: 'x', status: 'running', startedAt: 1 } })
  const ctx = { get: (name) => (name === 'jobs' ? jobs : undefined) }
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options({ ctx }))
  const response = await request(routes, 'POST', ROUTE_PREFIX + '/tasks/kill', { id: 'agent-alliance-1', reason: 'user' })
  assert.equal(response.status, 200)
  assert.equal(response.json.outcome, 'requested')
  assert.deepEqual(calls.kill, [{ id: 'agent-alliance-1', caller: undefined, reason: 'user' }])
})

test('task kill defaults the reason and rejects a missing id', async () => {
  const { jobs, calls } = fakeJobs({ 'agent-alliance-1': { id: 'agent-alliance-1', kind: 'agent-alliance', label: 'x', status: 'running', startedAt: 1 } })
  const ctx = { get: (name) => (name === 'jobs' ? jobs : undefined) }
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options({ ctx }))
  await request(routes, 'POST', ROUTE_PREFIX + '/tasks/kill', { id: 'agent-alliance-1' })
  assert.equal(calls.kill[0].reason, 'panel')
  const missing = await request(routes, 'POST', ROUTE_PREFIX + '/tasks/kill', {})
  assert.equal(missing.status, 400)
  assert.equal(missing.json.code, 'missing-field')
})

test('POST import is idempotent and returns the import result', async () => {
  const created = []
  const provider = fakeProvider({
    exportSession: async () => ({ title: 'T', createdAt: 1, cwd: '/w', turns: [{ user: 'u', assistant: 'a' }] }),
  })
  const ctx = {
    get(name) {
      if (name === 'sessionPersistence') return persistenceFake((header) => created.push(header))
      return undefined
    },
  }
  const { webServer, routes } = mockWebServer()
  registerHttp(webServer, options({ ctx, providers: [provider] }))
  const first = await request(routes, 'POST', ROUTE_PREFIX + '/import', { provider: 'p1', sessionId: 's1' })
  assert.equal(first.status, 200)
  assert.equal(first.json.result.status, 'imported')
  assert.ok(first.json.result.dshSessionId)
  assert.equal(created.length, 1, 'the persistence service must be used')
  const second = await request(routes, 'POST', ROUTE_PREFIX + '/import', { provider: 'p1', sessionId: 's1' })
  assert.equal(second.json.result.status, 'already-imported')
})

test('GET /state reports probed availability, not a configured-provider assumption', async () => {
  const { webServer, routes } = mockWebServer()
  const fakeRegistry = {
    list: () => [{ id: 'p1', label: 'P1' }, { id: 'p2', label: 'P2' }],
    get: () => undefined,
    detectAll: async () => [
      { id: 'p1', label: 'P1', available: true },
      { id: 'p2', label: 'P2', available: false, detail: 'CLI not found' },
    ],
  }
  // The resolver decides which rows exist; the registry decides availability.
  const resolver = {
    list: () => [{ id: 'p1', label: 'P1', kind: 'cli', available: true }, { id: 'p2', label: 'P2', kind: 'cli', available: true }],
    resolve: (request) => ({ id: String(request.provider), label: String(request.provider), kind: 'cli', available: true, dispatch: async () => ({ text: 'x', backend: 'cli' }) }),
  }
  registerHttp(webServer, options({ resolver, registry: fakeRegistry }))
  const response = await request(routes, 'GET', ROUTE_PREFIX + '/state')
  assert.equal(response.status, 200)
  const providers = response.json.providers
  const p1 = providers.find((p) => p.id === 'p1')
  const p2 = providers.find((p) => p.id === 'p2')
  assert.equal(p1.available, true)
  // A configured provider whose CLI is missing must not be advertised as usable.
  assert.equal(p2.available, false)
  assert.match(String(p2.detail), /not found/)
})

test('GET /state fails closed when the probe itself fails', async () => {
  const { webServer, routes } = mockWebServer()
  const resolver = {
    list: () => [{ id: 'p1', label: 'P1', kind: 'cli', available: true }],
    resolve: () => ({ id: 'p1', kind: 'cli', available: true, dispatch: async () => ({ text: 'x' }) }),
  }
  const failingRegistry = {
    list: () => [{ id: 'p1', label: 'P1' }],
    get: () => undefined,
    detectAll: async () => { throw new Error('probe exploded') },
  }
  registerHttp(webServer, options({ resolver, registry: failingRegistry }))
  const response = await request(routes, 'GET', ROUTE_PREFIX + '/state')
  assert.equal(response.status, 200)
  const p1 = response.json.providers.find((p) => p.id === 'p1')
  // An unprobed provider must not inherit resolver.list()'s optimistic true.
  assert.equal(p1.available, false)
  assert.match(String(p1.detail), /not probed/)
})

test('GET /state hides providers disabled in config without removing them from resolve', async () => {
  const { webServer, routes } = mockWebServer()
  const resolver = {
    list: () => [
      { id: 'p1', label: 'P1', kind: 'cli', available: true },
      { id: 'p2', label: 'P2', kind: 'cli', available: true },
    ],
    resolve: (request) => ({ id: String(request.provider), kind: 'cli', available: true, dispatch: async () => ({ text: 'x' }) }),
  }
  const registry = {
    list: () => [{ id: 'p1', label: 'P1' }, { id: 'p2', label: 'P2' }],
    get: () => undefined,
    detectAll: async () => [{ id: 'p1', available: true }, { id: 'p2', available: true }],
  }
  const config = {
    defaults: { timeoutMs: 5000 },
    panel: { enabled: true },
    // p2 is disabled for display. It must still resolve: `enabled` gates the
    // picker, not official subagent dispatch.
    providers: { p1: { enabled: true }, p2: { enabled: false } },
  }
  registerHttp(webServer, options({ resolver, registry, config }))
  const response = await request(routes, 'GET', ROUTE_PREFIX + '/state')
  const ids = response.json.providers.map((p) => p.id)
  assert.deepEqual(ids, ['p1'], 'a disabled provider must not be offered in the panel')
})

test('a foreground panel roundtable never touches the jobs service', async () => {
  const { webServer, routes } = mockWebServer()
  const jobs = { start() { throw new Error('must not be called for a foreground roundtable') } }
  registerHttp(webServer, options({
    ctx: { get: (name) => (name === 'jobs' ? jobs : name === 'connection' ? { requestRejection: () => undefined } : undefined) },
    resolver: {
      resolve: () => ({ id: 'p1', kind: 'cli', available: true, async dispatch() { return { text: 'answer', backend: 'cli' } } }),
      list: () => [{ id: 'p1', label: 'P1', kind: 'cli', available: true }],
    },
    config: { defaults: { timeoutMs: 1000 }, panel: { enabled: true } },
  }))
  const response = await request(routes, 'POST', ROUTE_PREFIX + '/roundtable', {
    prompt: 'compare', providers: ['p1'], rounds: 1, background: false,
  })
  // Since jobs.start refusals are surfaced, ignoring background:false would
  // turn this foreground call into a 503 wherever no controller is mounted.
  assert.equal(response.status, 200)
  assert.equal(response.json.jobId, null, 'the foreground path reports no job id')
})
