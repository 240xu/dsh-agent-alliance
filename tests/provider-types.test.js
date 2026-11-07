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

test('a non-zero CLI exit fails the dispatch even when the CLI printed text', async () => {
  // These CLIs write their own error messages to stdout ("quota exceeded",
  // "429 Too Many Requests"). Treating printed text as success makes a broken
  // member look like a peer with an opinion at the roundtable layer.
  const { makeCodexProvider } = await import('../src/provider/codex.js')
  const provider = makeCodexProvider({
    config: {},
    deps: {
      spawnCli: async () => ({ code: 1, stdout: 'Error: quota exceeded', stderr: '' }),
      paths: { codexJs: '/bin/false' },
    },
  })
  await assert.rejects(
    () => provider.dispatch({ prompt: 'hi', timeoutMs: 1000 }),
    (error) => {
      assert.match(String(error.message), /exit 1/)
      assert.match(String(error.message), /quota exceeded/)
      return true
    },
  )
})

test('a zero exit still returns the parsed answer', async () => {
  const { makeCodexProvider } = await import('../src/provider/codex.js')
  const provider = makeCodexProvider({
    config: {},
    deps: {
      spawnCli: async () => ({ code: 0, stdout: 'the answer', stderr: '' }),
      paths: { codexJs: '/bin/true' },
    },
  })
  const result = await provider.dispatch({ prompt: 'hi', timeoutMs: 1000 })
  assert.match(result.text, /the answer/)
})
