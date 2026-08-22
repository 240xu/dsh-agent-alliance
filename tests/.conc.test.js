import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerTools } from '../src/tools.js'
import { createRegistry } from '../src/provider/types.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function mockCtx() {
  const registered = []
  const jobsStarted = []
  const ctx = {
    tools: { register: (t) => registered.push(t) },
    jobs: { start: (spec) => { jobsStarted.push(spec); return { id: 'job-9' } } },
  }
  return { ctx, registered, jobsStarted }
}

const fakeProvider = {
  id: 'fake',
  label: 'Fake',
  dispatch: async ({ prompt, signal }) => {
    if (signal?.aborted) throw new Error('aborted-before-start')
    return { text: '回答:' + prompt, externalSessionId: 'ext-1' }
  },
  listSessions: async ({ limit }) => [{ id: 's1', title: 't', createdAt: null, messageCount: null }].slice(0, limit),
  readSession: async (id) => ({ title: 'tt', messages: [{ role: 'user', text: 'q-' + id }] }),
}

const config = { providers: {}, defaults: { timeoutMs: 300000, maxConcurrent: 3 } }

test('注册六个工具且名字正确', () => {
  const { ctx, registered } = mockCtx()
  registerTools(ctx, { registry: createRegistry([fakeProvider]), config })
  assert.deepEqual(registered.map(x => x.name).sort(), ['agent_dispatch', 'agent_import', 'agent_import_scan', 'agent_roundtable', 'agent_session_read', 'agent_sessions'])
})

test('roundtable 默认后台：job 完成输出含各家回答与失败隔离', async () => {
  const pA = { ...fakeProvider, id: 'a', dispatch: async ({ prompt }) => ({ text: 'A答:' + prompt }) }
  const pBad = { ...fakeProvider, id: 'b', dispatch: async () => { throw new Error('b 炸') } }
  const { ctx, registered, jobsStarted } = mockCtx()
  registerTools(ctx, { registry: createRegistry([pA, pBad]), config })
  const tool = registered.find(x => x.name === 'agent_roundtable')
  const out = await tool.execute({ prompt: '设计对比' }, { agent: { id: 'ag' }, signal: new AbortController().signal })
  assert.equal(out.kind, 'background')
  const hooks = jobsStarted[0].run()
  const outcome = await hooks.done
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.output, /\[a\]/)
  assert.match(outcome.output, /A答:设计对比/)
  assert.match(outcome.output, /\[b\] 失败/)
})

test('roundtable background:false 可前台等待', async () => {
  const pA = { ...fakeProvider, id: 'a', dispatch: async ({ prompt }) => ({ text: 'X' + prompt }) }
  const { ctx, registered } = mockCtx()
  registerTools(ctx, { registry: createRegistry([pA]), config })
  const tool = registered.find(x => x.name === 'agent_roundtable')
  const out = await tool.execute({ prompt: 'q', background: false }, { signal: new AbortController().signal })
  assert.match(out.text, /Xq/)
})

test('dispatch 前台：返回文本与会话id，耗时字段存在', async () => {
  const { ctx, registered } = mockCtx()
  registerTools(ctx, { registry: createRegistry([fakeProvider]), config })
  const tool = registered.find(t => t.name === 'agent_dispatch')
  const out = await tool.execute({ provider: 'fake', prompt: '你好' }, { agent: undefined, signal: new AbortController().signal })
  assert.equal(out.provider, 'fake')
  assert.equal(out.text, '回答:你好')
  assert.equal(out.externalSessionId, 'ext-1')
  assert.equal(typeof out.durationMs, 'number')
})

test('dispatch 未知 provider 抛错', async () => {
  const { ctx, registered } = mockCtx()
  registerTools(ctx, { registry: createRegistry([fakeProvider]), config })
  const tool = registered.find(t => t.name === 'agent_dispatch')
  await assert.rejects(() => tool.execute({ provider: 'nope', prompt: 'x' }, {}), /unknown provider/i)
})

test('dispatch 后台：走 ctx.jobs.start 且 owner=exec.agent；done 可等待', async () => {
  const { ctx, registered, jobsStarted } = mockCtx()
  registerTools(ctx, { registry: createRegistry([fakeProvider]), config })
  const tool = registered.find(t => t.name === 'agent_dispatch')
  const out = await tool.execute({ provider: 'fake', prompt: '长任务', background: true }, { agent: { id: 'ag-1' }, signal: new AbortController().signal })
  assert.deepEqual(out, { kind: 'background', jobId: 'job-9' })
  assert.equal(jobsStarted.length, 1)
  const spec = jobsStarted[0]
  assert.equal(spec.kind, 'agent-alliance')
  assert.equal(spec.owner.id, 'ag-1')
  // 手动驱动 run() 验证 hooks
  const hooks = spec.run()
  const outcome = await hooks.done
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.output, /回答:长任务/)
})

