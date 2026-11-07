import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackendResolver } from '../src/backend.js'
import { createRegistry } from '../src/provider/types.js'

// 官方 provider 只经 ctx.subagents 暴露；测试用假的实现记录调用，绝不启动真实子代理。
function fakeSubagents({ names = ['codex'], result, failure } = {}) {
  const calls = { list: 0, getProvider: [], start: [], dispose: 0 }
  const service = {
    list() {
      calls.list++
      return [...names]
    },
    getProvider(name) {
      calls.getProvider.push(name)
      return names.includes(name) ? { name } : undefined
    },
    async startActivation(spec) {
      calls.start.push(spec)
      return {
        childId: 'child-1',
        result: failure ? Promise.reject(failure) : Promise.resolve(result ?? defaultResult),
        async dispose() {
          calls.dispose++
        },
      }
    },
  }
  return { service, calls }
}

const defaultResult = {
  output: [{ type: 'text', text: 'official answer' }],
  stopReason: 'completed',
}

function fakeParent() {
  const parent = { id: 'session-parent' }
  return { parent, agents: { get: (id) => (id === parent.id ? parent : undefined) } }
}

function cliProvider(id, overrides = {}) {
  return {
    id,
    label: id.toUpperCase(),
    dispatch: async (request) => ({ text: 'cli:' + request.prompt, externalSessionId: 'cli-session' }),
    ...overrides,
  }
}

const baseConfig = {
  providers: {
    claude: { enabled: true, subagentProvider: 'claude-code' },
    codex: { enabled: true, subagentProvider: 'codex' },
    opencode: { enabled: true },
  },
}

test('subagent path is preferred when a registered official provider and a live parent exist', async () => {
  const { service, calls } = fakeSubagents({ names: ['codex'], result: { output: [{ type: 'text', text: 'official answer' }], stopReason: 'completed' } })
  const cliDispatched = []
  const registry = createRegistry([cliProvider('codex', { dispatch: async () => { cliDispatched.push(true); return { text: 'cli' } } })])
  const { parent, agents } = fakeParent()
  const resolver = createBackendResolver({ ctx: { subagents: service, agents }, registry, config: baseConfig })

  const backend = resolver.resolve({ provider: 'codex', parent })
  assert.equal(backend.kind, 'subagent')
  assert.equal(backend.id, 'codex')

  const out = await backend.dispatch({ prompt: 'do the thing', cwd: '/work' })
  assert.equal(out.text, 'official answer')
  assert.equal(out.stopReason, 'completed')
  assert.equal(out.externalSessionId, 'child-1')
  assert.equal(out.backend, 'subagent')
  assert.equal(typeof out.durationMs, 'number')
  assert.equal(calls.start.length, 1)
  assert.equal(calls.dispose, 1)
  assert.deepEqual(cliDispatched, [])

  const spec = calls.start[0]
  assert.equal(spec.provider, 'codex')
  assert.equal(spec.delivery, 'caller')
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: 'do the thing' }])
  assert.equal(spec.request.parent, parent)
  assert.equal(spec.request.cwd, '/work')
  // 官方 provider 报告 NO_START_CAPABILITIES：这些键一个都不能出现。
  assert.equal('maxDepth' in spec.request, false)
  assert.equal('agentOptions' in spec.request, false)
  assert.equal('toolFilter' in spec.request, false)
  assert.equal('persona' in spec.request, false)
  assert.ok(spec.signal)
})

test('subagent path omits cwd when the caller supplied none', async () => {
  const { service, calls } = fakeSubagents({ names: ['codex'] })
  const { parent, agents } = fakeParent()
  const resolver = createBackendResolver({
    ctx: { subagents: service, agents },
    registry: createRegistry([cliProvider('codex')]),
    config: baseConfig,
  })
  await resolver.resolve({ provider: 'codex', parent }).dispatch({ prompt: 'x' })
  assert.equal('cwd' in calls.start[0].request, false)
})

test('falls back to the CLI backend without a parent agent', async () => {
  const { service, calls } = fakeSubagents({ names: ['codex'] })
  const registry = createRegistry([cliProvider('codex')])
  const resolver = createBackendResolver({ ctx: { subagents: service, agents: {} }, registry, config: baseConfig })

  const backend = resolver.resolve({ provider: 'codex' })
  assert.equal(backend.kind, 'cli')
  assert.equal(backend.available, true)
  const out = await backend.dispatch({ prompt: 'hello', resumeSessionId: 'ext-1' })
  assert.equal(out.text, 'cli:hello')
  assert.equal(out.externalSessionId, 'cli-session')
  assert.equal(out.backend, 'cli')
  assert.equal(calls.start.length, 0)
})

