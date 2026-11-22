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

test('parseClaudeStreamJson maps usage onto DSH disjoint fields without arithmetic', async () => {
  const { parseClaudeStreamJson } = await import('../src/parse.js')
  const lines = [
    JSON.stringify({ type: 'system', session_id: 's-1' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }),
    JSON.stringify({
      type: 'result',
      result: 'final answer',
      session_id: 's-1',
      usage: {
        input_tokens: 1200,
        output_tokens: 340,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 250,
      },
    }),
  ].join('\n')
  const parsed = parseClaudeStreamJson(lines)

  assert.equal(parsed.text, 'final answer')
  assert.equal(parsed.sessionId, 's-1')
  // Anthropic already separates uncached from cached input, which IS DSH's
  // disjoint convention — so 1200 stays 1200. Subtracting the cache counters
  // here (a tempting "align to disjoint" move) would double-count, because the
  // official adapter (claude-code-mods/src/index.ts:148-151) adds them without
  // arithmetic. This test pins that fact.
  assert.deepEqual(parsed.usage, {
    inputTokens: 1200,
    outputTokens: 340,
    cacheReadTokens: 900,
    cacheWriteTokens: 250,
  })
})

test('a CLI that reports no cache counters yields no cache fields', async () => {
  const { parseClaudeStreamJson } = await import('../src/parse.js')
  const parsed = parseClaudeStreamJson(JSON.stringify({
    type: 'result', result: 'ok', session_id: 's-2', usage: { input_tokens: 10, output_tokens: 2 },
  }))
  // Absent must stay absent: a provider that never caches must not look like it
  // reported a cache miss of 0.
  assert.deepEqual(parsed.usage, { inputTokens: 10, outputTokens: 2 })
  assert.equal('cacheReadTokens' in parsed.usage, false)
  assert.equal('cacheWriteTokens' in parsed.usage, false)
})

test('a run with no usage line carries no usage field at all', async () => {
  const { parseClaudeStreamJson } = await import('../src/parse.js')
  const parsed = parseClaudeStreamJson(JSON.stringify({ type: 'result', result: 'ok', session_id: 's-3' }))
  assert.equal('usage' in parsed, false, 'no usage must mean no field, not usage: undefined')
})
