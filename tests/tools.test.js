// Tests for src/tools.js: JSON-Schema definitions, background job ownership,
// and the inline fallback when no jobs service is mounted.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { registerTools } from '../src/tools.js'
import { createRegistry } from '../src/provider/types.js'

/**
 * Minimal configuration the tools read.
 * @param {object} [defaults] overrides for `defaults`
 * @returns {object} resolved configuration
 */
function makeConfig(defaults = {}) {
  return { providers: {}, defaults: { timeoutMs: 30000, maxConcurrent: 3, defaultCwd: '', ...defaults } }
}

/**
 * Fake context recording tool registrations and job specs.
 * @param {object} [options] behaviour switches
 * @param {boolean} [options.withJobs] mount a fake jobs service
 * @returns {object} `{ ctx, registered, jobsStarted }`
 */
function mockCtx({ withJobs = true } = {}) {
  const registered = []
  const jobsStarted = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    get(name) {
      if (name === 'jobs' && withJobs) return ctx.jobs
      return undefined
    },
  }
  if (withJobs) {
    ctx.jobs = {
      start(spec) {
        jobsStarted.push(spec)
        return 'agent-alliance-job-1'
      },
    }
  }
  return { ctx, registered, jobsStarted }
}

/**
 * A registry-backed fake CLI provider.
 * @param {object} [overrides] provider overrides
 * @returns {object} provider
 */
function fakeProvider(overrides = {}) {
  return {
    id: 'fake',
    label: 'Fake',
    dispatch: async ({ prompt }) => ({ text: 'answer:' + prompt, externalSessionId: 'ext-1' }),
    listSessions: async ({ limit } = {}) => [{ id: 's1', title: 'title', createdAt: null, messageCount: null }].slice(0, limit ?? 20),
    readSession: async (id) => ({ title: 'title', messages: [{ role: 'user', text: 'q-' + id }] }),
    ...overrides,
  }
}

/**
 * A resolver stub whose backends delegate to the given provider.
 * @param {Map<string, object>} providers provider id → CLI provider
 * @returns {object} resolver with `resolve` and `list`
 */
function mockResolver(providers) {
  return {
    list() {
      return [...providers.values()].map((provider) => ({
        id: provider.id,
        label: provider.label,
        kind: 'cli',
        available: true,
      }))
    },
    resolve({ provider }) {
      const found = providers.get(provider)
      if (found === undefined) throw new Error('unknown provider: ' + String(provider))
      return {
        id: found.id,
        label: found.label,
        kind: 'cli',
        available: true,
        async dispatch(request) {
          const result = await found.dispatch(request)
          return { text: result.text, externalSessionId: result.externalSessionId ?? null, durationMs: 1, backend: 'cli' }
        },
      }
    },
  }
}

/**
 * Build the resolver and registry for one provider list.
 * @param {object[]} providers CLI providers
 * @returns {{ registry: object, resolver: object }} both views of the same providers
 */
function wire(providers) {
  return {
    registry: createRegistry(providers),
    resolver: mockResolver(new Map(providers.map((provider) => [provider.id, provider]))),
  }
}

test('registers exactly the six documented tool names', () => {
  const { ctx, registered } = mockCtx()
  const { registry, resolver } = wire([fakeProvider()])
  registerTools(ctx, { registry, resolver, config: makeConfig() })
  assert.deepEqual(registered.map((tool) => tool.name).sort(), [
    'agent_dispatch',
    'agent_import',
    'agent_import_scan',
    'agent_roundtable',
    'agent_session_read',
    'agent_sessions',
  ])
})

