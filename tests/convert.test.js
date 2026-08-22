import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertToDshEvents } from '../src/importer/convert.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const turns = [
  { user: '第一问', assistant: '第一答' },
  { user: '第二问', assistant: '第二答', tools: [{ name: 'bash', args: { command: 'ls' }, resultText: '文件列表', isError: false }] },
]

test('生成合法事件流：首事件是 turn/start（宿主自己写 session 头）', () => {
  const ev = convertToDshEvents({ id: 'session-test', cwd: '/w', createdAt: 1700000000000, title: 'T', turns })
  const types = ev.map(e => e.type)
  assert.equal(types[0], 'turn/start')
  assert.ok(!types.includes('session'), 'seed 里不得有 session 头（宿主从 meta 写）')
  // 轮1（两段式 step）: turn/start, step/start, user/message, step/end, step/start
  assert.deepEqual(types.slice(0, 5), ['turn/start', 'step/start', 'user/message', 'step/end', 'step/start'])
  assert.equal(types.at(-1), 'session/title')
})

test('seq 从 0 起连续且等于下标', () => {
  const ev = convertToDshEvents({ id: 's', cwd: '/w', createdAt: 1700000000000, title: 'T', turns })
  let expect = 0
  for (const e of ev) {
    assert.equal(e.seq, expect++, 'seq 必须连续')
    assert.equal(typeof e.time, 'number')
  }
})

test('user/message 形状匹配宿主契约', () => {
  const ev = convertToDshEvents({ id: 's', cwd: '/w', createdAt: 0, title: 'T', turns: [turns[0]] })
  const um = ev.find(e => e.type === 'user/message')
  assert.equal(um.surfaceOp, 'append')
  assert.equal(um.data.role, 'user')
  assert.equal(um.data.source.kind, 'user')
  assert.ok(UUID_RE.test(um.data.id))
  assert.deepEqual(um.data.content, [{ type: 'text', text: '第一问' }])
})

test('assistant 文本走 block-start/text-delta/block-end 三件套', () => {
  const ev = convertToDshEvents({ id: 's', cwd: '/w', createdAt: 0, title: 'T', turns: [turns[0]] })
  const chunks = ev.filter(e => e.type === 'assistant/chunk').map(e => e.data.chunk.type)
  assert.deepEqual(chunks, ['block-start', 'text-delta', 'block-end'])
  const bs = ev.find(e => e.type === 'assistant/chunk').data.chunk
  assert.equal(bs.blockType, 'text')
  const td = ev.filter(e => e.type === 'assistant/chunk')[1].data.chunk
  assert.equal(td.text, '第一答')
  const be = ev.filter(e => e.type === 'assistant/chunk')[2].data.chunk
  assert.deepEqual(be.block, { type: 'text', text: '第一答' })
})

test('工具调用：tool/call 与 tool/result 配对（sourceEventSeqs 指向调用）', () => {
  const ev = convertToDshEvents({ id: 's', cwd: '/w', createdAt: 0, title: 'T', turns: [turns[1]] })
  const call = ev.find(e => e.type === 'tool/call')
  const result = ev.find(e => e.type === 'tool/result')
  assert.equal(call.data.name, 'bash')
  assert.equal(JSON.parse(call.data.arguments).command, 'ls')
  assert.equal(result.sourceEventSeqs[0], call.seq)
  assert.equal(result.data.message.source.callId, call.data.callId)
  const tr = result.data.message.content[0]
  assert.equal(tr.toolCallId, call.data.callId)
  assert.equal(tr.isError, false)
  assert.deepEqual(tr.content, [{ type: 'text', text: '文件列表' }])
})

test('turn 编号从 1 递增；turn/end 带 completed reason；title 带 messageSeqs', () => {
  const ev = convertToDshEvents({ id: 's', cwd: '/w', createdAt: 0, title: '标题X', turns })
  const starts = ev.filter(e => e.type === 'turn/start')
  assert.deepEqual(starts.map(s => s.data.turn), [1, 2])
  for (const te of ev.filter(e => e.type === 'turn/end')) {
    assert.deepEqual(te.data.reason, { kind: 'completed' })
    assert.deepEqual(Object.keys(te.data).sort(), ['reason', 'turn'])
  }
  const title = ev.find(e => e.type === 'session/title')
  assert.equal(title.data.title, '标题X')
  assert.ok(Array.isArray(title.data.messageSeqs))
})


test('信封白名单守卫：键只能是宿主七键；seq/time/data 齐备', () => {
  const ALLOWED = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable'])
  const ev = convertToDshEvents({ id: 's', cwd: '/w', createdAt: 1700000000000, title: 'T', turns })
  for (const [i, e] of ev.entries()) {
    for (const k of Object.keys(e)) {
      assert.ok(ALLOWED.has(k), 'event ' + i + ' 有非法键 ' + k + '（宿主会拒绝整个 seed）')
    }
    assert.equal(typeof e.type, 'string')
    assert.ok(Number.isSafeInteger(e.seq) && e.seq >= 0)
    assert.equal(typeof e.time, 'number')
    assert.notEqual(e.data, undefined)
  }
})
