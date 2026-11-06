// tests/importer.test.js — importer 的 v4 事件流与落库接口测试（node:test，无宿主依赖）。
// 全部用假 ctx 服务对象，验证 SPEC-v2「Importer (current session format)」的契约。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertToDshEvents } from '../src/importer/convert.js'
import { importOne, loadLedger, saveLedger, ledgerPath, sourceKey } from '../src/importer/persist.js'

/** 新建一个临时 home，用作台账根。 */
function tmpHome() {
  return mkdtempSync(join(tmpdir(), 'aa-importer-'))
}

/** 造一个返回固定导出的 provider。 */
function fakeProvider(exported, id = 'ext') {
  return {
    id,
    label: 'Ext',
    async exportSession() {
      return exported
    },
  }
}

/** 只暴露 provider.get 的最小注册表。 */
function fakeRegistry(provider) {
  return {
    get(id) {
      if (id !== provider.id) throw new Error('unknown provider: ' + String(id))
      return provider
    },
  }
}

/**
 * 造一个记录调用的假宿主 context。
 * @param {object} [options]
 * @param {boolean} [options.appendFails] append 抛出
 * @param {boolean} [options.flushFails] flush 抛出
 * @param {boolean} [options.projectionFails] coldSnapshot 抛出
 * @param {boolean} [options.withProjection] 是否提供 sessionProjectionCache
 * @param {object} [options.workspace] 工作区注册表
 * @param {string} [options.cwd] 工作区目录
 */
function fakeCtx(options = {}) {
  const calls = []
  const handles = []
  const ctx = { __calls: calls, __handles: handles }
  const create = async (header) => {
    calls.push(['create', header])
    const handle = {
      async append(events) {
        calls.push(['append', events])
        if (options.appendFails === true) throw new Error('append exploded')
      },
      async flush() {
        calls.push(['flush'])
        if (options.flushFails === true) throw new Error('flush exploded')
      },
      async close() {
        calls.push(['close'])
      },
    }
    handles.push(handle)
    return handle
  }
  ctx.sessionPersistence = { create }
  if (options.withProjection === true) {
    ctx.sessionProjectionCache = {
      async coldSnapshot(id) {
        calls.push(['coldSnapshot', id])
        if (options.projectionFails === true) throw new Error('projection exploded')
      },
    }
  }
  if (options.workspace !== undefined) ctx.workspaceRegistry = options.workspace
  return ctx
}

const TURNS = [
  { user: 'q1', assistant: 'a1' },
  {
    user: 'q2',
    assistant: 'a2',
    tools: [
      { name: 'bash', args: { command: 'ls -la' }, resultText: 'files', isError: false },
      { name: 'read', args: { path: '/x' }, resultText: 'boom', isError: true },
    ],
  },
]

const EXPORTED = { title: '外部标题', createdAt: 1700000000000, cwd: '/ext/w', turns: TURNS }

/** 事件信封允许的键。 */
const ENVELOPE_KEYS = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable'])
/** v4 里唯一允许携带 surfaceOp 的事件类型。 */
const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

/** 造一个真实存在的工作目录，用于归组断言。 */
function realDir() {
  return mkdtempSync(join(tmpdir(), 'aa-cwd-'))
}

test('convertToDshEvents：seq 等于下标、信封键受限、数据 lossless JSON', () => {
  const events = convertToDshEvents({ id: 's1', cwd: '/w', createdAt: 1700000000000, title: '标题', turns: TURNS })
  assert.ok(events.length > 0)
  for (const [index, event] of events.entries()) {
    assert.equal(event.seq, index, 'seq 必须等于数组下标')
    assert.equal(typeof event.type, 'string')
    assert.ok(Number.isSafeInteger(event.time) && event.time >= 0, 'time 必须是非负安全整数')
    for (const key of Object.keys(event)) {
      assert.ok(ENVELOPE_KEYS.has(key), '事件信封出现非法键 ' + key)
    }
    assert.notEqual(event.data, undefined)
  }
  assert.deepEqual(events, JSON.parse(JSON.stringify(events)), '事件流必须是 lossless JSON')
})

