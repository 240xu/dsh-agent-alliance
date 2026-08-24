import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHttp } from '../src/http.js'
import { createRegistry } from '../src/provider/types.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aa-http-'))

function mockHost() {
  const routes = []
  return {
    routes,
    register(r) { routes.push(r) },
    async handle(method, path, body) {
      const route = routes.find(r => r.path === path.split('?')[0])
      if (!route) return { status: 404 }
      const req = { method, url: path, on(ev, cb) { if (ev === 'data') body && cb(JSON.stringify(body)); if (ev === 'end') cb() }, destroyed: false, destroy() {} }
      const res = { statusCode: 0, headers: null, out: '', writeHead(s, h) { this.statusCode = s; this.headers = h }, end(x) { this.out += x ?? '' } }
      await route.handler(req, res)
      let json = null
      try { json = JSON.parse(res.out) } catch {}
      return { status: res.statusCode, json }
    },
  }
}

const okProvider = {
  id: 'p1', label: 'P1',
  detect: async () => ({ available: true, version: '1.0' }),
  dispatch: async ({ prompt }) => ({ text: 'R:' + prompt, externalSessionId: 'x9' }),
  listSessions: async () => [{ id: 's1', title: 't', createdAt: null, messageCount: null }],
}

test('POST roundtable：批次化执行（无宿主 job 依赖），GET 轮询直至完成且入列任务中心', async () => {
  const p = { ...okProvider, dispatch: async ({ prompt }) => ({ text: '桌答:' + prompt }) }
  const host = mockHost()
  registerHttp(host, { registry: createRegistry([p]), config: { defaults: {} }, home: tmpHome() })
  const r1 = await host.handle('POST', '/__agent-alliance/roundtable', { prompt: '评审这个设计' })
  assert.equal(r1.status, 200)
  const bid = r1.json.batchId
  assert.ok(bid && String(bid).startsWith('batch-'))
  await new Promise((r) => setTimeout(r, 20))
  const r2 = await host.handle('GET', '/__agent-alliance/roundtable?id=' + bid)
  assert.equal(r2.status, 200)
  assert.equal(r2.json.running, false)
  assert.match(r2.json.output, /桌答:评审这个设计/)
  // 任务中心应包含该批次
  const tl = await host.handle('GET', '/__agent-alliance/tasks')
  const row = (tl.json.tasks || []).find(x => x.id === bid)
  assert.ok(row, '批次应出现在任务列表')
  assert.equal(row.status, 'completed')
  // task-output 也能读批次
  const to = await host.handle('GET', '/__agent-alliance/task-output?id=' + bid)
  assert.equal(to.status, 200)
  assert.match(to.json.text, /桌答/)
})

test('注册九个端点', () => {
  const host = mockHost()
  registerHttp(host, { registry: createRegistry([okProvider]), config: { defaults: {} }, home: tmpHome() })
  const paths = host.routes.map(r => r.path).sort()
  assert.deepEqual(paths, [
    '/__agent-alliance/dispatch',
    '/__agent-alliance/import',
    '/__agent-alliance/jobs',
    '/__agent-alliance/roundtable',
    '/__agent-alliance/session-content',
    '/__agent-alliance/sessions',
    '/__agent-alliance/state',
    '/__agent-alliance/task-kill',
    '/__agent-alliance/task-output',
    '/__agent-alliance/tasks',
  ])
})

test('GET session-content：读取外部会话内容', async () => {
  const p = { ...okProvider, readSession: async (id) => ({ title: 'T', messages: [{ role: 'user', text: 'q-' + id }] }) }
  const host = mockHost()
  registerHttp(host, { registry: createRegistry([p]), config: { defaults: {} }, home: tmpHome() })
  const r = await host.handle('GET', '/__agent-alliance/session-content?provider=p1&id=s1')
  assert.equal(r.status, 200)
  assert.equal(r.json.title, 'T')
  assert.equal(r.json.messages[0].text, 'q-s1')
})

