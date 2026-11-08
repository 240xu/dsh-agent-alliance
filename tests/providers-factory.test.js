import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildProviders } from '../src/providers.js'

test('buildProviders：四家齐全、id 正确', () => {
  const reg = buildProviders({ config: { providers: {}, defaults: {} } })
  assert.deepEqual(reg.list().map(p => p.id).sort(), ['claude', 'codex', 'opencode', 'zcode'])
})

test('buildProviders：deps 覆盖注入到每家（fake runner 可见）', async () => {
  const calls = []
  const spawnCli = async (opts) => { calls.push(opts); return { code: 0, stdout: 'v9', stderr: '', timedOut: false, aborted: false } }
  const reg = buildProviders({
    config: { providers: {}, defaults: {} },
    deps: { spawnCli, paths: { claude: { grun: '/g', claudeBin: '/b' }, codex: { codexJs: '/c' }, opencode: { opencodeBin: '/o' }, zcode: {} } },
  })
  const states = await reg.detectAll()
  // fake runner 下三家 CLI 探测都成功；zcode 无模板仍不可用
  assert.equal(states.find(s => s.id === 'claude').available, true)
  assert.equal(states.find(s => s.id === 'codex').available, true)
  assert.equal(states.find(s => s.id === 'opencode').available, true)
  assert.equal(states.find(s => s.id === 'zcode').available, false)
})

test('buildProviders：zcode 配置透传（模板存在即 available）', async () => {
  const reg = buildProviders({
    config: { providers: { zcode: { enabled: true, commandTemplate: 'zc -p {prompt}' } }, defaults: {} },
    deps: { spawnCli: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, aborted: false }) },
  })
  const states = await reg.detectAll()
  assert.equal(states.find(s => s.id === 'zcode').available, true)
})

test('configured provider paths override the Termux defaults in production wiring', async () => {
  const { buildProviders } = await import('../src/providers.js')
  const { loadConfig } = await import('../src/config.js')
  // The CLI providers only accepted path overrides through `deps.paths`, which
  // the production entry (buildProviders({ config })) never supplied. A user
  // configuring an explicit binary path had no way to escape the Termux
  // defaults on ordinary Linux.
  const config = loadConfig({
    providers: {
      claude: { enabled: true, paths: { grun: '/custom/bin/grun', claudeBin: '/custom/bin/claude' } },
    },
  }, { file: '/tmp/alliance-no-such-file.json' })
  let seenArgv
  const registry = buildProviders({
    config,
    deps: { spawnCli: async ({ argv }) => { seenArgv = argv; return { code: 0, stdout: 'claude 1.0' } } },
  })
  const claude = registry.get('claude')
  await claude.detect()
  assert.deepEqual(seenArgv.slice(0, 2), ['/custom/bin/grun', '/custom/bin/claude'])
})

test('a malformed paths value is rejected at config load', async () => {
  const { loadConfig } = await import('../src/config.js')
  assert.throws(
    () => loadConfig({ providers: { claude: { paths: { grun: 7 } } } }, { file: '/tmp/nope.json' }),
    /non-empty string/,
  )
})
