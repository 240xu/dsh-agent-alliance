import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const bridgePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cli-acp-bridge.mjs')

function startBridge(env) {
  const child = spawn(process.execPath, [bridgePath], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const lineQueue = []   // 永不丢弃：所有到达行按序入队
  const waiters = []     // 等待下一行的读取者
  let buf = ''
  let closed = false
  child.stdout.setEncoding('utf8')
  child.stderr.on('data', () => {})
  child.stdout.on('data', (x) => {
    buf += x
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!l) continue
      const w = waiters.shift()
      if (w) w(l)
      else lineQueue.push(l)
    }
  })
  child.on('exit', () => { closed = true })
  function readLine(ms = 5000) {
    if (lineQueue.length) return Promise.resolve(lineQueue.shift())
    if (closed) return Promise.resolve(null)
    return new Promise((res) => {
      const w = (l) => res(l)
      waiters.push(w)
      setTimeout(() => {
        const idx = waiters.indexOf(w)
        if (idx >= 0) { waiters.splice(idx, 1); res(null) }
      }, ms)
    })
  }
  const send = (o) => { if (!closed) child.stdin.write(JSON.stringify(o) + '\n') }
  async function request(id, method, params) {
    send({ jsonrpc: '2.0', id, method, params })
    const l = await readLine(5000)
    return l ? JSON.parse(l) : null
  }
  return { request, send, readLine, kill: () => { closed = true; try { child.kill('SIGKILL') } catch {} } }
}
test('echo 桥：initialize → session/new → prompt 流式回包', async () => {
  const b = startBridge({ AA_KIND: 'echo' })
  try {
    const init = await b.request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
    assert.ok(init && init.result.protocolVersion !== undefined, 'initialize 应答')
    b.send({ jsonrpc: '2.0', method: 'notifications/initialized' })

    const sn = await b.request(2, 'session/new', { cwd: '/tmp' })
    assert.ok(sn && sn.result.sessionId, 'session/new 应答')
    const sid = sn.result.sessionId

    b.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: '你好桥' }] } })
    let sawChunk = false
    let stop = null
    for (let guard = 0; guard < 6 && !stop; guard++) {
      const l = await b.readLine(2000)
      if (l === null) break
      const m = (() => { try { return JSON.parse(l) } catch { return null } })()
      console.error('LOOP:', JSON.stringify(m).slice(0, 140))
      if (!m) continue
      // 通知与响应到达顺序不保证：分别判定，凑齐即止
      if (m.id === 3 && m.result) { stop = m.result; continue }
      if (m.id === 3 && m.error) { stop = { stopReason: 'error:' + (m.error.message || '') }; continue }
      if (m.method === 'session/update' && m.params?.update?.content?.text) sawChunk = true
    }
    assert.ok(stop, '应收到 prompt 终止')
    assert.equal(stop.stopReason, 'end_turn')
    assert.ok(sawChunk, '应收到文本 chunk')
  } finally {
    b.kill()
  }
})