test('every tool declares a complete JSON-Schema object with a required array', () => {
  const { ctx, registered } = mockCtx()
  const { registry, resolver } = wire([fakeProvider()])
  registerTools(ctx, { registry, resolver, config: makeConfig() })
  for (const tool of registered) {
    const { parameters } = tool
    assert.equal(parameters.type, 'object', tool.name + ' parameters.type')
    assert.equal(parameters.additionalProperties, false, tool.name + ' parameters.additionalProperties')
    assert.ok(Array.isArray(parameters.required), tool.name + ' parameters.required must be an array')
    assert.ok(parameters.properties !== null && typeof parameters.properties === 'object', tool.name + ' parameters.properties')
    for (const name of parameters.required) {
      assert.ok(name in parameters.properties, tool.name + ' requires undeclared property ' + name)
      assert.equal(parameters.properties[name].type, 'string', tool.name + ' required property ' + name + ' should be a string')
    }
    for (const [name, property] of Object.entries(parameters.properties)) {
      assert.equal(typeof property.type, 'string', tool.name + '.' + name + ' needs a JSON-Schema type')
      // A parameter node must not carry the DSL-only `required: true` marker.
      assert.equal(property.required, undefined, tool.name + '.' + name + ' must not use the DSL required marker')
    }
  }
})

test('required arrays match the documented mandatory arguments', () => {
  const { ctx, registered } = mockCtx()
  const { registry, resolver } = wire([fakeProvider()])
  registerTools(ctx, { registry, resolver, config: makeConfig() })
  const required = Object.fromEntries(registered.map((tool) => [tool.name, tool.parameters.required]))
  assert.deepEqual(required.agent_dispatch, ['prompt'])
  assert.deepEqual(required.agent_roundtable, ['prompt'])
  assert.deepEqual(required.agent_sessions, ['provider'])
  assert.deepEqual(required.agent_session_read.sort(), ['provider', 'sessionId'])
  assert.deepEqual(required.agent_import_scan, [])
  assert.deepEqual(required.agent_import.sort(), ['provider', 'sessionId'])
})

test('every tool declares an object output schema and a render function', () => {
  const { ctx, registered } = mockCtx()
  const { registry, resolver } = wire([fakeProvider()])
  registerTools(ctx, { registry, resolver, config: makeConfig() })
  for (const tool of registered) {
    assert.equal(typeof tool.output.render, 'function', tool.name + ' render')
    assert.equal(tool.output.schema.type, 'object', tool.name + ' output schema type')
    assert.equal(typeof tool.output.schema.additionalProperties, 'boolean', tool.name + ' output additionalProperties')
  }
})

test('every description keeps the quota and cwd warning', () => {
  const { ctx, registered } = mockCtx()
  const { registry, resolver } = wire([fakeProvider()])
  registerTools(ctx, { registry, resolver, config: makeConfig() })
  const dispatching = registered.filter((tool) => tool.name === 'agent_dispatch' || tool.name === 'agent_roundtable')
  assert.equal(dispatching.length, 2)
  for (const tool of dispatching) {
    assert.match(tool.description, /quota/, tool.name + ' must keep the quota warning')
    assert.match(tool.description, /cwd/, tool.name + ' must keep the cwd warning')
  }
})

test('registration returns one disposer that unregisters every tool', () => {
  const { ctx, registered } = mockCtx()
  const { registry, resolver } = wire([fakeProvider()])
  const dispose = registerTools(ctx, { registry, resolver, config: makeConfig() })
  assert.equal(typeof dispose, 'function')
  assert.equal(registered.length, 6)
  dispose()
  assert.equal(registered.length, 0)
  dispose()
  assert.equal(registered.length, 0, 'disposal must be idempotent')
})

test('foreground dispatch returns a lossless value', async () => {
  const registered = []
  const ctx = {
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
    get: () => undefined,
  }
  const { registry, resolver } = wire([fakeProvider()])
  registerTools(ctx, { registry, resolver, config: makeConfig() })
  const tool = registered.find((entry) => entry.name === 'agent_dispatch')
  const value = await tool.execute({ provider: 'fake', prompt: 'hello' }, { signal: new AbortController().signal })
  assert.equal(value.provider, 'fake')
  assert.equal(value.text, 'answer:hello')
  assert.equal(value.externalSessionId, 'ext-1')
  assert.equal(value.backend, 'cli')
  assert.equal(typeof value.durationMs, 'number')
  assert.deepEqual(value, JSON.parse(JSON.stringify(value)))
})

