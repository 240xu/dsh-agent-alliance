import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseClaudeStreamJson, parseOpencodeEvents, parseCodexOutput } from '../src/parse.js'

const fx = (name) => readFileSync(fileURLToPath(new URL('./fixtures/' + name, import.meta.url)), 'utf8')

test('claude stream-json：取 result 文本与会话 id', () => {
  const r = parseClaudeStreamJson(fx('claude-stream.jsonl'))
  assert.equal(r.text, '你好，世界！')
  assert.equal(r.sessionId, '9a1b2c3d-1111-2222-3333-444455556666')
})

test('claude stream-json：无 result 行时回退拼接 assistant text', () => {
  const lines = fx('claude-stream.jsonl').split('\n').filter(l => l && !l.includes('"type":"result"')).join('\n')
  const r = parseClaudeStreamJson(lines)
  assert.equal(r.text, '你好，世界！')
  assert.equal(r.sessionId, '9a1b2c3d-1111-2222-3333-444455556666')
})

test('opencode 事件流：拼接 text part 与 sessionID', () => {
  const r = parseOpencodeEvents(fx('opencode-events.jsonl'))
  assert.equal(r.text, 'OpenCode 回答第一段\n第二段')
  assert.equal(r.sessionId, 'ses_abc123')
})

test('codex 输出：末段回答与 session id', () => {
  const r = parseCodexOutput(fx('codex-output.txt'))
  assert.equal(r.sessionId, '00000000-1111-2222-3333-444455556666')
  assert.match(r.text, /最终回答内容在这里/)
  assert.doesNotMatch(r.text, /tokens used/)
})

test('三个解析器对空输入不炸', () => {
  assert.deepEqual(parseClaudeStreamJson(''), { text: '', sessionId: undefined })
  assert.deepEqual(parseOpencodeEvents(''), { text: '', sessionId: undefined })
  assert.deepEqual(parseCodexOutput(''), { text: '', sessionId: undefined })
})