test('falls back to CLI when the configured subagent provider is not registered', async () => {
  const { service, calls } = fakeSubagents({ names: [] })
  const { parent, agents } = fakeParent()
  const resolver = createBackendResolver({
    ctx: { subagents: service, agents },
    registry: createRegistry([cliProvider('codex')]),
    config: baseConfig,
  })

  const backend = resolver.resolve({ provider: 'codex', parent })
  assert.equal(backend.kind, 'cli')
  const out = await backend.dispatch({ prompt: 'hi' })
  assert.equal(out.text, 'cli:hi')
  assert.equal(calls.start.length, 0)
})

test('falls back to CLI when the parent is not a live agent', async () => {
  const { service, calls } = fakeSubagents({ names: ['codex'] })
  const registry = createRegistry([cliProvider('codex')])
  // agents 服务按 id 取不回这个对象，因此 parent 不是活体。
  const resolver = createBackendResolver({ ctx: { subagents: service, agents: { get: () => undefined } }, registry, config: baseConfig })
  const backend = resolver.resolve({ provider: 'codex', parent: { id: 'stale' } })
  assert.equal(backend.kind, 'cli')
  assert.equal(calls.start.length, 0)
})

test('resumeSessionId is rejected before any child is started', async () => {
  const { service, calls } = fakeSubagents({ names: ['codex'] })
  const { parent, agents } = fakeParent()
  const resolver = createBackendResolver({
    ctx: { subagents: service, agents },
    registry: createRegistry([cliProvider('codex')]),
    config: baseConfig,
  })

  const backend = resolver.resolve({ provider: 'codex', parent })
  await assert.rejects(
    () => backend.dispatch({ prompt: 'continue', resumeSessionId: 'external-42' }),
    (err) => {
      assert.match(err.message, /resumeSessionId/i)
      assert.match(err.message, /CLI provider/i)
      assert.match(err.message, /one-shot/i)
      return true
    },
  )
  // A resume request must cost nothing: no child is spawned, so there is
  // nothing to dispose. Guarding after startActivation used to bill the caller
  // for a full process start just to produce this error.
  assert.equal(calls.start.length, 0, 'startActivation must not run for a rejected resume request')
  assert.equal(calls.dispose, 0)
})

test('dispose runs exactly once when the activation result rejects', async () => {
  const { service, calls } = fakeSubagents({ names: ['codex'], failure: new Error('child crashed') })
  const { parent, agents } = fakeParent()
  const resolver = createBackendResolver({
    ctx: { subagents: service, agents },
    registry: createRegistry([cliProvider('codex')]),
    config: baseConfig,
  })

  await assert.rejects(() => resolver.resolve({ provider: 'codex', parent }).dispatch({ prompt: 'x' }), /child crashed/)
  assert.equal(calls.dispose, 1)
  assert.equal(calls.start.length, 1)
})

test('a dispose failure surfaces when dispatch otherwise succeeded', async () => {
  const { service } = fakeSubagents({ names: ['codex'] })
  const disposeFailure = new Error('teardown failed')
  const failingDispose = {
    ...service,
    async startActivation() {
      return {
        childId: 'child-1',
        result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
        async dispose() {
          throw disposeFailure
        },
      }
    },
  }
  const { parent, agents } = fakeParent()
  const resolver = createBackendResolver({
    ctx: { subagents: failingDispose, agents },
    registry: createRegistry([cliProvider('codex')]),
    config: baseConfig,
  })
  await assert.rejects(() => resolver.resolve({ provider: 'codex', parent }).dispatch({ prompt: 'x' }), /teardown failed/)
})

test('a dispose failure does not replace the primary dispatch error', async () => {
  const { service } = fakeSubagents({ names: ['codex'] })
  const failingDispose = {
    ...service,
    async startActivation() {
      return {
        childId: 'child-1',
        result: Promise.reject(new Error('child crashed')),
        async dispose() {
          throw new Error('teardown failed')
        },
      }
    },
  }
  const { parent, agents } = fakeParent()
  const resolver = createBackendResolver({
    ctx: { subagents: failingDispose, agents },
    registry: createRegistry([cliProvider('codex')]),
    config: baseConfig,
  })
  await assert.rejects(
    () => resolver.resolve({ provider: 'codex', parent }).dispatch({ prompt: 'x' }),
    (err) => {
      assert.match(err.message, /child crashed/)
      assert.match(err.disposeError.message, /teardown failed/)
      return true
    },
  )
})