test('后台取消：cancel 后 dispatch 收到 abort（fake provider 模拟）', async () => {
  const slowProvider = {
    ...fakeProvider,
    dispatch: ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    }),
  }
  const { ctx, registered, jobsStarted } = mockCtx()
  registerTools(ctx, { registry: createRegistry([slowProvider]), config })
  const tool = registered.find(t => t.name === 'agent_dispatch')
  await tool.execute({ provider: 'fake', prompt: 'x', background: true }, { agent: { id: 'a' }, signal: new AbortController().signal })
  const hooks = jobsStarted[0].run()
  hooks.cancel('user')
  const outcome = await hooks.done
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.detail, /aborted|cancel/i)
})

test('sessions 与 session_read 透传', async () => {
  const { ctx, registered } = mockCtx()
  registerTools(ctx, { registry: createRegistry([fakeProvider]), config })
  const sTool = registered.find(t => t.name === 'agent_sessions')
  const rTool = registered.find(t => t.name === 'agent_session_read')
  const s = await sTool.execute({ provider: 'fake', limit: 5 }, {})
  assert.equal(s.sessions[0].id, 's1')
  const r = await rTool.execute({ provider: 'fake', sessionId: 's1' }, {})
  assert.equal(r.messages[0].text, 'q-s1')
})


test('输出必须是无损 JSON（undefined 字段被剔除）', async () => {
  const messy = {
    ...fakeProvider,
    listSessions: async () => [{ id: 's1', title: undefined, cwd: undefined, createdAt: null, messageCount: null }],
    readSession: async () => ({ title: undefined, messages: [{ role: 'user', text: 'x' }] }),
  }
  const { ctx, registered } = mockCtx()
  registerTools(ctx, { registry: createRegistry([messy]), config })
  const sTool = registered.find(x => x.name === 'agent_sessions')
  const rTool = registered.find(x => x.name === 'agent_session_read')
  const s = await sTool.execute({ provider: 'fake' }, {})
  // JSON.stringify 会把 undefined 属性直接丢掉——能无损往返即合法
  assert.deepEqual(s, JSON.parse(JSON.stringify(s)))
  assert.ok(!('title' in s.sessions[0]))
  const r = await rTool.execute({ provider: 'fake', sessionId: 's1' }, {})
  assert.deepEqual(r, JSON.parse(JSON.stringify(r)))
})

test('dispatch 前台输出同样无损（externalSessionId 为 null 而非 undefined）', async () => {
  const noSid = { ...fakeProvider, dispatch: async () => ({ text: 't' }) } // 无 externalSessionId
  const { ctx, registered } = mockCtx()
  registerTools(ctx, { registry: createRegistry([noSid]), config })
  const tool = registered.find(x => x.name === 'agent_dispatch')
  const out = await tool.execute({ provider: 'fake', prompt: 'p' }, { signal: new AbortController().signal })
  assert.deepEqual(out, JSON.parse(JSON.stringify(out)))
})


test('agent_import_scan：列出会话并标注导入状态', async () => {
  const home = tmpHome()
  const pA = { ...fakeProvider, listSessions: async () => [{ id: 's1', title: 't1', createdAt: null, messageCount: null }] }
  const { ctx, registered } = mockCtx()
  registerTools(ctx, { registry: createRegistry([pA]), config, home })
  const tool = registered.find(x => x.name === 'agent_import_scan')
  const out = await tool.execute({ provider: 'fake' }, {})
  assert.equal(out.total, 1)
  assert.equal(out.sessions[0].imported, false)
})

test('agent_import：导入成功并幂等', async () => {
  const home = tmpHome()
  const pA = { ...fakeProvider, exportSession: async () => ({ title: 'T', createdAt: 1, cwd: '/w', turns: [{ user: 'u', assistant: 'a' }] }) }
  const created = []
  const ctx2 = {
    tools: { register: (x) => registered2.push(x) },
    jobs: { start: () => ({ id: 'j' }) },
    get(name) { if (name === 'agents') return { create: async (s) => { created.push(s) } }; return undefined },
  }
  const registered2 = []
  registerTools(ctx2, { registry: createRegistry([pA]), config, home })
  const tool = registered2.find(x => x.name === 'agent_import')
  const out = await tool.execute({ provider: 'fake', sessionId: 's1' }, {})
  assert.equal(out.status, 'imported')
  assert.equal(created.length, 1)
  const out2 = await tool.execute({ provider: 'fake', sessionId: 's1' }, {})
  assert.equal(out2.status, 'already-imported')
})
function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'aa-tools-')) }