test('background dispatch passes a SessionId string owner and returns the id string', async () => {
  const { ctx, registered, jobsStarted } = mockCtx()
  const { registry, resolver } = wire([fakeProvider()])
  registerTools(ctx, { registry, resolver, config: makeConfig() })
  const tool = registered.find((entry) => entry.name === 'agent_dispatch')
  const exec = { agent: { id: 'agent-1', sessionId: 'session-42' }, signal: new AbortController().signal }
  const value = await tool.execute({ provider: 'fake', prompt: 'long task', background: true }, exec)
  assert.deepEqual(value, { kind: 'background', jobId: 'agent-alliance-job-1' })
  assert.equal(jobsStarted.length, 1)
  const spec = jobsStarted[0]
  assert.equal(spec.kind, 'agent-alliance')
  assert.equal(spec.owner, 'session-42')
  assert.equal(typeof spec.owner, 'string', 'owner must be the SessionId string, never the Agent')
  assert.match(spec.label, /fake/)
  assert.equal(typeof spec.run, 'function')
})

test('background dispatch settles completed and appends the answer text', async () => {
  const { ctx, registered, jobsStarted } = mockCtx()
  const { registry, resolver } = wire([fakeProvider()])
  registerTools(ctx, { registry, resolver, config: makeConfig() })
  const tool = registered.find((entry) => entry.name === 'agent_dispatch')
  await tool.execute({ provider: 'fake', prompt: 'work', background: true }, { agent: { sessionId: 's-1' }, signal: new AbortController().signal })
  const appended = []
  const hooks = jobsStarted[0].run({ append: (text) => appended.push(text), updateProgress: () => {} })
  const outcome = await hooks.done
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.result, /answer:work/)
  assert.match(appended.join('\n'), /answer:work/)
})

test('background dispatch reports a failed outcome instead of rejecting done', async () => {
  const { ctx, registered, jobsStarted } = mockCtx()
  const failing = fakeProvider({ dispatch: async () => { throw new Error('boom') } })
  const { registry, resolver } = wire([failing])
  registerTools(ctx, { registry, resolver, config: makeConfig() })
  const tool = registered.find((entry) => entry.name === 'agent_dispatch')
  await tool.execute({ provider: 'fake', prompt: 'work', background: true }, { signal: new AbortController().signal })
  const hooks = jobsStarted[0].run({ append: () => {}, updateProgress: () => {} })
  const outcome = await hooks.done
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.detail, /boom/)
})

test('background cancel aborts the dispatched work', async () => {
  const { ctx, registered, jobsStarted } = mockCtx()
  let aborted = false
  const slow = fakeProvider({
    dispatch: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true
        reject(new Error('aborted'))
      })
    }),
  })
  const { registry, resolver } = wire([slow])
  registerTools(ctx, { registry, resolver, config: makeConfig() })
  const tool = registered.find((entry) => entry.name === 'agent_dispatch')
  await tool.execute({ provider: 'fake', prompt: 'work', background: true }, { signal: new AbortController().signal })
  const hooks = jobsStarted[0].run({ append: () => {}, updateProgress: () => {} })
  hooks.cancel('user asked')
  const outcome = await hooks.done
  assert.equal(aborted, true)
  assert.equal(outcome.status, 'failed')
})

test('background dispatch without an agent still passes no owner', async () => {
  const { ctx, registered, jobsStarted } = mockCtx()
  const { registry, resolver } = wire([fakeProvider()])
  registerTools(ctx, { registry, resolver, config: makeConfig() })
  const tool = registered.find((entry) => entry.name === 'agent_dispatch')
  await tool.execute({ provider: 'fake', prompt: 'work', background: true }, {})
  assert.equal(jobsStarted[0].owner, undefined)
})

test('inline fallback: no jobs service runs the work and returns the foreground value', async () => {
  const { ctx, registered, jobsStarted } = mockCtx({ withJobs: false })
  const { registry, resolver } = wire([fakeProvider()])
  registerTools(ctx, { registry, resolver, config: makeConfig() })
  const tool = registered.find((entry) => entry.name === 'agent_dispatch')
  const value = await tool.execute({ provider: 'fake', prompt: 'inline', background: true }, { agent: { sessionId: 's-1' } })
  assert.equal(jobsStarted.length, 0)
  assert.equal(value.kind, undefined, 'inline fallback must not report a job id')
  assert.equal(value.text, 'answer:inline')
  assert.equal(value.provider, 'fake')
})