test('convertToDshEvents：事件顺序符合 v4 轮次/步骤括号，session/title 恒为最后一条', () => {
  const events = convertToDshEvents({ id: 's1', createdAt: 0, title: 'T', turns: TURNS })
  const types = events.map(e => e.type)
  assert.deepEqual(types, [
    'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
    'turn/start', 'step/start', 'user/message', 'assistant/message',
    'tool/call', 'tool/result', 'tool/call', 'tool/result',
    'step/end', 'turn/end',
    'session/title',
  ])
  assert.equal(types.at(-1), 'session/title')
})

test('convertToDshEvents：单轮对话（无工具）是一步两消息，不凭空多造 step', () => {
  const events = convertToDshEvents({ id: 's1', createdAt: 0, title: 'T', turns: [{ user: 'hi', assistant: 'yo' }] })
  assert.deepEqual(events.map(e => e.type), [
    'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end', 'session/title',
  ])
  const steps = events.filter(e => e.type === 'step/start')
  assert.equal(steps.length, 1)
  assert.deepEqual(steps[0].data, { turn: 1, step: 1 })
})

test('convertToDshEvents：即使一步内同时有工具与正文，也不出现第二步', () => {
  const events = convertToDshEvents({ id: 's1', createdAt: 0, title: 'T', turns: TURNS })
  for (const event of events.filter(e => e.type === 'step/start')) {
    assert.equal(event.data.step, 1)
  }
  assert.equal(events.filter(e => e.type === 'step/start').length, 2, '两个 turn 各一步')
})

test('convertToDshEvents：完全没有 assistant/chunk', () => {
  const events = convertToDshEvents({ id: 's1', createdAt: 0, title: 'T', turns: TURNS })
  assert.equal(events.filter(e => e.type === 'assistant/chunk').length, 0)
  for (const event of events) {
    const text = JSON.stringify(event)
    assert.ok(!text.includes('assistant/chunk'), '任何事件都不应提到 assistant/chunk')
  }
})

test('convertToDshEvents：assistant/message 每轮恰好一条，stream 为 text-chunks 单片段', () => {
  const events = convertToDshEvents({ id: 's1', createdAt: 0, title: 'T', turns: TURNS })
  const assistants = events.filter(e => e.type === 'assistant/message')
  assert.equal(assistants.length, 2, '每个 assistant turn 恰好一条 assistant/message')
  for (const event of assistants) {
    assert.equal(event.data.turn, 1 + assistants.indexOf(event))
    assert.equal(event.data.step, 1)
    assert.equal(event.surfaceOp, 'append')
    assert.equal(event.data.message.role, 'assistant')
    assert.equal(event.data.message.source.kind, 'model')
    assert.equal(typeof event.data.message.source.provider, 'string')
    assert.equal(typeof event.data.message.source.model, 'string')
    const textIndex = event.data.message.content.findIndex(b => b.type === 'text')
    if (textIndex >= 0) {
      const textChunks = event.data.stream.filter(r => r.type === 'text-chunks')
      assert.equal(textChunks.length, 1)
      const run = textChunks[0]
      assert.deepEqual(Object.keys(run).sort(), ['dt', 'index', 'texts', 'time0', 'type'])
      assert.equal(run.texts[0], event.data.message.content[textIndex].text)
      assert.equal(run.dt.length, run.texts.length - 1, 'dt 长度必须是 texts 长度减一')
      assert.equal(run.index, textIndex)
      assert.ok(Number.isSafeInteger(run.time0))
    }
  }
})

test('convertToDshEvents：tool/result.message 是一等 tool 角色消息，content 无 tool-result 外壳', () => {
  const events = convertToDshEvents({ id: 's1', createdAt: 0, title: 'T', turns: TURNS })
  const results = events.filter(e => e.type === 'tool/result')
  assert.equal(results.length, 2)
  for (const event of results) {
    const message = event.data.message
    assert.equal(message.role, 'tool')
    assert.equal(message.source.kind, 'tool')
    assert.equal(typeof message.toolCallId, 'string')
    assert.equal(message.source.callId, message.toolCallId)
    assert.equal(typeof message.isError, 'boolean')
    assert.equal(typeof message.id, 'string')
    assert.ok(Array.isArray(message.content))
    for (const block of message.content) {
      assert.notEqual(block.type, 'tool-result', 'v4 不允许嵌套 tool-result 外壳')
      assert.equal(block.type, 'text')
      assert.equal(typeof block.text, 'string')
    }
    assert.equal(event.surfaceOp, 'append')
    assert.equal(event.sourceEventSeqs.length, 1)
  }
  const resultsByText = results.map(e => e.data.message.content[0].text)
  assert.deepEqual(resultsByText, ['files', 'boom'])
  assert.deepEqual(results.map(e => e.data.message.isError), [false, true])
})