test('subagent output maps only text blocks into one string', async () => {
  const { service } = fakeSubagents({
    names: ['codex'],
    result: {
      output: [
        { type: 'text', text: 'first ' },
        { type: 'tool-call', name: 'shell', arguments: '{}' },
        { type: 'text', text: 'second' },
        { type: 'text', text: '' },
      ],
      stopReason: 'completed',
    },
  })
  const { parent, agents } = fakeParent()
  const resolver = createBackendResolver({
    ctx: { subagents: service, agents },
    registry: createRegistry([cliProvider('codex')]),
    config: baseConfig,
  })
  const out = await resolver.resolve({ provider: 'codex', parent }).dispatch({ prompt: 'x' })
  assert.equal(out.text, 'first second')
})

test('a non-completed stop with empty text throws the diagnostic after disposal', async () => {
  const { service, calls } = fakeSubagents({
    names: ['codex'],
    result: { output: [{ type: 'text', text: '' }], stopReason: 'error', diagnostic: 'rate limited upstream' },
  })
  const { parent, agents } = fakeParent()
  const resolver = createBackendResolver({
    ctx: { subagents: service, agents },
    registry: createRegistry([cliProvider('codex')]),
    config: baseConfig,
  })

  await assert.rejects(() => resolver.resolve({ provider: 'codex', parent }).dispatch({ prompt: 'x' }), /rate limited upstream/)
  assert.equal(calls.dispose, 1)
})

test('a non-completed stop that still produced text is returned, not thrown', async () => {
  const { service } = fakeSubagents({
    names: ['codex'],
    result: { output: [{ type: 'text', text: 'partial' }], stopReason: 'max-tokens', diagnostic: 'hit the cap' },
  })
  const { parent, agents } = fakeParent()
  const resolver = createBackendResolver({
    ctx: { subagents: service, agents },
    registry: createRegistry([cliProvider('codex')]),
    config: baseConfig,
  })

  const out = await resolver.resolve({ provider: 'codex', parent }).dispatch({ prompt: 'x' })
  assert.equal(out.text, 'partial')
  assert.equal(out.stopReason, 'max-tokens')
})

test('unknown provider throws unknown provider: <id>', () => {
  const { service } = fakeSubagents({ names: ['codex'] })
  const { parent, agents } = fakeParent()
  const resolver = createBackendResolver({
    ctx: { subagents: service, agents },
    registry: createRegistry([cliProvider('codex')]),
    config: baseConfig,
  })
  assert.throws(() => resolver.resolve({ provider: 'nope' }), /^Error: unknown provider: nope$/)
  assert.throws(() => resolver.resolve({ provider: 'nope', parent }), /^Error: unknown provider: nope$/)
})

test('missing ctx.subagents stays CLI-only and never throws for the absent service', async () => {
  const registry = createRegistry([cliProvider('codex')])
  const resolver = createBackendResolver({
    // 无 ctx.subagents、无 ctx.get（headless / CLI-only 组合）
    ctx: { agents: { get: () => undefined } },
    registry,
    config: baseConfig,
  })
  const { parent } = fakeParent()

  const backend = resolver.resolve({ provider: 'codex', parent })
  assert.equal(backend.kind, 'cli')
  const out = await backend.dispatch({ prompt: 'headless' })
  assert.equal(out.text, 'cli:headless')

  const infos = resolver.list(parent)
  const byId = Object.fromEntries(infos.map(info => [info.id, info]))
  // 服务缺失时即便有 parent，也只能报 CLI；只有 codex 有 CLI 后端。
  assert.deepEqual(Object.keys(byId).sort(), ['claude', 'codex', 'opencode'])
  assert.equal(byId.codex.kind, 'cli')
  assert.equal(byId.codex.available, true)
  assert.equal(byId.claude.kind, 'cli')
  assert.equal(byId.claude.available, false)
  assert.equal(byId.opencode.available, false)
})

