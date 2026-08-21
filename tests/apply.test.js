import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.js'

function mockCtx() {
  const registered = []
  return { tools: { register: (t) => registered.push(t) }, registered }
}

test('apply 注册四个工具', () => {
  const ctx = mockCtx()
  apply(ctx, { config: { providers: {}, defaults: {} } })
  assert.equal(ctx.registered.length, 6)
})

test('坏配置不炸（防御性容错）', () => {
  const ctx = mockCtx()
  assert.doesNotThrow(() => apply(ctx, { configError: new Error('bad json') }))
})

test('缺 tools 服务不炸', () => {
  assert.doesNotThrow(() => apply({}, { config: { providers: {}, defaults: {} } }))
})


test('有 webServer 时注册面板端点；无则挂 inject 兜底', async () => {
  const routes = []
  const mkCtx = (withWs) => ({
    tools: { register: () => {} },
    get(name) { return withWs && name === 'webServer' ? { register: (r) => routes.push(r) } : undefined },
    inject(services, cb) { cb({ webServer: { register: (r) => routes.push(r) } }) },
  })
  const opts = { config: { providers: {}, defaults: {} } }
  // 有 webServer：直接注册
  const ctx1 = mkCtx(true)
  apply(ctx1, opts)
  assert.equal(routes.length, 6)
  // 无 webServer：inject 兜底也注册
  const ctx2 = mkCtx(false)
  apply(ctx2, opts)
  assert.equal(routes.length, 12)
})