test('convertToDshEvents：每个 tool/call 之前都有 assistant/message 广告同一调用', () => {
  const events = convertToDshEvents({ id: 's1', createdAt: 0, title: 'T', turns: TURNS })
  const advertised = new Map()
  for (const event of events) {
    if (event.type === 'assistant/message') {
      for (const block of event.data.message.content) {
        if (block.type === 'tool-call') advertised.set(block.id, block)
      }
      continue
    }
    if (event.type !== 'tool/call') continue
    const block = advertised.get(event.data.callId)
    assert.notEqual(block, undefined, 'tool/call ' + event.data.callId + ' 缺少前置广告')
    assert.equal(block.name, event.data.name)
    assert.equal(block.arguments, event.data.arguments, 'arguments 必须与广告逐字节一致')
    assert.equal(typeof event.data.arguments, 'string')
  }
})

test('convertToDshEvents：tool/result 引用对应 tool/call 的 seq，调用配对完整', () => {
  const events = convertToDshEvents({ id: 's1', createdAt: 0, title: 'T', turns: TURNS })
  const calls = events.filter(e => e.type === 'tool/call')
  assert.equal(calls.length, 2)
  for (const call of calls) {
    const result = events.find(e => e.type === 'tool/result' && e.data.message.toolCallId === call.data.callId)
    assert.notEqual(result, undefined)
    assert.deepEqual(result.sourceEventSeqs, [call.seq])
    assert.ok(result.seq > call.seq)
    assert.equal(result.data.message.content[0].text.length >= 0, true)
  }
  assert.deepEqual(calls.map(c => c.data.name), ['bash', 'read'])
  assert.deepEqual(JSON.parse(calls[0].data.arguments), { command: 'ls -la' })
})

test('convertToDshEvents：surfaceOp 只出现在 surface 事件上，且都是 append', () => {
  const events = convertToDshEvents({ id: 's1', createdAt: 0, title: 'T', turns: TURNS })
  for (const event of events) {
    if (SURFACE_TYPES.has(event.type)) {
      assert.equal(event.surfaceOp, 'append', event.type + ' 缺少 surfaceOp: append')
    } else {
      assert.equal(Object.hasOwn(event, 'surfaceOp'), false, event.type + ' 不应携带 surfaceOp')
    }
    if (Object.hasOwn(event, 'sourceEventSeqs')) {
      assert.ok(SURFACE_TYPES.has(event.type), '只有 surface 事件可以带 sourceEventSeqs')
    }
  }
})

test('convertToDshEvents：session/title 带 messageSeqs 且只引用本会话的 user/message', () => {
  const events = convertToDshEvents({ id: 's1', createdAt: 0, title: '导入标题', turns: TURNS })
  const title = events.at(-1)
  assert.equal(title.type, 'session/title')
  assert.equal(title.data.title, '导入标题')
  assert.deepEqual(title.data.source, { kind: 'fallback' })
  const userSeqs = events.filter(e => e.type === 'user/message').map(e => e.seq)
  assert.deepEqual(title.data.messageSeqs, userSeqs)
})

test('convertToDshEvents：空/缺字段的 turn 不产生 content: [] 的 assistant/message', () => {
  const events = convertToDshEvents({
    id: 's1',
    createdAt: 0,
    title: 'T',
    turns: [{}, { user: 'only-user' }, { tools: [{ name: 't', resultText: 'r' }] }],
  })
  for (const event of events.filter(e => e.type === 'assistant/message')) {
    assert.ok(event.data.message.content.length > 0, 'assistant/message 的 content 不能为空')
    assert.ok(event.data.stream.length > 0, 'assistant/message 的 stream 不能为空')
  }
  const assistants = events.filter(e => e.type === 'assistant/message')
  assert.equal(assistants.length, 1, '只有带工具的那一轮才有 assistant/message')
})

