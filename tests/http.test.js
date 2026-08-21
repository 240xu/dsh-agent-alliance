import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHttp } from '../src/http.js'
import { createRegistry } from '../src/provider/types.js'

function mockHost() {
  const routes = []
  return {
    routes,
    register(r) { routes.push(r) },
    async handle(method, path, body) {
      const route = routes.find(r => r.path === path.split('?')[0])
      if (!route) return { status: 404 }
      const req = { method, on(ev, cb) { if (ev === 'data') body && cb(JSON.stringify(body)); if (ev === 'end') cb() }, destroyed: false, destroy() {} }
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

test('注册四个端点', () => {
  const host = mockHost()
  registerHttp(host, { registry: createRegistry([okProvider]), config: { defaults: {} }, home: '/tmp' })
  const paths = host.routes.map(r => r.path).sort()
  assert.deepEqual(paths, ['/__agent-alliance/dispatch', '/__agent-alliance/jobs', '/__agent-alliance/sessions', '/__agent-alliance/state'])
})

test('GET state：探测结果', async () => {
  const host = mockHost()
  registerHttp(host, { registry: createRegistry([okProvider]), config: { defaults: {} }, home: '/tmp' })
  const r = await host.handle('GET', '/__agent-alliance/state')
  assert.equal(r.status, 200)
  assert.equal(r.json.providers[0].id, 'p1')
  assert.equal(r.json.providers[0].available, true)
})

test('GET sessions：带 provider 过滤与 imported 标注', async () => {
  const host = mockHost()
  registerHttp(host, { registry: createRegistry([okProvider]), config: { defaults: {} }, home: '/tmp' })
  const r = await host.handle('GET', '/__agent-alliance/sessions?provider=p1')
  assert.equal(r.status, 200)
  assert.equal(r.json.sessions[0].provider, 'p1')
})

test('POST dispatch：成功返回文本；错误方法 405', async () => {
  const host = mockHost()
  registerHttp(host, { registry: createRegistry([okProvider]), config: { defaults: { timeoutMs: 5000 } }, home: '/tmp' })
  const bad = await host.handle('GET', '/__agent-alliance/dispatch')
  assert.equal(bad.status, 405)
  const ok = await host.handle('POST', '/__agent-alliance/dispatch', { provider: 'p1', prompt: 'hi' })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.text, 'R:hi')
})