test('inline fallback also covers the roundtable background default', async () => {
  const { ctx, registered, jobsStarted } = mockCtx({ withJobs: false })
  const { registry, resolver } = wire([fakeProvider({ id: 'a' })])
  registerTools(ctx, { registry, resolver, config: makeConfig() })
  const tool = registered.find((entry) => entry.name === 'agent_roundtable')
  const value = await tool.execute({ prompt: 'compare' }, { signal: new AbortController().signal })
  assert.equal(jobsStarted.length, 0)
  assert.equal(typeof value.text, 'string')
  assert.match(value.text, /answer:compare/)
})

test('roundtable background isolates member failures and reports them', async () => {
  const { ctx, registered, jobsStarted } = mockCtx()
  const good = fakeProvider({ id: 'a', dispatch: async ({ prompt }) => ({ text: 'A:' + prompt }) })
  const bad = fakeProvider({ id: 'b', dispatch: async () => { throw new Error('b broke') } })
  const { registry, resolver } = wire([good, bad])
  registerTools(ctx, { registry, resolver, config: makeConfig() })
  const tool = registered.find((entry) => entry.name === 'agent_roundtable')
  const value = await tool.execute({ prompt: 'design review' }, { signal: new AbortController().signal })
  assert.deepEqual(value, { kind: 'background', jobId: 'agent-alliance-job-1' })
  const hooks = jobsStarted[0].run({ append: () => {}, updateProgress: () => {} })
  const outcome = await hooks.done
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.result, /\[a\]/)
  assert.match(outcome.result, /A:design review/)
  assert.match(outcome.result, /\[b\]/)
})

test('roundtable rounds clamp to 1..3', async () => {
  const { ctx, registered } = mockCtx({ withJobs: false })
  const { registry, resolver } = wire([fakeProvider({ id: 'a' })])
  registerTools(ctx, { registry, resolver, config: makeConfig() })
  const tool = registered.find((entry) => entry.name === 'agent_roundtable')
  const value = await tool.execute({ prompt: 'q', rounds: 9, background: false }, { signal: new AbortController().signal })
  assert.ok(value.rounds <= 3, 'rounds must clamp to at most 3, got ' + value.rounds)
})

test('unknown provider rejects with the registry error', async () => {
  const { ctx, registered } = mockCtx()
  const { registry, resolver } = wire([fakeProvider()])
  registerTools(ctx, { registry, resolver, config: makeConfig() })
  const tool = registered.find((entry) => entry.name === 'agent_dispatch')
  await assert.rejects(() => tool.execute({ provider: 'nope', prompt: 'x' }, {}), /unknown provider/)
})

test('sessions and session_read pass through the CLI provider', async () => {
  const { ctx, registered } = mockCtx()
  const { registry, resolver } = wire([fakeProvider()])
  registerTools(ctx, { registry, resolver, config: makeConfig() })
  const sessions = registered.find((entry) => entry.name === 'agent_sessions')
  const read = registered.find((entry) => entry.name === 'agent_session_read')
  const listed = await sessions.execute({ provider: 'fake', limit: 5 }, {})
  assert.equal(listed.sessions[0].id, 's1')
  const transcript = await read.execute({ provider: 'fake', sessionId: 's1' }, {})
  assert.equal(transcript.messages[0].text, 'q-s1')
})

test('tool values stay lossless JSON (undefined fields are dropped)', async () => {
  const messy = fakeProvider({
    listSessions: async () => [{ id: 's1', title: undefined, cwd: undefined, createdAt: null }],
    readSession: async () => ({ title: undefined, messages: [{ role: 'user', text: 'x' }] }),
  })
  const { ctx, registered } = mockCtx()
  const { registry, resolver } = wire([messy])
  registerTools(ctx, { registry, resolver, config: makeConfig() })
  const sessions = registered.find((entry) => entry.name === 'agent_sessions')
  const read = registered.find((entry) => entry.name === 'agent_session_read')
  const listed = await sessions.execute({ provider: 'fake' }, {})
  assert.deepEqual(listed, JSON.parse(JSON.stringify(listed)))
  assert.ok(!('title' in listed.sessions[0]))
  const transcript = await read.execute({ provider: 'fake', sessionId: 's1' }, {})
  assert.deepEqual(transcript, JSON.parse(JSON.stringify(transcript)))
})

