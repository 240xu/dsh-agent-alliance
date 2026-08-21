// src/provider/zcode.js — ZCode（z.ai ZCode ADE）Provider。
// 官方未公开 CLI 无头调用规范（CLI 内嵌桌面应用），因此 dispatch 走用户配置的
// commandTemplate 模板（经 sh -c 执行，{prompt}/{session}/{cwd} 变量展开，
// 单引号安全包裹）；默认 disabled。
// 会话存储按已交叉验证的 schema 只读查询：~/.zcode/cli/db/db.sqlite
// （session 表 id/directory/title?、message/part 表、compaction part 类型）。

import { spawnCli as defaultSpawnCli } from '../runner.js'
import { defineProvider } from './types.js'

function home() {
  return process.env.HOME || '/data/data/com.termux/files/home'
}

export function zcodeDefaultPaths() {
  return { dbPath: home() + '/.zcode/cli/db/db.sqlite' }
}

// 单引号安全：把 ' 替换为 '\''，再整体用单引号包裹
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

export function makeZcodeProvider({ deps = {}, config = {}, openDb } = {}) {
  const spawnCli = deps.spawnCli || defaultSpawnCli
  const paths = { ...zcodeDefaultPaths(), ...(deps.paths || {}) }
  const open = openDb || deps.openDb || null

  function expandTemplate(tpl, { prompt, resumeSessionId, cwd }) {
    return tpl
      .replaceAll('{prompt}', shellQuote(prompt))
      .replaceAll('{session}', resumeSessionId ? shellQuote(resumeSessionId) : '')
      .replaceAll('{cwd}', shellQuote(cwd || '.'))
  }

  async function detect() {
    if (config.enabled === false) {
      return { available: false, detail: 'zcode 未启用（config.providers.zcode.enabled=false）' }
    }
    if (!config.commandTemplate) {
      return { available: false, detail: 'zcode 未配置 commandTemplate（官方无公开无头规范，需手动填写）' }
    }
    // 有模板即视为可尝试；真实可用性取决于用户环境
    return { available: true, detail: 'template mode' }
  }

  async function dispatch({ prompt, cwd, resumeSessionId, model, timeoutMs = 300000, signal }) {
    if (config.enabled === false) {
      throw new Error('zcode 未启用：在 ~/.dsh/dsh-agent-alliance.json 设 providers.zcode.enabled=true')
    }
    if (!config.commandTemplate) {
      throw new Error('zcode 缺少 commandTemplate：官方 CLI 无公开无头规范，请在配置中填写命令模板（变量 {prompt} {session} {cwd}）')
    }
    const script = expandTemplate(config.commandTemplate, { prompt, resumeSessionId, cwd })
    const r = await spawnCli({ argv: ['sh', '-c', script], cwd, timeoutMs, signal })
    const text = String(r.stdout || '').trim()
    if (r.code !== 0 && !text) {
      throw new Error('zcode dispatch 失败 (exit ' + r.code + '): ' + (r.stderr || '').slice(-400))
    }
    return { text, externalSessionId: undefined, raw: r }
  }

  async function db() {
    if (open) return open()
    const { DatabaseSync } = await import('node:sqlite')
    return new DatabaseSync(paths.dbPath, { readOnly: true })
  }

  async function listSessions({ query, limit = 20 } = {}) {
    try {
      const d = await db()
      let rows
      try {
        rows = d.prepare('SELECT id, directory, title, time_created FROM session ORDER BY time_created DESC LIMIT ?').all(limit * 4)
      } catch {
        // title 列可能不存在（早期 schema）：回退最小列集
        rows = d.prepare('SELECT id, directory, time_created FROM session ORDER BY time_created DESC LIMIT ?').all(limit * 4)
      }
      let out = rows.map(r => ({
        id: r.id,
        title: r.title ?? undefined,
        cwd: r.directory ?? undefined,
        createdAt: r.time_created ?? null,
        messageCount: null,
      }))
      if (query) out = out.filter(s => (s.title || '').includes(query) || (s.cwd || '').includes(query) || s.id.includes(query))
      return out.slice(0, limit)
    } catch (err) {
      throw new Error('zcode listSessions 失败（未安装或 schema 变更）: ' + String(err?.message || err))
    }
  }

  async function readSession(id, { maxChars = 8000 } = {}) {
    const d = await db()
    const sess = d.prepare('SELECT id, title FROM session WHERE id = ?').get(id)
    if (!sess) throw new Error('zcode session not found: ' + id)
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
      // compaction part 类型是压缩摘要，跳过正文抽取
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

  // 完整导出（导入器用）；compaction part 跳过
  async function exportSession(id) {
    const d = await db()
    const sess = d.prepare('SELECT id, title, directory, time_created FROM session WHERE id = ?').get(id)
    if (!sess) throw new Error('zcode session not found: ' + id)
    const rows = d.prepare(
      `SELECT m.data AS mdata, p.data AS pdata
       FROM part p JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ? ORDER BY p.time_created ASC`
    ).all(id)
    const turns = []
    let cur = null
    for (const row of rows) {
      let pdata, mdata
      try { pdata = JSON.parse(row.pdata); mdata = JSON.parse(row.mdata || '{}') } catch { continue }
      if (pdata?.type === 'compaction') continue
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
    id: 'zcode',
    label: 'ZCode (z.ai)',
    detect,
    dispatch,
    listSessions,
    readSession,
    exportSession,
  })
}
