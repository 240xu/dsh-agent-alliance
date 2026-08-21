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
