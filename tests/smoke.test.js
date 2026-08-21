import { test } from 'node:test'
import assert from 'node:assert/strict'

test('插件模块导出 name/inject/apply', async () => {
  const mod = await import('../src/index.js')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.name, 'string' && mod.name.length > 0 ? 'string' : 'undefined')
  assert.ok(Array.isArray(mod.inject))
})