test('UI 卡片：dispatch 用 terminal 卡，后台确认用 generic', () => {
  const { ctx, registered } = mockCtx()
  registerTools(ctx, { registry: createRegistry([fakeProvider]), config })
  const tool = registered.find(x => x.name === 'agent_dispatch')
  const call = tool.presentCall({ provider: 'fake', prompt: '任务X' }, {})
  assert.equal(call.card, 'terminal')
  assert.match(call.title, /fake/)
  const bgCall = tool.presentCall({ provider: 'fake', prompt: '长任务', background: true }, {})
  assert.equal(bgCall.card, 'generic')
  assert.equal(bgCall.kind, 'execute')
  const res = tool.presentResult({ provider: 'fake', prompt: 'p' }, { content: [{ type: 'text', text: '回答内容' }], isError: false })
  assert.equal(res.card, 'terminal')
  assert.equal(res.output, '回答内容')
})

test('UI 卡片：import 与 roundtable 有 generic 卡', () => {
  const { ctx, registered } = mockCtx()
  registerTools(ctx, { registry: createRegistry([fakeProvider]), config })
  const imp = registered.find(x => x.name === 'agent_import')
  const c = imp.presentCall({ provider: 'fake', sessionId: 's9' }, {})
  assert.equal(c.card, 'generic')
  assert.match(c.title, /fake.*s9|s9.*fake/)
  const rt = registered.find(x => x.name === 'agent_roundtable')
  const rc = rt.presentCall({ prompt: '问题Q' }, {})
  assert.equal(rc.card, 'generic')
})


test('maxConcurrent 并发上限：在飞数量不超过配置值', async () => {
  let inflight = 0, peak = 0
  const slow = (id) => ({
    ...fakeProvider, id,
    dispatch: async () => {
      inflight++; peak = Math.max(peak, inflight)
      await new Promise(r => setTimeout(r, 60))
      inflight--
      return { text: 'done-' + id }
    },
  })
  const { ctx, registered } = mockCtx()
  registerTools(ctx, { registry: createRegistry([slow('a'), slow('b'), slow('c')]), config: { providers: {}, defaults: { timeoutMs: 30000, maxConcurrent: 2 } } })
  const tool = registered.find(x => x.name === 'agent_dispatch')
  await Promise.all([1, 2, 3].map(i =>
    tool.execute({ provider: i === 1 ? 'a' : i === 2 ? 'b' : 'c', prompt: 'p' + i }, { signal: new AbortController().signal })))
  assert.ok(peak <= 2, 'peak=' + peak + ' 应 ≤ maxConcurrent=2')
})

test('排队中被 abort：前台等待应快速失败而不是无限等', async () => {
  let inflight = 0
  const blocker = { ...fakeProvider, id: 'blk', dispatch: async () => { inflight++; await new Promise(r => setTimeout(r, 400)); inflight--; return { text: 'x' } } }
  const { ctx, registered } = mockCtx()
  registerTools(ctx, { registry: createRegistry([blocker]), config: { providers: {}, defaults: { timeoutMs: 30000, maxConcurrent: 1 } } })
  const tool = registered.find(x => x.name === 'agent_dispatch')
  const ac = new AbortController()
  const second = tool.execute({ provider: 'blk', prompt: 'second' }, { signal: ac.signal })
  setTimeout(() => ac.abort(), 50) // 第二个调用会排队，50ms 后被取消
  await assert.rejects(() => second, /abort|cancel/i)
})
test('maxConcurrent 并发上限：在飞数量不超过配置值', async () => {
  let inflight = 0, peak = 0
  const slow = (id) => ({
    ...fakeProvider, id,
    dispatch: async () => {
      inflight++; peak = Math.max(peak, inflight)
      await new Promise(r => setTimeout(r, 60))
      inflight--
      return { text: 'done-' + id }
    },
  })
  const { ctx, registered } = mockCtx()
  registerTools(ctx, { registry: createRegistry([slow('a'), slow('b'), slow('c')]), config: { providers: {}, defaults: { timeoutMs: 30000, maxConcurrent: 2 } } })
  const tool = registered.find(x => x.name === 'agent_dispatch')
  await Promise.all([1, 2, 3].map(i =>
    tool.execute({ provider: i === 1 ? 'a' : i === 2 ? 'b' : 'c', prompt: 'p' + i }, { signal: new AbortController().signal })))
  assert.ok(peak <= 2, 'peak=' + peak + ' 应 ≤ maxConcurrent=2')
})

test('排队中被 abort：前台等待应快速失败而不是无限等', async () => {
  let inflight = 0
  const blocker = { ...fakeProvider, id: 'blk', dispatch: async () => { inflight++; await new Promise(r => setTimeout(r, 400)); inflight--; return { text: 'x' } } }
  const { ctx, registered } = mockCtx()
  registerTools(ctx, { registry: createRegistry([blocker]), config: { providers: {}, defaults: { timeoutMs: 30000, maxConcurrent: 1 } } })
  const tool = registered.find(x => x.name === 'agent_dispatch')
  const ac = new AbortController()
  const second = tool.execute({ provider: 'blk', prompt: 'second' }, { signal: ac.signal })
  setTimeout(() => ac.abort(), 50) // 第二个调用会排队，50ms 后被取消
  await assert.rejects(() => second, /abort|cancel/i)
})
