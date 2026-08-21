import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { spawnCli, normalizeEnv } from '../src/runner.js'

test('回显 stdout 与退出码', async () => {
  const r = await spawnCli({ argv: [process.execPath, '-e', 'console.log("hi")'] })
  assert.equal(r.code, 0)
  assert.equal(r.stdout.trim(), 'hi')
  assert.equal(r.timedOut, false)
})

test('非零退出不 reject，stderr 可取', async () => {
  const r = await spawnCli({ argv: [process.execPath, '-e', 'console.error("boom"); process.exit(3)'] })
  assert.equal(r.code, 3)
  assert.match(r.stderr, /boom/)
})

test('超时 kill 且 timedOut:true', async () => {
  const r = await spawnCli({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], timeoutMs: 150 })
  assert.equal(r.timedOut, true)
  assert.notEqual(r.code, 0)
})

test('abort 提前终止', async () => {
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 80)
  const r = await spawnCli({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], signal: ac.signal })
  assert.equal(r.aborted, true)
})

test('normalizeEnv：空环境下补齐 PATH/HOME/TMPDIR，且不覆盖显式值', () => {
  const e1 = normalizeEnv({})
  assert.ok(e1.PATH && e1.PATH.length > 0, 'PATH 必须非空')
  assert.ok(e1.HOME && e1.HOME.length > 0, 'HOME 必须非空')
  assert.ok(e1.TMPDIR && e1.TMPDIR.length > 0, 'TMPDIR 必须非空')
  const e2 = normalizeEnv({ PATH: '/custom', HOME: '/h', TMPDIR: '/t' })
  assert.equal(e2.PATH, '/custom')
  assert.equal(e2.HOME, '/h')
  assert.equal(e2.TMPDIR, '/t')
})

test('spawn 后子进程可见归一化 PATH/TMPDIR/HOME', async () => {
  // 模拟空环境不可行（spawn 继承本进程），但至少验证合并后子进程三值齐全
  const r = await spawnCli({
    argv: [process.execPath, '--input-type=module', '-e',
      'console.log([!!process.env.PATH, !!process.env.HOME, !!process.env.TMPDIR].join(","))'],
    env: { AA_X: '1' },
  })
  assert.equal(r.stdout.trim(), 'true,true,true')
})

test('cwd 生效（ESM 探针）', async () => {
  const tmp = os.tmpdir()
  const r = await spawnCli({
    argv: [process.execPath, '--input-type=module', '-e', 'console.log(process.cwd() === process.env.AA_EXPECT)'],
    cwd: tmp,
    env: { AA_EXPECT: tmp },
  })
  assert.equal(r.stdout.trim(), 'true')
})