test('POST import：导入成功返回 dshSessionId；重复幂等', async () => {
  const p = { ...okProvider, exportSession: async () => ({ title: 'T', createdAt: 1, cwd: '/w', turns: [{ user: 'u', assistant: 'a' }] }) }
  const created = []
  const host = mockHost()
  const registry = createRegistry([p])
  registerHttp(host, {
    registry, config: { defaults: {} },
    home: tmpHome(),
    // 测试注入落库通道：真实走 ctx.get('agents')，这里直接给 agents 服务
    getAgents: () => ({ create: async (spec) => { created.push(spec) } }),
  })
  const r1 = await host.handle('POST', '/__agent-alliance/import', { provider: 'p1', sessionId: 's1' })
  assert.equal(r1.status, 200)
  assert.equal(r1.json.status, 'imported')
  assert.ok(r1.json.dshSessionId)
  assert.equal(created.length, 1)
  const r2 = await host.handle('POST', '/__agent-alliance/import', { provider: 'p1', sessionId: 's1' })
  assert.equal(r2.json.status, 'already-imported')
})

test('GET state：探测结果', async () => {
  const host = mockHost()
  registerHttp(host, { registry: createRegistry([okProvider]), config: { defaults: {} }, home: tmpHome() })
  const r = await host.handle('GET', '/__agent-alliance/state')
  assert.equal(r.status, 200)
  assert.equal(r.json.providers[0].id, 'p1')
  assert.equal(r.json.providers[0].available, true)
})

test('GET sessions：带 provider 过滤与 imported 标注', async () => {
  const host = mockHost()
  registerHttp(host, { registry: createRegistry([okProvider]), config: { defaults: {} }, home: tmpHome() })
  const r = await host.handle('GET', '/__agent-alliance/sessions?provider=p1')
  assert.equal(r.status, 200)
  assert.equal(r.json.sessions[0].provider, 'p1')
})

test('POST dispatch：成功返回文本；错误方法 405', async () => {
  const host = mockHost()
  registerHttp(host, { registry: createRegistry([okProvider]), config: { defaults: { timeoutMs: 5000 } }, home: tmpHome() })
  const bad = await host.handle('GET', '/__agent-alliance/dispatch')
  assert.equal(bad.status, 405)
  const ok = await host.handle('POST', '/__agent-alliance/dispatch', { provider: 'p1', prompt: 'hi' })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.text, 'R:hi')
})


test('POST import：经真实 ctx 走 persistence 直写（面板修复回归）', async () => {
  const created = []
  const p = { ...okProvider, exportSession: async () => ({ title: 'T', createdAt: 1, cwd: '/w', turns: [{ user: 'u', assistant: 'a' }] }) }
  const host = mockHost()
  const fakeCtx = {
    get(name) {
      if (name === 'sessionPersistence') return { create: async () => {}, append: async () => {} }
      if (name === 'sessionProjectionCache') return { coldSnapshot: async () => {} }
      return undefined
    },
  }
  registerHttp(host, { registry: createRegistry([p]), config: { defaults: {} }, home: tmpHome(), ctx: fakeCtx })
  const r = await host.handle('POST', '/__agent-alliance/import', { provider: 'p1', sessionId: 'sx' })
  assert.equal(r.status, 200)
  assert.equal(r.json.status, 'imported')
})


test('任务中心三端点：list 过滤 kind / read 输出 / kill 取消', async () => {
  const fakeJobs = {
    list: () => [
      { id: 'agent-alliance-1', kind: 'agent-alliance', label: 'x', status: 'running' },
      { id: 'bash-9', kind: 'bash', label: 'y', status: 'completed' },
    ],
    read: (id) => { if (id !== 'agent-alliance-1') throw new Error('unknown job'); return { text: '输出内容', snapshot: { status: 'completed' } } },
    kill: () => 'requested',
  }
  const p = { ...okProvider }
  const host = mockHost()
  const fakeCtx = { get: () => undefined, jobs: fakeJobs }
  registerHttp(host, { registry: createRegistry([p]), config: { defaults: {} }, home: tmpHome(), ctx: fakeCtx })
  const l = await host.handle('GET', '/__agent-alliance/tasks')
  assert.equal(l.status, 200)
  assert.equal(l.json.tasks.length, 1)
  assert.equal(l.json.tasks[0].id, 'agent-alliance-1')
  const o = await host.handle('GET', '/__agent-alliance/task-output?id=agent-alliance-1')
  assert.equal(o.status, 200)
  assert.equal(o.json.text, '输出内容')
  const nf = await host.handle('GET', '/__agent-alliance/task-output?id=nope')
  assert.ok(nf.status >= 400 && nf.status < 500, '未知 job 应返回 4xx: ' + nf.status)
  const k = await host.handle('POST', '/__agent-alliance/task-kill', { id: 'agent-alliance-1' })
  assert.equal(k.status, 200)
  assert.equal(k.json.outcome, 'requested')
})