test('a Cordis-style context that throws on uninjected service access still takes the CLI path', async () => {
  const registry = createRegistry([cliProvider('codex')])
  // 真实 Cordis：未注入的服务经 ctx.get 返回 undefined，直接读属性抛
  // `cannot get property "subagents" without inject`。
  const ctx = {
    get(name) {
      return undefined
    },
    agents: undefined,
  }
  const throwingCtx = new Proxy(ctx, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
  const resolver = createBackendResolver({ ctx: throwingCtx, registry, config: baseConfig })
  const { parent } = fakeParent()

  const backend = resolver.resolve({ provider: 'codex', parent })
  assert.equal(backend.kind, 'cli')
  const out = await backend.dispatch({ prompt: 'no service' })
  assert.equal(out.text, 'cli:no service')
  assert.deepEqual(resolver.list(parent).map(info => info.kind), ['cli', 'cli', 'cli'])
})

test('list reports subagent kind for a resolved official provider and cli otherwise', () => {
  const { service, calls } = fakeSubagents({ names: ['codex'] })
  const { parent, agents } = fakeParent()
  const registry = createRegistry([cliProvider('codex'), cliProvider('claude')])
  const resolver = createBackendResolver({ ctx: { subagents: service, agents }, registry, config: baseConfig })

  const withParent = resolver.list(parent)
  const byId = Object.fromEntries(withParent.map(info => [info.id, info]))
  assert.equal(byId.codex.kind, 'subagent')
  assert.equal(byId.codex.available, true)
  assert.match(byId.codex.detail, /codex/)
  // claude-code 未注册 → 回落 CLI
  assert.equal(byId.claude.kind, 'cli')
  assert.equal(byId.opencode.kind, 'cli')
  assert.equal(byId.opencode.available, false)
  assert.equal(calls.start.length, 0)

  const withoutParent = resolver.list()
  assert.deepEqual(withoutParent.map(info => info.kind), ['cli', 'cli', 'cli'])
  assert.equal(calls.start.length, 0)
})

test('list deduplicates config-only providers and never starts a run', () => {
  const { service, calls } = fakeSubagents({ names: ['codex'] })
  const registry = createRegistry([cliProvider('codex')])
  const resolver = createBackendResolver({ ctx: { subagents: service }, registry, config: baseConfig })
  const ids = resolver.list().map(info => info.id)
  assert.deepEqual(ids, ['codex', 'claude', 'opencode'])
  assert.equal(calls.start.length, 0)
  // 没有 parent 时官方路径不评估，连 list() 探测都不需要。
  assert.equal(calls.getProvider.length, 0)
})

test('list() explains why the official path was skipped when the name does not match', async () => {
  const { service } = fakeSubagents({ names: ['codex-renamed'] })
  const resolver = createBackendResolver({
    ctx: { subagents: service, agents: fakeParent().agents },
    registry: createRegistry([cliProvider('codex')]),
    config: baseConfig, // subagentProvider: 'codex'
  })
  const info = resolver.list(undefined).find((row) => row.id === 'codex')
  assert.equal(info.kind, 'cli')
  // A bundle whose providerName differs from our configured subagentProvider
  // leaves the official path silently unused; the reason must be visible.
  assert.match(String(info.detail), /not registered/)
  assert.match(String(info.detail), /codex-renamed/, 'the actual registered names must be shown')
})

test('a full subagent pool is reported as someone else holding it', async () => {
  const { service } = fakeSubagents({ names: ['codex'] })
  const failing = {
    ...service,
    async startActivation() {
      const error = new Error('activation limit reached')
      error.code = 'ACTIVATION_LIMIT_REACHED'
      throw error
    },
  }
  const { parent, agents } = fakeParent()
  const resolver = createBackendResolver({
    ctx: { subagents: failing, agents },
    registry: createRegistry([cliProvider('codex')]),
    config: baseConfig,
  })
  const backend = resolver.resolve({ provider: 'codex', parent })
  await assert.rejects(
    () => backend.dispatch({ prompt: 'work' }),
    (error) => {
      assert.match(String(error.message), /pool is full/)
      assert.match(String(error.message), /official subagent tool/)
      return true
    },
  )
})

test('a model override on the official path is reported as ignored', async () => {
  const { service } = fakeSubagents({ names: ['codex'], result: { output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' } })
  const { parent, agents } = fakeParent()
  const resolver = createBackendResolver({
    ctx: { subagents: service, agents },
    registry: createRegistry([cliProvider('codex')]),
    config: baseConfig,
  })
  const backend = resolver.resolve({ provider: 'codex', parent })
  const result = await backend.dispatch({ prompt: 'work', model: 'gpt-5' })
  // SubagentStartRequest has no model field, so the override cannot be applied.
  // Reporting it lets the caller see the truth instead of assuming it worked.
  assert.deepEqual(result.ignored, ['model'])
  assert.match(String(result.note), /not applied/)
})
