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
  assert.deepEqual(calls[0].argv, [GRUN, BIN, '-p', '问题X', '--output-format', 'stream-json', '--verbose'])
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


test('claude 标题跳过 local-command 注入行', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-claude2-'))
  const proj = path.join(root, '-p')
  fs.mkdirSync(proj)
  fs.writeFileSync(path.join(proj, 'ddd.jsonl'),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '<local-command-caveat>caveat</local-command-caveat>' }] } }) + '\n' +
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '真实提问' }] } }))
  const p = makeClaudeProvider({ deps: { paths: { grun: '/g', claudeBin: '/b', projectsRoot: root } } })
  const list = await p.listSessions({})
  assert.equal(list.find(s => s.id === 'ddd').title, '真实提问')
})


test('exportSession：完整导出规范化 turns（注入跳过 + 工具配对 + 多轮）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-claude3-'))
  const proj = path.join(root, '-w')
  fs.mkdirSync(proj)
  const L = (o) => JSON.stringify(o)
  fs.writeFileSync(path.join(proj, 'eee.jsonl'), [
    L({ type: 'summary', summary: '会话摘要标题' }),
    L({ type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>注入</system-reminder>' }] }, timestamp: '2026-08-20T10:00:00Z' }),
    L({ type: 'user', message: { content: [{ type: 'text', text: '问题一' }] }, timestamp: '2026-08-20T10:00:01Z' }),
    L({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: '回答一' }] } }),
    L({ type: 'user', message: { content: [{ type: 'text', text: '问题二' }] } }),
    L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '输出内容', is_error: false }] } }),
    L({ type: 'assistant', message: { content: [{ type: 'text', text: '工具后的总结' }] } }),
  ].join('\n'))
  const p = makeClaudeProvider({ deps: { paths: { grun: '/g', claudeBin: '/b', projectsRoot: root } } })
  const s = await p.exportSession('eee')
  assert.equal(s.title, '会话摘要标题')
  assert.equal(s.createdAt, Date.parse('2026-08-20T10:00:00Z'))
  assert.equal(s.turns.length, 2)
  assert.equal(s.turns[0].user, '问题一')
  assert.equal(s.turns[0].assistant, '回答一')
  assert.equal(s.turns[1].user, '问题二')
  assert.equal(s.turns[1].tools.length, 1)
  assert.deepEqual(s.turns[1].tools[0], { name: 'Bash', args: { command: 'ls' }, resultText: '输出内容', isError: false })
  assert.equal(s.turns[1].assistant, '工具后的总结')
})


test('exportSession：跳过 sidechain 行（子代理噪声）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-sc-'))
  const proj = path.join(root, '-w')
  fs.mkdirSync(proj)
  const L = (o) => JSON.stringify(o)
  fs.writeFileSync(path.join(proj, 'fff.jsonl'), [
    L({ type: 'user', message: { content: [{ type: 'text', text: '主问题' }] } }),
    L({ isSidechain: true, type: 'user', message: { content: [{ type: 'text', text: '子代理内部提问（噪声）' }] } }),
    L({ isSidechain: true, type: 'assistant', message: { content: [{ type: 'text', text: '子代理回答（噪声）' }] } }),
    L({ type: 'assistant', message: { content: [{ type: 'text', text: '主回答' }] } }),
  ].join('\n'))
  const p = makeClaudeProvider({ deps: { paths: { grun: '/g', claudeBin: '/b', projectsRoot: root } } })
  const s = await p.exportSession('fff')
  assert.equal(s.turns.length, 1)
  assert.equal(s.turns[0].assistant, '主回答')
})

test('an unreadable session is reported as an access error, not "not found"', async () => {
  const { makeClaudeProvider } = await import('../src/provider/claude.js')
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  const root = mkdtempSync(join(tmpdir(), 'claude-perm-'))
  const proj = join(root, 'proj1')
  mkdirSync(proj)
  const file = join(proj, 'sess1.jsonl')
  writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n')
  const provider = makeClaudeProvider({
    config: {},
    deps: { paths: { grun: '/bin/true', claudeBin: '/bin/true', projectsRoot: root } },
  })

  // listSessions must still see the session before we revoke access.
  assert.ok((await provider.listSessions({})).some((s) => s.id === 'sess1'))
  chmodSync(file, 0)
  try {
    await assert.rejects(
      () => provider.readSession('sess1'),
      (error) => {
        assert.match(String(error.message), /EACCES|permission denied/i)
        assert.doesNotMatch(String(error.message), /not found/i, 'a permission error is not a missing session')
        return true
      },
    )
  } finally {
    chmodSync(file, 0o644)
  }
  // A genuinely missing id still reports the normal "not found".
  await assert.rejects(() => provider.readSession('nope'), /not found/)
})