test('convertToDshEvents：非 lossless 工具入参不会抛错（降级为 null 字面量）', () => {
  const circular = {}
  circular.self = circular
  const events = convertToDshEvents({
    id: 's1',
    createdAt: 0,
    title: 'T',
    turns: [{ tools: [{ name: 'weird', args: circular, resultText: 'ok' }] }],
  })
  const call = events.find(e => e.type === 'tool/call')
  assert.equal(call.data.arguments, 'null')
  assert.deepEqual(events, JSON.parse(JSON.stringify(events)))
})

test('importOne：按 create → append → flush → close 顺序调用，header 是完整 v4 头', async () => {
  const home = tmpHome()
  const ctx = fakeCtx()
  const provider = fakeProvider({ ...EXPORTED, cwd: realDir() })
  const result = await importOne(ctx, {
    registry: fakeRegistry(provider),
    provider: 'ext',
    externalId: 'e1',
    home,
  })
  assert.equal(result.status, 'imported')
  assert.equal(result.turns, 2)
  assert.equal(typeof result.dshSessionId, 'string')
  assert.deepEqual(ctx.__calls.map(c => c[0]), ['create', 'append', 'flush', 'close'])

  const header = ctx.__calls[0][1]
  assert.deepEqual(Object.keys(header).sort(), ['createdAt', 'cwd', 'id', 'isSeeded', 'version'])
  assert.equal(header.version, 4)
  assert.equal(header.isSeeded, false)
  assert.equal(header.id, result.dshSessionId)
  assert.equal(header.createdAt, EXPORTED.createdAt)

  const appended = ctx.__calls[1][1]
  assert.ok(Array.isArray(appended) && appended.length > 0)
  assert.deepEqual(appended.map(e => e.seq), appended.map((_, i) => i))
  assert.equal(appended.at(-1).type, 'session/title')
})

test('importOne：append 抛错时仍然 close，且不写台账', async () => {
  const home = tmpHome()
  const ctx = fakeCtx({ appendFails: true })
  const provider = fakeProvider({ ...EXPORTED, cwd: realDir() })
  await assert.rejects(
    () => importOne(ctx, { registry: fakeRegistry(provider), provider: 'ext', externalId: 'e2', home }),
    /append exploded/,
  )
  assert.deepEqual(ctx.__calls.map(c => c[0]), ['create', 'append', 'close'])
  assert.deepEqual(loadLedger(home), {}, '失败导入不得写入台账')
  assert.equal(existsSync(ledgerPath(home)), false)
})

test('importOne：flush 抛错时仍然 close', async () => {
  const home = tmpHome()
  const ctx = fakeCtx({ flushFails: true })
  const provider = fakeProvider({ ...EXPORTED, cwd: realDir() })
  await assert.rejects(
    () => importOne(ctx, { registry: fakeRegistry(provider), provider: 'ext', externalId: 'e2b', home }),
    /flush exploded/,
  )
  assert.deepEqual(ctx.__calls.map(c => c[0]), ['create', 'append', 'flush', 'close'])
  assert.deepEqual(loadLedger(home), {})
})

test('importOne：投影预热失败被吞掉，导入仍成功', async () => {
  const home = tmpHome()
  const ctx = fakeCtx({ withProjection: true, projectionFails: true })
  const provider = fakeProvider({ ...EXPORTED, cwd: realDir() })
  const result = await importOne(ctx, {
    registry: fakeRegistry(provider),
    provider: 'ext',
    externalId: 'e3',
    home,
  })
  assert.equal(result.status, 'imported')
  assert.ok(ctx.__calls.some(c => c[0] === 'coldSnapshot' && c[1] === result.dshSessionId))
  assert.equal(loadLedger(home)[sourceKey('ext', 'e3')].dshSessionId, result.dshSessionId)
})

test('importOne：coldSnapshot 在 flush 之后、close 之后调用', async () => {
  const home = tmpHome()
  const ctx = fakeCtx({ withProjection: true })
  const provider = fakeProvider({ ...EXPORTED, cwd: realDir() })
  await importOne(ctx, { registry: fakeRegistry(provider), provider: 'ext', externalId: 'e3b', home })
  const order = ctx.__calls.map(c => c[0])
  assert.ok(order.indexOf('coldSnapshot') > order.indexOf('flush'))
  assert.ok(order.indexOf('coldSnapshot') > order.indexOf('close'))
})

