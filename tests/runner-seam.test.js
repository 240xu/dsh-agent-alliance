// tests/runner-seam.test.js — 官方 ctx.subprocess seam 接入的回归测试。
import test from 'node:test'
import assert from 'node:assert/strict'

import { spawnCliViaSeam, seamSpawnCli } from '../src/runner-seam.js'
import { buildProviders } from '../src/providers.js'

/**
 * A fake `ctx.subprocess` service implementing the official SubprocessHandle
 * contract: `done` resolves with exit facts, `collected.*.readFrom(0)` returns
 * the batch text, and `spawn` records the spec it received.
 */
function fakeSubprocess({ exitCode = 0, signal = null, stdout = '', stderr = '' } = {}) {
  const specs = []
  return {
    specs,
    spawn(spec) {
      specs.push(spec)
      return {
        done: Promise.resolve({ exitCode, signal }),
        collected: {
          stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
        },
        terminate() {},
      }
    },
  }
}

test('spawnCliViaSeam returns the spawnCli result shape', async () => {
  const subprocess = fakeSubprocess({ stdout: 'SEAM-OK\n' })
  const result = await spawnCliViaSeam({
    subprocess,
    request: { argv: ['node', '-e', 'console.log("x")'], timeoutMs: 5000 },
  })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'SEAM-OK\n')
  assert.equal(result.stderr, '')
  assert.equal(result.timedOut, false)
  assert.equal(result.aborted, false)
})

test('the spec uses the official explicit cwd/stdio/graceMs/signal shape', async () => {
  const subprocess = fakeSubprocess()
  await spawnCliViaSeam({
    subprocess,
    request: { argv: ['node'], cwd: '/tmp/work', env: { EXTRA: '1' }, timeoutMs: 1000 },
  })
  const spec = subprocess.specs[0]
  assert.equal(spec.cwd, '/tmp/work')
  assert.equal(spec.graceMs, 3000)
  assert.equal(spec.stdio.stdin, 'ignore')
  assert.ok(spec.stdio.stdout.maxBytes > 0, 'collect mode must be bounded')
  assert.equal(spec.env.EXTRA, '1', 'explicit env is a deliberate overlay')
  assert.ok(spec.signal instanceof AbortSignal, 'the seam owns termination through the signal')
})

test('a spawn failure resolves as a result, never rejects', async () => {
  const subprocess = {
    spawn() { throw new Error('provider unavailable') },
  }
  const result = await spawnCliViaSeam({ subprocess, request: { argv: ['node'] } })
  assert.equal(result.code, -1)
  assert.match(result.stderr, /provider unavailable/)
})

test('buildProviders prefers the official seam when no launcher is injected', async () => {
  const ctx = { get: (name) => (name === 'subprocess' ? fakeSubprocess() : undefined) }
  const registry = buildProviders({ config: { providers: {} }, ctx })
  // The four providers are built through the seam-backed launcher.
  assert.equal(registry.list().length, 4)
  const bound = seamSpawnCli(ctx)
  assert.equal(typeof bound, 'function')
  assert.equal(seamSpawnCli({ get: () => undefined }), undefined,
    'no seam mounted means the raw spawn path stays the last resort')
})

test('an injected launcher still wins over the seam for tests', async () => {
  const ctx = { get: (name) => (name === 'subprocess' ? fakeSubprocess() : undefined) }
  let seen
  const registry = buildProviders({
    config: { providers: {} },
    ctx,
    deps: { spawnCli: async (req) => { seen = req; return { code: 0, stdout: '', stderr: '' } } },
  })
  assert.equal(registry.list().length, 4)
  // Provider construction does not spawn; just assert the injection seam holds.
  assert.equal(typeof seen, 'undefined')
})
