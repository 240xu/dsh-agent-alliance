import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.js'

function mockCtx() {
  const registered = []
  return { tools: { register: (t) => registered.push(t) }, registered }
}

test('apply 注册三个工具', () => {
  const ctx = mockCtx()
  apply(ctx, { config: { providers: {}, defaults: {} } })
  assert.equal(ctx.registered.length, 3)
})

test('坏配置不炸（防御性容错）', () => {
  const ctx = mockCtx()
  assert.doesNotThrow(() => apply(ctx, { configError: new Error('bad json') }))
})

test('缺 tools 服务不炸', () => {
  assert.doesNotThrow(() => apply({}, { config: { providers: {}, defaults: {} } }))
})
