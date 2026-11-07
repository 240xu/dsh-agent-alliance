import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { makeZcodeProvider } from '../src/provider/zcode.js'

function fakeRunner(stdout, code = 0) {
  const calls = []
  const spawnCli = async (opts) => { calls.push(opts); return { code, stdout, stderr: '', timedOut: false, aborted: false } }
  return { spawnCli, calls }
}

test('未配置模板时 dispatch 抛明确错误', async () => {
  const p = makeZcodeProvider({ deps: {}, config: { enabled: true, commandTemplate: '' } })
  await assert.rejects(() => p.dispatch({ prompt: 'x' }), /commandTemplate/)
})

test('enabled=false 时 dispatch 抛明确错误', async () => {
  const p = makeZcodeProvider({ deps: {}, config: { enabled: false, commandTemplate: 'zcode -p {prompt}' } })
  await assert.rejects(() => p.dispatch({ prompt: 'x' }), /disabled|未启用/)
})

test('有模板时经 sh -c 展开 {prompt} 并返回文本', async () => {
  const { spawnCli, calls } = fakeRunner('zcode 的回答')
  const p = makeZcodeProvider({ deps: { spawnCli }, config: { enabled: true, commandTemplate: 'zcode -p {prompt}' } })
  const out = await p.dispatch({ prompt: "问题 Z" })
  assert.equal(calls[0].argv[0], 'sh')
  assert.equal(calls[0].argv[1], '-c')
  // 单引号安全包裹
  assert.ok(calls[0].argv[2].includes("zcode -p '问题 Z'"))
  assert.equal(out.text, 'zcode 的回答')
})

test('prompt 含单引号时被安全转义（防注入）', async () => {
  const { spawnCli, calls } = fakeRunner('ok')
  const p = makeZcodeProvider({ deps: { spawnCli }, config: { enabled: true, commandTemplate: 'zcode -p {prompt}' } })
  await p.dispatch({ prompt: "x'; rm -rf /; echo '" })
  const script = calls[0].argv[2]
  // 恶意片段必须以转义形式出现，而不是裸单引号闭合
  assert.ok(script.includes("'x'\\''; rm -rf /; echo '\\'''"), script)
})

test('listSessions/readSession：按已验证 schema 查询 db.sqlite（内存库注入）', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  db.prepare('INSERT INTO session VALUES (?,?,?,?)').run('zc_1', '/w', 'zcode 任务', 1700000000000)
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m1', 'zc_1', 1700000001000, JSON.stringify({ role: 'user' }))
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('pa1', 'm1', 'zc_1', 1700000001100, JSON.stringify({ type: 'text', text: 'zcode 首问' }))
  const p = makeZcodeProvider({
    deps: {},
    config: { enabled: true },
    openDb: () => db,
  })
  const list = await p.listSessions({})
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'zc_1')
  const s = await p.readSession('zc_1')
  assert.equal(s.messages[0].text, 'zcode 首问')
})


test('exportSession：zcode db 完整导出', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  db.prepare('INSERT INTO session VALUES (?,?,?,?)').run('zc_e', '/w', 'zc 导出', 1700000000000)
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('zm1', 'zc_e', 1, JSON.stringify({ role: 'user' }))
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('zp1', 'zm1', 'zc_e', 2, JSON.stringify({ type: 'text', text: 'zc 问' }))
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('zm2', 'zc_e', 3, JSON.stringify({ role: 'assistant' }))
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('zp2', 'zm2', 'zc_e', 4, JSON.stringify({ type: 'compaction', summary: { body: '压缩摘要' } }))
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('zp3', 'zm2', 'zc_e', 5, JSON.stringify({ type: 'text', text: 'zc 答' }))
  const p = makeZcodeProvider({ config: { enabled: true }, openDb: () => db })
  const s = await p.exportSession('zc_e')
  assert.equal(s.title, 'zc 导出')
  assert.equal(s.turns.length, 1)
  assert.equal(s.turns[0].user, 'zc 问')
  assert.equal(s.turns[0].assistant, 'zc 答')
})

test('a prompt containing $& is passed through verbatim, not as a replacement pattern', async () => {
  const { makeZcodeProvider } = await import('../src/provider/zcode.js')
  let seen
  const provider = makeZcodeProvider({
    config: { commandTemplate: 'run {prompt}' },
    deps: { spawnCli: async ({ argv }) => { seen = argv; return { code: 0, stdout: 'ok' } } },
  })
  await provider.dispatch({ prompt: 'fix the $& backreference and $$ escapes' })
  // String.replaceAll expands `$&`/`$$` inside a string replacement, which would
  // rewrite the user's text into the matched token.
  assert.ok(seen[2].includes('$& backreference'), 'prompt text must survive template expansion')
  assert.ok(seen[2].includes('$$ escapes'), 'dollar escapes must survive template expansion')
})
