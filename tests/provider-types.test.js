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

test('detectAll probes in parallel and stays inside its budget', async () => {
  const { createRegistry, defineProvider } = await import('../src/provider/types.js')
  const slow = (id, ms) => defineProvider({
    id,
    label: id,
    async dispatch() { return { text: '' } },
    // A CLI that hangs on --version must not hold the whole answer: serial
    // probing would reach the sum of every timeout.
    detect: () => new Promise((resolve) => setTimeout(() => resolve({ available: true }), ms)),
  })
  const registry = createRegistry([slow('a', 400), slow('b', 400), slow('c', 400)])
  const started = Date.now()
  const rows = await registry.detectAll({ budgetMs: 100 })
  const elapsed = Date.now() - started

  assert.equal(rows.length, 3)
  assert.ok(elapsed < 300, `probe took ${elapsed}ms; a serial probe would approach 1200ms`)
  for (const row of rows) {
    assert.equal(row.available, false, 'an unfinished probe is reported unknown, not available')
    assert.match(String(row.detail), /timed out/)
  }
})

test('a hung provider probe still settles within the budget', async () => {
  const { createRegistry, defineProvider } = await import('../src/provider/types.js')
  const hung = defineProvider({
    id: 'hung',
    label: 'Hung',
    dispatch: async () => ({ text: '' }),
    detect: () => new Promise(() => {}), // a CLI whose --version never returns
  })
  const registry = createRegistry([hung])
  const started = Date.now()
  const rows = await Promise.race([
    registry.detectAll({ budgetMs: 120 }),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('detectAll hung')), 1500)),
  ])
  const elapsed = Date.now() - started
  assert.ok(elapsed < 1000, `detectAll took ${elapsed}ms; a hung probe must time out`)
  assert.equal(rows[0].available, false)
  assert.match(String(rows[0].detail), /timed out/)
})

test('a timed-out probe aborts the losing detect so its child is reaped', async () => {
  const { createRegistry, defineProvider } = await import('../src/provider/types.js')
  const { spawnCli } = await import('../src/runner.js')
  let aborted = false
  const slow = defineProvider({
    id: 'slow',
    label: 'Slow',
    dispatch: async () => ({ text: '' }),
    async detect({ signal } = {}) {
      const r = await spawnCli({
        argv: [process.execPath, '-e', 'setTimeout(()=>{},5000)'],
        timeoutMs: 5000,
        signal,
      })
      aborted = r.aborted === true
      return { available: r.code === 0 }
    },
  })
  const registry = createRegistry([slow])
  const rows = await registry.detectAll({ budgetMs: 120 })
  assert.equal(rows[0].available, false)
  assert.match(String(rows[0].detail), /timed out/)
  await new Promise((resolve) => setTimeout(resolve, 120))
  // Without the abort, the `--version` child would live until its own 5s
  // timeout; a polling /state route would accumulate orphans.
  assert.equal(aborted, true, 'the losing probe must observe the abort')
})