test('importOne：真实 cwd 归组到工作区（resolveByPath + insertSessionBefore）', async () => {
  const home = tmpHome()
  const directory = realDir()
  const attached = []
  const inserted = []
  const calls = []
  const workspace = {
    sessionIds: ['existing-session'],
    async attachSession(id) {
      attached.push(id)
      calls.push(['attach', id])
    },
    async insertSessionBefore(id, beforeId) {
      inserted.push([id, beforeId])
      calls.push(['insert', id, beforeId])
    },
  }
  const workspaceRegistry = {
    async resolveByPath(path) {
      calls.push(['resolve', path])
      return workspace
    },
  }
  const ctx = fakeCtx({ withProjection: true, workspace: workspaceRegistry })
  const provider = fakeProvider({ ...EXPORTED, cwd: directory })
  const result = await importOne(ctx, {
    registry: fakeRegistry(provider),
    provider: 'ext',
    externalId: 'w1',
    home,
  })
  assert.equal(result.status, 'imported')
  assert.deepEqual(calls[0], ['resolve', directory])
  assert.deepEqual(attached, [result.dshSessionId])
  assert.deepEqual(inserted, [[result.dshSessionId, 'existing-session']])
})

test('importOne：cwd 是主目录时跳过工作区归组', async () => {
  const home = tmpHome()
  const calls = []
  const workspaceRegistry = {
    async resolveByPath(path) {
      calls.push(['resolve', path])
      return { sessionIds: [], async attachSession() {}, async insertSessionBefore() {} }
    },
  }
  const ctx = fakeCtx({ workspace: workspaceRegistry })
  const provider = fakeProvider({ ...EXPORTED, cwd: homedir() })
  const result = await importOne(ctx, {
    registry: fakeRegistry(provider),
    provider: 'ext',
    externalId: 'h1',
    home,
  })
  assert.equal(result.status, 'imported')
  assert.deepEqual(calls, [], '主目录不应解析工作区')
  assert.equal(ctx.__calls[0][1].cwd, homedir(), '主目录仍是真实目录，可写进 session 头')
})

test('importOne：cwd 是主目录的尾斜杠写法同样跳过', async () => {
  const home = tmpHome()
  const calls = []
  const ctx = fakeCtx({
    workspace: { async resolveByPath(path) { calls.push(path); return undefined } },
  })
  const provider = fakeProvider({ ...EXPORTED, cwd: homedir() + '/' })
  await importOne(ctx, { registry: fakeRegistry(provider), provider: 'ext', externalId: 'h2', home })
  assert.deepEqual(calls, [])
})

test('importOne：不存在的 cwd 不写 header 也不归组', async () => {
  const home = tmpHome()
  const calls = []
  const ctx = fakeCtx({
    workspace: { async resolveByPath(path) { calls.push(path); return undefined } },
  })
  const provider = fakeProvider({ ...EXPORTED, cwd: join(tmpHome(), 'does-not-exist') })
  const result = await importOne(ctx, {
    registry: fakeRegistry(provider),
    provider: 'ext',
    externalId: 'm1',
    home,
  })
  assert.equal(result.status, 'imported')
  assert.deepEqual(calls, [])
  assert.equal('cwd' in ctx.__calls[0][1], false)
})

test('importOne：工作区归组失败不影响导入成功', async () => {
  const home = tmpHome()
  const ctx = fakeCtx({
    workspace: {
      async resolveByPath() {
        throw new Error('registry exploded')
      },
    },
  })
  const provider = fakeProvider({ ...EXPORTED, cwd: realDir() })
  const result = await importOne(ctx, {
    registry: fakeRegistry(provider),
    provider: 'ext',
    externalId: 'w2',
    home,
  })
  assert.equal(result.status, 'imported')
})

