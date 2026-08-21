import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { makeOpencodeProvider } from '../src/provider/opencode.js'

function fakeRunner(stdout, code = 0) {
  const calls = []
  const spawnCli = async (opts) => { calls.push(opts); return { code, stdout, stderr: '', timedOut: false, aborted: false } }
  return { spawnCli, calls }
}

const BIN = '/fake/xucodex/opencode/bin/opencode'
// 与 parseOpencodeEvents 契约一致的 NDJSON 事件流
const fx = [
  JSON.stringify({ type: 'session', sessionID: 'ses_x' }),
  JSON.stringify({ type: 'message', part: { type: 'text', text: '答O' } }),
].join('\n')

function memDb() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run('ses_1', '/w', '建看板页面', 1700000000000, 1700000600000)
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('msg_1', 'ses_1', 1700000001000, JSON.stringify({ role: 'user' }))
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('p_1', 'msg_1', 'ses_1', 1700000001100, JSON.stringify({ type: 'text', text: '帮我做个看板' }))
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('msg_2', 'ses_1', 1700000002000, JSON.stringify({ role: 'assistant' }))
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('p_2', 'msg_2', 'ses_1', 1700000002100, JSON.stringify({ type: 'text', text: '好的，方案如下' }))
  return db
}

test('dispatch：run argv + TMPDIR 归一 + json 格式', async () => {
  const { spawnCli, calls } = fakeRunner(fx)
  const p = makeOpencodeProvider({ deps: { spawnCli, paths: { opencodeBin: BIN } } })
  const out = await p.dispatch({ prompt: '问题O' })
  assert.deepEqual(calls[0].argv, [BIN, 'run', '问题O', '--format', 'json'])
  assert.ok(calls[0].env.TMPDIR && calls[0].env.TMPDIR !== '/tmp')
  assert.equal(out.text, '答O')
  assert.equal(out.externalSessionId, 'ses_x')
})

test('dispatch：resume 用 -s，--format json 收尾', async () => {
  const { spawnCli, calls } = fakeRunner(fx)
  const p = makeOpencodeProvider({ deps: { spawnCli, paths: { opencodeBin: BIN } } })
  await p.dispatch({ prompt: '继续', resumeSessionId: 'ses_9' })
  const argv = calls[0].argv
  const i = argv.indexOf('-s')
  assert.equal(argv[i + 1], 'ses_9')
  assert.deepEqual(argv.slice(-2), ['--format', 'json'])
})

test('listSessions/readSession：内存库查询', async () => {
  const p = makeOpencodeProvider({ deps: { paths: { opencodeBin: BIN }, openDb: () => memDb() } })
  const list = await p.listSessions({})
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'ses_1')
  assert.equal(list[0].title, '建看板页面')
  const s = await p.readSession('ses_1')
  assert.deepEqual(s.messages.map(m => m.role), ['user', 'assistant'])
  assert.equal(s.messages[0].text, '帮我做个看板')
})


test('exportSession：db 完整导出多轮', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run('ses_e', '/w', '导出测试', 1700000000000, 1700000900000)
  // 轮1
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m1', 'ses_e', 1, JSON.stringify({ role: 'user' }))
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('p1', 'm1', 'ses_e', 2, JSON.stringify({ type: 'text', text: '问E1' }))
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m2', 'ses_e', 3, JSON.stringify({ role: 'assistant' }))
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('p2', 'm2', 'ses_e', 4, JSON.stringify({ type: 'text', text: '答E1' }))
  // 轮2
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m3', 'ses_e', 5, JSON.stringify({ role: 'user' }))
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('p3', 'm3', 'ses_e', 6, JSON.stringify({ type: 'text', text: '问E2' }))
  const p = makeOpencodeProvider({ deps: { paths: { opencodeBin: BIN }, openDb: () => db } })
  const s = await p.exportSession('ses_e')
  assert.equal(s.title, '导出测试')
  assert.equal(s.turns.length, 2)
  assert.equal(s.turns[0].user, '问E1')
  assert.equal(s.turns[0].assistant, '答E1')
  assert.equal(s.turns[1].user, '问E2')
})
