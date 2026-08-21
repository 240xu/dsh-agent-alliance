import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defineProvider, createRegistry } from '../src/provider/types.js'

const fake = (id) => defineProvider({ id, label: id.toUpperCase(), dispatch: async () => ({ text: '' }) })

test('defineProvider 校验必备字段', () => {
  assert.throws(() => defineProvider({ label: 'x' }), /id/)
  assert.throws(() => defineProvider({ id: 'x' }), /dispatch|label/)
  const p = fake('ok')
  assert.equal(p.id, 'ok')
})

test('registry：list/get/detectAll', async () => {
  const a = fake('a')
  const b = { ...fake('b'), detect: async () => ({ available: true, version: '1' }) }
  const reg = createRegistry([a, b])
  assert.deepEqual(reg.list().map(p => p.id), ['a', 'b'])
  assert.equal(reg.get('b'), b)
  assert.throws(() => reg.get('nope'), /unknown provider/i)
  const states = await reg.detectAll()
  const sa = states.find(s => s.id === 'a')
  assert.equal(sa.available, false)
  assert.match(sa.detail, /no detect/)
  const sb = states.find(s => s.id === 'b')
  assert.equal(sb.available, true)
  assert.equal(sb.version, '1')
})