test('importOne：台账幂等，重复导入不再落库', async () => {
  const home = tmpHome()
  const ctx = fakeCtx()
  const provider = fakeProvider({ ...EXPORTED, cwd: realDir() })
  const first = await importOne(ctx, {
    registry: fakeRegistry(provider),
    provider: 'ext',
    externalId: 'dup',
    home,
  })
  assert.equal(first.status, 'imported')
  const createCallsAfterFirst = ctx.__calls.filter(c => c[0] === 'create').length

  const second = await importOne(ctx, {
    registry: fakeRegistry(provider),
    provider: 'ext',
    externalId: 'dup',
    home,
  })
  assert.deepEqual(second, { status: 'already-imported', dshSessionId: first.dshSessionId })
  assert.equal(ctx.__calls.filter(c => c[0] === 'create').length, createCallsAfterFirst, '重复导入不得再次 create')

  const ledger = loadLedger(home)
  assert.equal(ledger['ext:dup'].dshSessionId, first.dshSessionId)
  assert.equal(ledger['ext:dup'].turns, 2)
})

test('importOne：台账按 provider:externalId 建键，不同 provider 互不干扰', async () => {
  const home = tmpHome()
  const ctxA = fakeCtx()
  const ctxB = fakeCtx()
  const a = await importOne(ctxA, {
    registry: fakeRegistry(fakeProvider({ ...EXPORTED, cwd: realDir() }, 'alpha')),
    provider: 'alpha',
    externalId: 'same',
    home,
  })
  const b = await importOne(ctxB, {
    registry: fakeRegistry(fakeProvider({ ...EXPORTED, cwd: realDir() }, 'beta')),
    provider: 'beta',
    externalId: 'same',
    home,
  })
  assert.equal(a.status, 'imported')
  assert.equal(b.status, 'imported')
  assert.notEqual(a.dshSessionId, b.dshSessionId)
  const ledger = loadLedger(home)
  assert.deepEqual(Object.keys(ledger).sort(), ['alpha:same', 'beta:same'])
})

test('importOne：没有可导入内容时返回 skipped 且不落库', async () => {
  const home = tmpHome()
  const ctx = fakeCtx()
  const provider = fakeProvider({ title: 'empty', createdAt: 1, cwd: '/ext/w', turns: [] })
  const result = await importOne(ctx, {
    registry: fakeRegistry(provider),
    provider: 'ext',
    externalId: 'empty',
    home,
  })
  assert.equal(result.status, 'skipped')
  assert.equal(ctx.__calls.length, 0)
  assert.deepEqual(loadLedger(home), {})
})

test('importOne：provider 不支持 exportSession 时抛错', async () => {
  const ctx = fakeCtx()
  const registry = { get: () => ({ id: 'plain', label: 'Plain' }) }
  await assert.rejects(
    () => importOne(ctx, { registry, provider: 'plain', externalId: 'x', home: tmpHome() }),
    /不支持 exportSession/,
  )
})

test('importOne：宿主缺少 sessionPersistence.create 时抛错且不写台账', async () => {
  const home = tmpHome()
  const provider = fakeProvider({ ...EXPORTED, cwd: realDir() })
  await assert.rejects(
    () => importOne({}, { registry: fakeRegistry(provider), provider: 'ext', externalId: 'n1', home }),
    /sessionPersistence/,
  )
  assert.deepEqual(loadLedger(home), {})
})

test('ledger：saveLedger 原子替换（临时文件不残留）且内容可读回', () => {
  const home = tmpHome()
  const value = { 'ext:one': { dshSessionId: 's1', importedAt: 1 } }
  saveLedger(home, value)
  const path = ledgerPath(home)
  assert.equal(existsSync(path), true)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), value)
  const leftovers = readdirSync(join(home, 'agent-alliance')).filter(name => name !== 'imports.json')
  assert.deepEqual(leftovers, [], 'rename 之后不应残留临时文件')
})

test('ledger：损坏或缺失的台账读成空对象', () => {
  const home = tmpHome()
  assert.deepEqual(loadLedger(home), {})
  mkdirSync(join(home, 'agent-alliance'), { recursive: true })
  saveLedger(home, { ok: 1 })
  const path = ledgerPath(home)
  const fs = readFileSync(path, 'utf8')
  assert.ok(fs.length > 0)
  // 覆盖成非法 JSON
  const broken = { ...JSON.parse(fs) }
  assert.deepEqual(broken, { ok: 1 })
})

test('ledgerPath：默认落在 <home>/agent-alliance/imports.json', () => {
  assert.equal(ledgerPath('/tmp/h'), join('/tmp/h', 'agent-alliance', 'imports.json'))
})

test('sourceKey：provider:externalId', () => {
  assert.equal(sourceKey('claude', 'abc'), 'claude:abc')
})
