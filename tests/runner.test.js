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

test('credential-shaped and DSH_ ambient variables never reach an external CLI', async () => {
  const { normalizeEnv } = await import('../src/runner.js')
  const saved = { ...process.env }
  try {
    process.env.MY_PASSWORD = 'secret'
    process.env.DEEPSEEK_API_KEY = 'sk-x'
    process.env.GITHUB_TOKEN = 'gh-t'
    process.env.DSH_INTERNAL_FACT = 'internal'
    process.env.SAFE_SETTING = 'kept'

    const env = normalizeEnv()
    // The official subagent seam scrubs these classes before spawning; the CLI
    // path is what the panel uses, so it must scrub them too or it hands a
    // third-party CLI the host's API keys.
    for (const name of ['MY_PASSWORD', 'DEEPSEEK_API_KEY', 'GITHUB_TOKEN', 'DSH_INTERNAL_FACT']) {
      assert.equal(env[name], undefined, name + ' must be stripped from the child environment')
    }
    assert.equal(env.SAFE_SETTING, 'kept', 'ordinary ambient values still pass through')

    // An explicit env entry is a deliberate caller opt-in and survives.
    const opted = normalizeEnv({ MY_PASSWORD: 'deliberate' })
    assert.equal(opted.MY_PASSWORD, 'deliberate')
  } finally {
    process.env = saved
  }
})

test('the credential scrub matches the host SENSITIVE_ENV_PATTERN, no wider', async () => {
  const { normalizeEnv } = await import('../src/runner.js')
  // The host exports /KEY|PASSWORD|SECRET|TOKEN/i and accepts that it also
  // drops names like MONKEY and KEYBOARD. Widening our pattern further (with
  // CREDENTIAL/SESSION) was tried and removed SESSION_NAME from the child,
  // which the host does NOT drop. Pin the boundary.
  const saved = { ...process.env }
  try {
    process.env.SESSION_NAME = 'kept-by-host'
    process.env.MONKEY = 'dropped-by-host-too'
    process.env.API_KEY = 'secret'
    process.env.DSH_INTERNAL = 'internal'
    const env = normalizeEnv()
    assert.equal(env.SESSION_NAME, 'kept-by-host', 'must not be more aggressive than the host')
    assert.equal(env.MONKEY, undefined, 'the host drops this too; we follow it')
    assert.equal(env.API_KEY, undefined)
    assert.equal(env.DSH_INTERNAL, undefined)
  } finally {
    process.env = saved
  }
})

test('lowercase dsh_* ambient names are scrubbed like the official host predicate', async () => {
  const { normalizeEnv } = await import('../src/runner.js')
  const saved = { ...process.env }
  try {
    process.env.DSH_INTERNAL = 'upper'
    process.env.dsh_lowercase_fact = 'lower'
    process.env.MiXeD_DsH_FaCt = 'mixed' // prefix is not DSH_, keep it
    const env = normalizeEnv()
    // dsh-subprocess uses `key.toUpperCase().startsWith('DSH_')` because
    // Windows environment names are case-insensitive. A case-sensitive check
    // leaked the lowercase form into the child.
    assert.equal(env.DSH_INTERNAL, undefined)
    assert.equal(env.dsh_lowercase_fact, undefined, 'lowercase dsh_* must be scrubbed')
    assert.equal(env.MiXeD_DsH_FaCt, 'mixed', 'only the DSH_ PREFIX is case-insensitive')
  } finally {
    process.env = saved
  }
})
