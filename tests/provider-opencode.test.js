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


test('exportSession：工具部件映射为 tools 数组（含 error 状态）', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run('ses_t', '/w', 'T', 1, 9)
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m1', 'ses_t', 1, JSON.stringify({ role: 'user' }))
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('p1', 'm1', 'ses_t', 2, JSON.stringify({ type: 'text', text: '问' }))
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m2', 'ses_t', 3, JSON.stringify({ role: 'assistant' }))
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('p2', 'm2', 'ses_t', 4,
    JSON.stringify({ type: 'tool', tool: 'read', callID: 'c1', state: { status: 'completed', input: { filePath: '/a' }, output: '内容' } }))
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('p3', 'm2', 'ses_t', 5,
    JSON.stringify({ type: 'tool', tool: 'glob', callID: 'c2', state: { status: 'error', input: { pattern: '*' }, error: 'NotFound' } }))
  const p = makeOpencodeProvider({ deps: { paths: { opencodeBin: BIN }, openDb: () => db } })
  const s = await p.exportSession('ses_t')
  assert.equal(s.turns[0].tools.length, 2)
  assert.deepEqual(s.turns[0].tools[0], { name: 'read', args: { filePath: '/a' }, resultText: '内容', isError: false })
  assert.equal(s.turns[0].tools[1].isError, true)
  assert.equal(s.turns[0].tools[1].resultText, 'NotFound')
})



test('配置级默认模型：未显式传 model 时使用 defaultModel', async () => {
  const fr = fakeRunner(fx)
  const p = makeOpencodeProvider({ deps: { paths: { opencodeBin: BIN }, spawnCli: fr.spawnCli }, config: { defaultModel: 'zen/x-preview-f-free' } })
  await p.dispatch({ prompt: 'hi', timeoutMs: 5000 })
  const argv = fr.calls[0].argv
  assert.ok(argv.includes('-m'), 'argv 应含 -m')
  assert.equal(argv[argv.indexOf('-m') + 1], 'zen/x-preview-f-free')
})

test('显式 model 覆盖配置默认', async () => {
  const fr = fakeRunner(fx)
  const p = makeOpencodeProvider({ deps: { paths: { opencodeBin: BIN }, spawnCli: fr.spawnCli }, config: { defaultModel: 'zen/x-preview-f-free' } })
  await p.dispatch({ prompt: 'hi', model: 'go/manual', timeoutMs: 5000 })
  const argv = fr.calls[0].argv
  assert.equal(argv[argv.indexOf('-m') + 1], 'go/manual')
})

test('repeated session reads close their database handle', async () => {
  // node:sqlite keeps a descriptor until the handle is collected, and GC is not
  // driven by this workload. Leaking one per read exhausts the process budget
  // and the provider then fails outright instead of degrading.
  const { DatabaseSync } = await import('node:sqlite')
  const { mkdtempSync, readdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  const dbPath = join(mkdtempSync(join(tmpdir(), 'opencode-fd-')), 'opencode.db')
  const seed = new DatabaseSync(dbPath)
  seed.exec('CREATE TABLE session (id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER)')
  seed.exec('CREATE TABLE message (id TEXT, time_created INTEGER, data TEXT)')
  seed.exec('CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  for (let i = 0; i < 5; i += 1) seed.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run('s' + i, 'T' + i, '/tmp', i, i)
  seed.close()

  const { makeOpencodeProvider } = await import('../src/provider/opencode.js')
  const provider = makeOpencodeProvider({ config: {}, deps: { paths: { dbPath, opencodeBin: '/bin/true' } } })

  const descriptors = () => readdirSync('/proc/self/fd').length
  await provider.listSessions({ limit: 1 }) // warm the lazy sqlite import
  const before = descriptors()
  for (let i = 0; i < 30; i += 1) await provider.listSessions({ limit: 5 })
  const after = descriptors()
  // Allow a small margin for unrelated runtime descriptors.
  assert.ok(after - before <= 2, `descriptor count grew by ${after - before} over 30 reads`)
})
