// tests/diagnostic.test.js — 官方诊断契约的回归测试。
import test from 'node:test'
import assert from 'node:assert/strict'

import { cliFailure, classifyCliFailure, limitDiagnostic, MAX_DIAGNOSTIC_BYTES } from '../src/diagnostic.js'

test('classifyCliFailure uses the official seven categories', () => {
  assert.equal(classifyCliFailure({ code: 1, stderr: 'Error: quota exceeded' }), 'limit')
  assert.equal(classifyCliFailure({ code: 1, stderr: '429 Too Many Requests' }), 'limit')
  assert.equal(classifyCliFailure({ code: 1, stderr: '401 unauthorized / invalid API key' }), 'access-policy')
  assert.equal(classifyCliFailure({ code: 1, stderr: 'ECONNRESET' }), 'transport')
  assert.equal(classifyCliFailure({ code: 1, stderr: 'malformed JSON' }), 'invalid-result')
  assert.equal(classifyCliFailure({ code: 1, stderr: '503 service unavailable' }), 'service')
  assert.equal(classifyCliFailure({ code: 1, stderr: 'something else' }), 'unknown')
  assert.equal(classifyCliFailure({ aborted: true }), 'transport')
  assert.equal(classifyCliFailure({ timedOut: true }), 'limit')
})

test('cliFailure never puts raw output in the model-visible message', () => {
  const raw = 'DEEPSEEK_API_KEY=sk-secret-123\n' + 'at codex.js:53\n' + 'quota exceeded'
  const error = cliFailure({ provider: 'codex', r: { code: 1, stderr: raw }, raw })

  assert.match(error.message, /External CLI failure \(/)
  assert.match(error.message, /product: codex/)
  assert.match(error.message, /category: limit/)
  assert.match(error.message, /exit code: 1/)
  assert.equal(error.code, 'cli-failure')
  assert.equal(error.category, 'limit')

  // Official contract: no credentials, env values, file contents or raw
  // protocol payloads in the diagnostic.
  assert.doesNotMatch(error.message, /sk-secret-123/)
  assert.doesNotMatch(error.message, /codex\.js:53/)
  assert.doesNotMatch(error.message, /quota exceeded/)
  // Raw output is retained on the cause for Host logs, not for the model.
  assert.match(String(error.cause?.rawOutput), /sk-secret-123/)
})

test('limitDiagnostic truncates on a UTF-8 boundary with a visible marker', () => {
  const text = '汉'.repeat(3000) // 9000 UTF-8 bytes
  const limited = limitDiagnostic(text)
  const bytes = new TextEncoder().encode(limited)
  assert.ok(bytes.byteLength <= MAX_DIAGNOSTIC_BYTES, 'must respect the 4096-byte cap')
  assert.match(limited, /\[diagnostic truncated\]/)
  // The result must be valid UTF-8, i.e. no replacement character from a
  // split multi-byte sequence.
  assert.doesNotMatch(limited, /\uFFFD/)
  assert.equal(limitDiagnostic('short'), 'short')
})

test('a missing CLI is classified product-error, not service (real dispatch regression)', () => {
  // On a real web-profile dispatch, codex's node stack frame contained
  // `loader:1568`; a loose /5\d\d/ rule read it as HTTP 503 and reported
  // `category: service` for "Cannot find module". Classify installation
  // failures first and require HTTP wording for 5xx.
  assert.equal(classifyCliFailure({ code: -1, stderr: 'spawn /missing/bin ENOENT' }), 'product-error')
  assert.equal(
    classifyCliFailure({ code: 1, stderr: 'Cannot find module \'/nonexistent/codex.js\'\n    at loader:1568' }),
    'product-error',
  )
  // A genuine 5xx still classifies as service.
  assert.equal(classifyCliFailure({ code: 1, stderr: 'HTTP 503 service unavailable' }), 'service')
  assert.equal(classifyCliFailure({ code: 1, stderr: 'bare line 1568 only' }), 'unknown')
})
