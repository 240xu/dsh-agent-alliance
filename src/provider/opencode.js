// src/provider/opencode.js — OpenCode Provider。
// 本机形态：原生二进制（Xu 管理的包装脚本指向 ~/.local/share/xucodex/opencode/bin/opencode）。
// 关键：Termux 无 /tmp，必须 TMPDIR=$PREFIX/tmp，否则 opencode 报 EACCES mkdir /tmp/opencode。
// dispatch: <bin> run <prompt> --format json [-s sessionId]
// 会话存储：~/.local/share/opencode/opencode.db（SQLite 只读；session/message/part 表）

import { spawnCli as defaultSpawnCli, normalizeEnv } from '../runner.js'
import { parseOpencodeEvents } from '../parse.js'
import { defineProvider } from './types.js'

function prefix() {
  return process.env.PREFIX || '/data/data/com.termux/files/usr'
}

function home() {
  return process.env.HOME || '/data/data/com.termux/files/home'
}

export function opencodeDefaultPaths() {
  return {
    opencodeBin: home() + '/.local/share/xucodex/opencode/bin/opencode',
    dbPath: home() + '/.local/share/opencode/opencode.db',
  }
}

export function makeOpencodeProvider({ deps = {}, config = {} } = {}) {
  const spawnCli = deps.spawnCli || defaultSpawnCli
  const paths = { ...opencodeDefaultPaths(), ...(deps.paths || {}) }
  const openDb = deps.openDb || null // 测试注入；生产走 node:sqlite 惰性加载

  async function detect() {
    try {
      const r = await spawnCli({
        argv: [paths.opencodeBin, '--version'], timeoutMs: 15000,
        env: { TMPDIR: prefix() + '/tmp' },
      })
      if (r.code !== 0) return { available: false, detail: (r.stderr || r.stdout).slice(-200) }
      return { available: true, version: r.stdout.trim().split('\n')[0] }
    } catch (err) {
      return { available: false, detail: String(err?.message || err) }
    }
  }

  async function dispatch({ prompt, cwd, resumeSessionId, model, timeoutMs = 300000, signal }) {
    const effModel = model || config.defaultModel || null // 显式 > 配置默认 > 无
    let argv = [paths.opencodeBin, 'run', String(prompt)]
    if (resumeSessionId) argv.push('-s', String(resumeSessionId))
    if (effModel) argv.push('-m', String(effModel))
    argv.push('--format', 'json')
    const env = { TMPDIR: prefix() + '/tmp' }
    const r = await spawnCli({ argv, cwd, env, timeoutMs, signal })
    const parsed = parseOpencodeEvents(r.stdout)
    if (r.code !== 0 && !parsed.text) {
      throw new Error('opencode dispatch 失败 (exit ' + r.code + '): ' + (r.stderr || r.stdout).slice(-400))
    }
    return { text: parsed.text, externalSessionId: parsed.sessionId, raw: r }
  }

  async function db() {
    if (openDb) return openDb()
    // 生产路径：node:sqlite 只读打开（node >=22.5）；ESM 下用动态 import
    const { DatabaseSync } = await import('node:sqlite')
    return new DatabaseSync(paths.dbPath, { readOnly: true })
  }

  async function listSessions({ query, limit = 20 } = {}) {
    try {
      const d = await db()
      const rows = d.prepare(
        'SELECT id, title, directory, time_created FROM session ORDER BY time_updated DESC LIMIT ?'
      ).all(Math.max(limit * 4, 100))
      let out = rows.map(r => ({
        id: r.id,
        title: r.title ?? undefined,
        cwd: r.directory ?? undefined,
        createdAt: r.time_created ?? null,
        messageCount: null,
      }))
      if (query) {
        out = out.filter(s => (s.title || '').includes(query) || (s.cwd || '').includes(query) || s.id.includes(query))
      }
      return out.slice(0, limit)
    } catch (err) {
      throw new Error('opencode listSessions 失败: ' + String(err?.message || err))
    }
  }

  async function readSession(id, { maxChars = 8000 } = {}) {
    const d = await db()
    const sess = d.prepare('SELECT id, title FROM session WHERE id = ?').get(id)
    if (!sess) throw new Error('opencode session not found: ' + id)
    const rows = d.prepare(
      `SELECT m.data AS mdata, p.data AS pdata
       FROM part p JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ?
       ORDER BY p.time_created ASC`
    ).all(id)
    const messages = []
    for (const row of rows) {
      let pdata, mdata
      try { pdata = JSON.parse(row.pdata); mdata = JSON.parse(row.mdata || '{}') } catch { continue }
      if (pdata?.type === 'text' && typeof pdata.text === 'string' && pdata.text.trim()) {
        messages.push({ role: mdata.role === 'assistant' ? 'assistant' : 'user', text: pdata.text })
      }
    }
    let total = 0
    const capped = []
    for (const m of messages) {
      if (total >= maxChars) break
      const t = m.text.slice(0, maxChars - total)
      capped.push({ role: m.role, text: t })
      total += t.length
    }
    return { title: sess.title ?? undefined, messages: capped }
  }

  // 完整导出（导入器用）：按 message 时间分组为 turns
  async function exportSession(id) {
    const d = await db()
    const sess = d.prepare('SELECT id, title, directory, time_created FROM session WHERE id = ?').get(id)
    if (!sess) throw new Error('opencode session not found: ' + id)
    const rows = d.prepare(
      `SELECT m.id AS mid, m.time_created AS mt, m.data AS mdata, p.data AS pdata
       FROM part p JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ? ORDER BY p.time_created ASC`
    ).all(id)
    const turns = []
    let cur = null
    for (const row of rows) {
      let pdata, mdata
      try { pdata = JSON.parse(row.pdata); mdata = JSON.parse(row.mdata || '{}') } catch { continue }
      if (pdata?.type === 'tool' && typeof pdata.tool === 'string') {
        // 工具部件：映射进当前轮的 tools（无轮则先开一轮占位）
        if (!cur) { cur = { user: undefined, assistant: undefined, tools: [] }; turns.push(cur) }
        const st = pdata.state || {}
        cur.tools.push({
          name: pdata.tool,
          args: st.input ?? {},
          resultText: typeof st.output === 'string' ? st.output : String(st.error ?? ''),
          isError: st.status === 'error',
        })
        continue
      }
      if (pdata?.type !== 'text' || typeof pdata.text !== 'string' || !pdata.text.trim()) continue
      if (mdata.role === 'assistant') {
        if (!cur) { cur = { user: undefined, assistant: undefined, tools: [] }; turns.push(cur) }
        cur.assistant = (cur.assistant ? cur.assistant + '\n' : '') + pdata.text
      } else {
        cur = { user: pdata.text, assistant: undefined, tools: [] }
        turns.push(cur)
      }
    }
    return { title: sess.title ?? undefined, createdAt: sess.time_created ?? null, cwd: sess.directory ?? undefined, turns }
  }

  return defineProvider({
    id: 'opencode',
    label: 'OpenCode',
    detect,
    dispatch,
    listSessions,
    readSession,
    exportSession,
  })
}
