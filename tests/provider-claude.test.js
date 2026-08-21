import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeClaudeProvider } from '../src/provider/claude.js'

function fakeRunner(stdout, code = 0) {
  const calls = []
  const spawnCli = async (opts) => {
    calls.push(opts)
    return { code, stdout, stderr: code === 0 ? '' : 'simulated failure', timedOut: false, aborted: false }
  }
  return { spawnCli, calls }
}

const BIN = '/fake-prefix/lib/node_modules/@anthropic-ai/claude-code-linux-arm64/claude'
const GRUN = '/fake-prefix/bin/grun'

test('dispatch：argv 组装正确（grun 包装 + stream-json）', async () => {
  const { spawnCli, calls } = fakeRunner(JSON.stringify({
    type: 'result', subtype: 'success', result: '答A', session_id: 's-1',
  }))
  const p = makeClaudeProvider({ deps: { spawnCli, paths: { grun: GRUN, claudeBin: BIN } } })
  const out = await p.dispatch({ prompt: '问题X' })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].argv, [GRUN, BIN, '-p', '问题X', '--output-format', 'stream-json'])
  assert.equal(out.text, '答A')
  assert.equal(out.externalSessionId, 's-1')
})

test('dispatch：resume 与 model 追加参数；cwd 透传', async () => {
  const { spawnCli, calls } = fakeRunner('{"type":"result","result":"续答","session_id":"s-1"}')
  const p = makeClaudeProvider({ deps: { spawnCli, paths: { grun: GRUN, claudeBin: BIN } } })
  await p.dispatch({ prompt: '继续', resumeSessionId: 's-1', model: 'claude-y', cwd: '/w' })
  assert.ok(calls[0].argv.includes('--resume') && calls[0].argv.includes('s-1'))
  assert.ok(calls[0].argv.includes('--model') && calls[0].argv.includes('claude-y'))
  assert.equal(calls[0].cwd, '/w')
})

test('dispatch：非零退出抛错并带 stderr 尾部', async () => {
  const { spawnCli } = fakeRunner('', 1)
  const p = makeClaudeProvider({ deps: { spawnCli, paths: { grun: GRUN, claudeBin: BIN } } })
  await assert.rejects(() => p.dispatch({ prompt: 'x' }), /simulated failure/)
})

test('listSessions：扫描 projects 根，取 summary 或首条 user 文本作标题', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-claude-'))
  const proj = path.join(root, '-data-data-com-termux-files-home-proj')
  fs.mkdirSync(proj, { recursive: true })
  fs.writeFileSync(path.join(proj, 'aaa.jsonl'),
    JSON.stringify({ type: 'summary', summary: '修复登录 bug' }) + '\n' +
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '修复登录 bug 的会话首问' }] }, timestamp: '2026-08-20T10:00:00Z' }))
  fs.writeFileSync(path.join(proj, 'bbb.jsonl'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '没有摘要时的标题' }] }, timestamp: '2026-08-21T09:00:00Z' }))
  const p = makeClaudeProvider({ deps: { paths: { grun: GRUN, claudeBin: BIN, projectsRoot: root } } })
  const sessions = await p.listSessions({})
  assert.equal(sessions.length, 2)
  const aaa = sessions.find(s => s.id === 'aaa')
  assert.equal(aaa.title, '修复登录 bug')
  const bbb = sessions.find(s => s.id === 'bbb')
  assert.equal(bbb.title, '没有摘要时的标题')
  // query 过滤
  const filtered = await p.listSessions({ query: '登录' })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].id, 'aaa')
})

test('readSession：按 id 找文件并抽取 user/assistant 文本', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-claude-'))
  const proj = path.join(root, '-x')
  fs.mkdirSync(proj)
  fs.writeFileSync(path.join(proj, 'ccc.jsonl'),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '问1' }] } }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '答1' }] } }))
  const p = makeClaudeProvider({ deps: { paths: { grun: GRUN, claudeBin: BIN, projectsRoot: root } } })
  const s = await p.readSession('ccc')
  assert.equal(s.messages.length, 2)
  assert.equal(s.messages[0].role, 'user')
  assert.equal(s.messages[0].text, '问1')
  assert.equal(s.messages[1].text, '答1')
})
