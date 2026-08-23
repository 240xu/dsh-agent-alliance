#!/usr/bin/env node
// scripts/cli-acp-bridge.mjs — 把任意无头 CLI 包装成 ACP server（stdio JSON-RPC）。
// 环境变量契约：
//   AA_KIND        = echo | claude | codex | opencode
//   AA_ARGV_PREFIX = JSON 数组，CLI 启动前缀（如 ["grun","/path/claude"] 或 ["node","/path/codex.js"]）
//   AA_TMPDIR      = 覆盖子进程 TMPDIR（Termux 需要）
// 协议：initialize / session/new / session/prompt / session/cancel；
// 流式回包：session/update { sessionUpdate:'agent_message_chunk', content:{type:'text',text} }。
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const KIND = process.env.AA_KIND || 'echo'
const PREFIX = (() => { try { return JSON.parse(process.env.AA_ARGV_PREFIX || '[]') } catch { return [] } })()
const TMPDIR = process.env.AA_TMPDIR || process.env.TMPDIR

const sessions = new Map() // acpSessionId -> { cwd, externalSessionId }
let msgSeq = 0

function send(msg) { const s = JSON.stringify(msg); process.stderr.write('[SEND] ' + s.slice(0, 120) + '\n'); process.stdout.write(s + '\n') }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }) }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }) }
function notify(method, params) { send({ jsonrpc: '2.0', method, params }) }

function chunk(sessionId, text) {
  notify('session/update', {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  })
}

// ---- 各 kind 的 CLI 调用实现：返回 { promise: -> {text, externalSessionId}, cancel() } ----
function buildRunner(kind, prefix, prompt, externalSessionId, signal) {
  const env = { ...process.env }
  if (TMPDIR) env.TMPDIR = TMPDIR
  function spawnCli(argv) {
    const child = spawn(argv[0], argv.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    const done = new Promise((resolve) => {
      child.on('close', (code) => resolve({ code, stdout: out, stderr: err }))
      child.on('error', () => resolve({ code: -1, stdout: '', stderr: 'spawn failed' }))
    })
    if (signal) signal.addEventListener('abort', () => { try { child.kill('SIGKILL') } catch {} }, { once: true })
    return { done, child }
  }

  if (kind === 'echo') {
    return { promise: (async () => ({ text: 'ECHO:' + prompt, externalSessionId: null }))(), cancel: () => {} }
  }
  if (kind === 'claude') {
    let argv = [...prefix, '-p', String(prompt), '--output-format', 'stream-json', '--verbose']
    if (externalSessionId) argv.push('--resume', String(externalSessionId))
    const { done, child } = spawnCli(argv)
    const promise = done.then(({ code, stdout, stderr }) => {
      let text = '', sid
      for (const line of stdout.split('\n')) {
        let o; try { o = JSON.parse(line) } catch { continue }
        if (typeof o.session_id === 'string' && !sid) sid = o.session_id
        if (o.type === 'result') { if (typeof o.result === 'string') text = o.result; if (o.session_id) sid = o.session_id }
        else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
          for (const b of o.message.content) if (b?.type === 'text' && b.text && !text) text = b.text
        }
      }
      if (!text && code !== 0) throw new Error('claude 失败(exit ' + code + '): ' + stderr.slice(-200))
      return { text, externalSessionId: sid ?? externalSessionId }
    })
    return { promise, cancel: () => { try { child.kill('SIGKILL') } catch {} } }
  }
  if (kind === 'opencode') {
    let argv = [...prefix, 'run', String(prompt), '--format', 'json']
    if (externalSessionId) argv.push('-s', String(externalSessionId))
    const { done, child } = spawnCli(argv)
    const promise = done.then(({ code, stdout, stderr }) => {
      let text = '', sid
      for (const line of stdout.split('\n')) {
        let o; try { o = JSON.parse(line) } catch { continue }
        const s = o.sessionID || o.session_id || o.sessionId
        if (typeof s === 'string' && !sid) sid = s
        const part = o.part ?? o
        if (part?.type === 'text' && typeof part.text === 'string') text += part.text + '\n'
      }
      text = text.trim()
      if (!text && code !== 0) throw new Error('opencode 失败(exit ' + code + '): ' + stderr.slice(-200))
      return { text, externalSessionId: sid ?? externalSessionId }
    })
    return { promise, cancel: () => { try { child.kill('SIGKILL') } catch {} } }
  }
  if (kind === 'codex') {
    let argv = [...prefix, 'exec', '--skip-git-repo-check']
    if (externalSessionId) argv.push('resume', String(externalSessionId))
    argv.push(String(prompt))
    const { done, child } = spawnCli(argv)
    const promise = done.then(({ code, stdout, stderr }) => {
      // 解析：session id 行 + 末段回答
      let sid; const sm = stdout.match(/session\s*id[:\s]+([0-9a-f][0-9a-f-]{20,})/i)
      if (sm) sid = sm[1]
      const blocks = stdout.split(/\n-{8,}\n/)
      let body = blocks.length >= 2 ? blocks[blocks.length - 1] : stdout
      body = body.replace(/^Codex\s*\n/, '')
      const metaIdx = body.search(/\ntokens used:/i)
      if (metaIdx >= 0) body = body.slice(0, metaIdx)
      const text = body.trim()
      if (!text && code !== 0) throw new Error('codex 失败(exit ' + code + '): ' + (stderr || stdout).slice(-200))
      return { text, externalSessionId: sid ?? externalSessionId }
    })
    return { promise, cancel: () => { try { child.kill('SIGKILL') } catch {} } }
  }
  // echo 兜底已在上方；未知 kind 视为 echo
  return { promise: Promise.resolve({ text: '[unknown kind ' + kind + ']', externalSessionId: null }), cancel: () => {} }
}


// ---- 主循环 ----
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx); buf = buf.slice(idx + 1)
    if (!line.trim()) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    handleMessage(msg)
  }
})
process.stdin.on('end', () => process.exit(0))

async function handleMessage(msg) {
  const { id, method, params } = msg
  try {
    switch (method) {
      case 'initialize':
        reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { embeddedContext: false } } })
        break
      case 'notifications/initialized':
      case 'notifications/cancelled':
        break
      case 'session/new': {
        const sid = randomUUID()
        sessions.set(sid, { cwd: params?.cwd || process.cwd(), externalSessionId: null })
        reply(id, { sessionId: sid })
        break
      }
      case 'session/prompt': {
        const sid = String(params?.sessionId || '')
        const sess = sessions.get(sid)
        if (!sess) { replyErr(id, -32602, 'unknown session: ' + sid); break }
        const text = (Array.isArray(params?.prompt) ? params.prompt : [])
          .filter(b => b?.type === 'text').map(b => b.text).join('\n')
        const runner = buildRunner(KIND, PREFIX, text, sess.externalSessionId, null)
        const out = await runner.promise
        sess.externalSessionId = out.externalSessionId ?? sess.externalSessionId
        if (out.text) chunk(sid, out.text)
        reply(id, { stopReason: 'end_turn' })
        break
      }
      case 'session/cancel':
        break
      default:
        if (id !== undefined) replyErr(id, -32601, 'method not found: ' + method)
    }
  } catch (err) {
    if (id !== undefined) replyErr(id, -32603, String(err?.message || err).slice(-300))
  }
}