test('import_scan lists sessions with their import state', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-tools-'))
  const provider = fakeProvider({ listSessions: async () => [{ id: 's1', title: 't1', createdAt: null }] })
  const { ctx, registered } = mockCtx()
  const { registry, resolver } = wire([provider])
  registerTools(ctx, { registry, resolver, config: makeConfig(), home })
  const tool = registered.find((entry) => entry.name === 'agent_import_scan')
  const value = await tool.execute({ provider: 'fake' }, {})
  assert.equal(value.total, 1)
  assert.equal(value.sessions[0].imported, false)
})

test('import_scan isolates one failing provider and still reports the others', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-tools-'))
  const good = fakeProvider({ id: 'good', listSessions: async () => [{ id: 's1', title: 't1' }] })
  const bad = fakeProvider({ id: 'bad', listSessions: async () => { throw new Error('no database') } })
  const { ctx, registered } = mockCtx()
  const { registry, resolver } = wire([good, bad])
  registerTools(ctx, { registry, resolver, config: makeConfig(), home })
  const tool = registered.find((entry) => entry.name === 'agent_import_scan')
  const value = await tool.execute({}, {})
  assert.equal(value.total, 1)
  assert.equal(value.sessions[0].provider, 'good')
})

test('presentation: dispatch uses a terminal card and a generic card in the background', () => {
  const { ctx, registered } = mockCtx()
  const { registry, resolver } = wire([fakeProvider()])
  registerTools(ctx, { registry, resolver, config: makeConfig() })
  const tool = registered.find((entry) => entry.name === 'agent_dispatch')
  assert.equal(tool.presentCall({ provider: 'fake', prompt: 'do it' }, {}).card, 'terminal')
  const background = tool.presentCall({ provider: 'fake', prompt: 'do it', background: true }, {})
  assert.equal(background.card, 'generic')
  assert.equal(background.kind, 'execute')
  const result = tool.presentResult({ provider: 'fake', prompt: 'p' }, { content: [{ type: 'text', text: 'answer' }], isError: false })
  assert.equal(result.card, 'terminal')
  assert.equal(result.output, 'answer')
})

test('maxConcurrent bounds in-flight dispatches', async () => {
  let inFlight = 0
  let peak = 0
  const slow = (id) => fakeProvider({
    id,
    dispatch: async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 40))
      inFlight -= 1
      return { text: 'done-' + id }
    },
  })
  const providers = [slow('a'), slow('b'), slow('c')]
  const { ctx, registered } = mockCtx()
  const { registry, resolver } = wire(providers)
  registerTools(ctx, { registry, resolver, config: makeConfig({ maxConcurrent: 2 }) })
  const tool = registered.find((entry) => entry.name === 'agent_dispatch')
  await Promise.all(providers.map((provider) => tool.execute(
    { provider: provider.id, prompt: 'p' },
    { signal: new AbortController().signal },
  )))
  assert.ok(peak <= 2, 'peak=' + peak + ' must be <= maxConcurrent=2')
})

test('an abort while queued rejects instead of waiting forever', async () => {
  const blocker = fakeProvider({
    id: 'blocker',
    dispatch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      return { text: 'slow' }
    },
  })
  const { ctx, registered } = mockCtx()
  const { registry, resolver } = wire([blocker])
  registerTools(ctx, { registry, resolver, config: makeConfig({ maxConcurrent: 1 }) })
  const tool = registered.find((entry) => entry.name === 'agent_dispatch')
  const first = tool.execute({ provider: 'blocker', prompt: 'first' }, { signal: new AbortController().signal })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const controller = new AbortController()
  const second = tool.execute({ provider: 'blocker', prompt: 'second' }, { signal: controller.signal })
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(() => second, /aborted while queued/)
  await first
})

