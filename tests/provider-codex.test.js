import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { makeCodexProvider } from '../src/provider/codex.js'

const fx = (name) => readFileSync(fileURLToPath(new URL('./fixtures/' + name, import.meta.url)), 'utf8')

function fakeRunner(stdout, code = 0) {
  const calls = []
  const spawnCli = async (opts) => { calls.push(opts); return { code, stdout, stderr: '', timedOut: false, aborted: false } }
  return { spawnCli, calls }
}

const CODEX_JS = '/fake-prefix/lib/node_modules/@openai/codex/bin/codex.js'

test('dispatch：exec argv 组装（绝对 node 入口 + skip-git-repo-check）', async () => {
  const { spawnCli, calls } = fakeRunner(fx('codex-output.txt'))
  const p = makeCodexProvider({ deps: { spawnCli, paths: { codexJs: CODEX_JS } } })
  const out = await p.dispatch({ prompt: '看看仓库' })
  assert.deepEqual(calls[0].argv, [process.execPath, CODEX_JS, 'exec', '--skip-git-repo-check', '看看仓库'])
  assert.equal(out.sessionId ?? out.externalSessionId, '00000000-1111-2222-3333-444455556666')
  assert.match(out.text, /最终回答内容在这里/)
})

test('dispatch：resume 走 exec resume <id>；cwd 用 -C', async () => {
  const { spawnCli, calls } = fakeRunner('回答')
  const p = makeCodexProvider({ deps: { spawnCli, paths: { codexJs: CODEX_JS } } })
  await p.dispatch({ prompt: '继续', resumeSessionId: 'sid-9', cwd: '/w' })
  const argv = calls[0].argv
  assert.equal(argv[argv.indexOf('resume') + 1], 'sid-9')
  assert.ok(argv.includes('-C') && argv.includes('/w'))
})

test('listSessions/readSession：扫描 rollout 文件（fixture 目录）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-codex-'))
  const day = path.join(root, '2026', '08', '20')
  fs.mkdirSync(day, { recursive: true })
  fs.writeFileSync(path.join(day, 'rollout-2026-08-20T10-00-00-019e.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { id: '019e', cwd: '/x', timestamp: '2026-08-20T10:00:00Z' } }) + '\n' +
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex 首问标题' }] } }))
  const p = makeCodexProvider({ deps: { paths: { sessionsRoot: root, codexJs: CODEX_JS } } })
  const list = await p.listSessions({})
  assert.equal(list.length, 1)
  assert.equal(list[0].id, '019e')
  assert.equal(list[0].title, 'codex 首问标题')
  const s = await p.readSession('019e')
  assert.equal(s.messages[0].role, 'user')
  assert.equal(s.messages[0].text, 'codex 首问标题')
})