test('an already-aborted signal never executes the guarded work', async () => {
  const { registerTools } = await import('../src/tools.js')
  const tools = []
  const ctx = { tools: { register: (def) => { tools.push(def); return () => {} } } }
  registerTools(ctx, {
    resolver: {
      resolve: () => ({ id: 'p1', kind: 'cli', available: true, async dispatch() { return { text: 'ran', backend: 'cli' } } }),
      list: () => [{ id: 'p1', label: 'P1', kind: 'cli', available: true }],
    },
    registry: { list: () => [{ id: 'p1', label: 'P1' }], get: () => ({}) },
    config: { providers: {}, defaults: { timeoutMs: 1000, maxConcurrent: 1, defaultCwd: '' } },
    home: '/tmp',
  })
  const dispatch = tools.find((t) => t.name === 'agent_dispatch')
  assert.ok(dispatch !== undefined, 'agent_dispatch must be registered')

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => dispatch.execute({ provider: 'p1', prompt: 'x' }, { signal: controller.signal, agent: undefined }),
    (error) => {
      assert.match(String(error.message), /abort/i)
      return true
    },
    'a cancelled call must reject instead of spending quota',
  )
})

test('a capacity refusal is not silently converted into inline execution', async () => {
  const { registerTools } = await import('../src/tools.js')
  const tools = []
  const ctx = {
    tools: { register: (def) => { tools.push(def); return () => {} } },
    // A jobs service that refuses for capacity, the way dsh-jobs-local does at
    // its per-owner cap. Falling back to inline here would spend the whole
    // foreground budget with no job id to cancel.
    get: (name) => name === 'jobs'
      ? { start() { throw new Error('background job limit reached for this owner (limit: 4)') } }
      : undefined,
    logger: { warn() {} },
  }
  registerTools(ctx, {
    resolver: {
      resolve: () => ({ id: 'p1', kind: 'cli', available: true, async dispatch() { return { text: 'ran', backend: 'cli' } } }),
      list: () => [{ id: 'p1', label: 'P1', kind: 'cli', available: true }],
    },
    registry: { list: () => [{ id: 'p1', label: 'P1' }], get: () => ({}) },
    config: { providers: {}, defaults: { timeoutMs: 1000, maxConcurrent: 1, defaultCwd: '' } },
    home: '/tmp',
  })
  const dispatch = tools.find((t) => t.name === 'agent_dispatch')
  await assert.rejects(
    () => dispatch.execute({ provider: 'p1', prompt: 'x', background: true }, { signal: new AbortController().signal, agent: { sessionId: 's1' } }),
    (error) => {
      assert.match(String(error.message), /limit reached/)
      return true
    },
    'a capacity refusal must surface instead of degrading to inline execution',
  )
})

test('the concurrency limit holds across repeated batches, not just the first', async () => {
  // A promoted queue entry used to skip the slot increment while every
  // completion decremented it, so `active` drifted below the real in-flight
  // count. Saturate the gate with an initial batch so entries actually queue,
  // then send a second batch: a broken counter lets it run at double the limit.
  const { registerTools } = await import('../src/tools.js')
  const tools = []
  const ctx = { tools: { register: (def) => { tools.push(def); return () => {} } } }
  let active = 0
  let peak = 0
  const backend = {
    id: 'p1',
    kind: 'cli',
    available: true,
    async dispatch() {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active -= 1
      return { text: 'ok', backend: 'cli' }
    },
  }
  registerTools(ctx, {
    resolver: { resolve: () => backend, list: () => [{ id: 'p1', label: 'P1', kind: 'cli', available: true }] },
    registry: { list: () => [{ id: 'p1', label: 'P1' }], get: () => ({}) },
    config: { providers: {}, defaults: { timeoutMs: 5000, maxConcurrent: 2, defaultCwd: '' } },
    home: '/tmp',
  })
  const dispatch = tools.find((t) => t.name === 'agent_dispatch')
  const call = (prompt) => dispatch.execute(
    { provider: 'p1', prompt },
    { signal: new AbortController().signal, agent: undefined },
  )

  // Six concurrent foreground dispatches against maxConcurrent = 2: four queue.
  peak = 0
  await Promise.all(Array.from({ length: 6 }, (_, i) => call('a' + i)))
  assert.ok(peak <= 2, `first batch reached ${peak}, above the limit of 2`)

  // The second batch must still be bounded; a drifted counter doubles it.
  peak = 0
  await Promise.all(Array.from({ length: 6 }, (_, i) => call('b' + i)))
  assert.ok(peak <= 2, `second batch reached ${peak}, above the limit of 2`)
})
