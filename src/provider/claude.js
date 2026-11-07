// src/provider/claude.js — Claude Code Provider。
// 本机形态：glibc 原生二进制，必须经 grun（glibc-runner）启动。
// dispatch: grun <bin> -p <prompt> --output-format stream-json [--resume id] [--model m]
// 会话存储：~/.claude/projects/<cwd-slug>/<uuid>.jsonl

import { readdirSync, readFileSync, statSync } from 'node:fs'

function require_stat(p) { const s = statSync(p); if (!s.isFile()) throw new Error('not file'); return s }
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawnCli as defaultSpawnCli } from '../runner.js'
import { parseClaudeStreamJson } from '../parse.js'
import { defineProvider as defineProviderShim } from './types.js'

function prefix() {
  return process.env.PREFIX || '/data/data/com.termux/files/usr'
}

export function claudeDefaultPaths() {
  return {
    grun: prefix() + '/bin/grun',
    claudeBin: prefix() + '/lib/node_modules/@anthropic-ai/claude-code-linux-arm64/claude',
    projectsRoot: join(homedir(), '.claude', 'projects'),
  }
}

export function makeClaudeProvider({ deps = {}, config = {} } = {}) {
  const spawnCli = deps.spawnCli || defaultSpawnCli
  const paths = { ...claudeDefaultPaths(), ...(deps.paths || {}) }

  async function detect() {
    try {
      const r = await spawnCli({ argv: [paths.grun, paths.claudeBin, '--version'], timeoutMs: 15000 })
      if (r.code !== 0) return { available: false, detail: (r.stderr || r.stdout).slice(-200) }
      return { available: true, version: r.stdout.trim().split('\n')[0] }
    } catch (err) {
      return { available: false, detail: String(err?.message || err) }
    }
  }

  async function dispatch({ prompt, cwd, resumeSessionId, model, timeoutMs = 300000, signal }) {
    const argv = [paths.grun, paths.claudeBin, '-p', String(prompt), '--output-format', 'stream-json', '--verbose']
    if (resumeSessionId) argv.push('--resume', String(resumeSessionId))
    const effModel = model || config.defaultModel || null
    if (effModel) argv.push('--model', String(effModel))
    // Termux 无 /tmp，grun 二进制会写 /tmp/claude-*：强制 TMPDIR 归一
    const r = await spawnCli({ argv, cwd, timeoutMs, signal, env: { TMPDIR: prefix() + '/tmp' } })
    // Non-zero exit wins over printed text. stream-json collects any assistant
    // text block, including one whose content is "API Error: 429", so a failed
    // run would otherwise resolve as a successful answer.
    if (r.code !== 0) {
      throw new Error('claude dispatch 失败 (exit ' + r.code + '): ' + (r.stderr || r.stdout).slice(-400))
    }
    const parsed = parseClaudeStreamJson(r.stdout)
    return { text: parsed.text, externalSessionId: parsed.sessionId, raw: r }
  }

  // --- 会话浏览 ------------------------------------------------------------
  // 每行一个 JSON；标题优先取 summary 行，否则首条 user 文本。只读文件头部，
  // 避免大文件全量读取。

  function extractTitle(lineObjs) {
    for (const o of lineObjs) {
      if (o.type === 'summary' && typeof o.summary === 'string') return o.summary
    }
    for (const o of lineObjs) {
      if (o.type === 'user') {
        const c = o.message?.content
        let text
        if (typeof c === 'string') text = c
        else if (Array.isArray(c)) {
          const t = c.find(b => b?.type === 'text' && b.text)
          if (t) text = t.text
        }
        // 跳过注入类内容（<local-command-caveat>、<system-reminder> 等尖括号开头）
        if (text && !text.trimStart().startsWith('<')) return text.slice(0, 120)
      }
    }
    return undefined
  }

  function headLines(file, bytes = 32768) {
    let buf
    try { buf = readFileSync(file) } catch { return [] }
    const head = buf.subarray(0, bytes).toString('utf8')
    return head.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  }

  async function listSessions({ query, limit = 20 } = {}) {
    const out = []
    let projects
    try { projects = readdirSync(paths.projectsRoot, { withFileTypes: true }) } catch { return [] }
    for (const proj of projects) {
      if (!proj.isDirectory()) continue
      let files
      try { files = readdirSync(join(paths.projectsRoot, proj.name)) } catch { continue }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue
        const id = f.replace(/\.jsonl$/, '')
        const lines = headLines(join(paths.projectsRoot, proj.name, f))
        const title = extractTitle(lines)
        const firstTs = lines.find(o => typeof o.timestamp === 'string')?.timestamp
        out.push({
          id,
          title,
          cwd: proj.name,
          createdAt: firstTs ? Date.parse(firstTs) : null,
          messageCount: null,
        })
      }
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    const filtered = query
      ? out.filter(s => (s.title || '').includes(query) || (s.cwd || '').includes(query) || s.id.includes(query))
      : out
    return filtered.slice(0, limit)
  }

  async function readSession(id, { maxChars = 8000 } = {}) {
    let projects
    try { projects = readdirSync(paths.projectsRoot, { withFileTypes: true }) } catch { return { messages: [] } }
    for (const proj of projects) {
      if (!proj.isDirectory()) continue
      const file = join(paths.projectsRoot, proj.name, id + '.jsonl')
      let raw
      try { raw = readFileSync(file, 'utf8') } catch { continue }
      const messages = []
      for (const line of raw.split('\n')) {
        let o
        try { o = JSON.parse(line) } catch { continue }
        if (o.type === 'summary' && !messages.length) continue
        if (o.type !== 'user' && o.type !== 'assistant') continue
        const c = o.message?.content
        let text = ''
        if (typeof c === 'string') text = c
        else if (Array.isArray(c)) {
          text = c.filter(b => b?.type === 'text' && b.text).map(b => b.text).join('\n')
        }
        if (!text.trim()) continue
        messages.push({ role: o.type, text })
      }
      if (messages.length) {
        let total = 0
        const capped = []
        for (const m of messages) {
          if (total >= maxChars) break
          const t = m.text.slice(0, maxChars - total)
          capped.push({ role: m.role, text: t })
          total += t.length
        }
        return { title: extractTitle(headLines(file)), messages: capped }
      }
    }
    throw new Error('claude session not found: ' + id)
  }

  // 完整导出（导入器用）：规范化 turns，含工具配对；不截断。
  async function exportSession(id) {
    let projects
    try { projects = readdirSync(paths.projectsRoot, { withFileTypes: true }) } catch { throw new Error('claude projects 根不可读') }
    let file = null
    for (const proj of projects) {
      if (!proj.isDirectory()) continue
      const cand = join(paths.projectsRoot, proj.name, id + '.jsonl')
      try { if (require_stat(cand)) { file = cand; break } } catch { /* keep scanning */ }
    }
    if (!file) throw new Error('claude session not found: ' + id)
    const raw = readFileSync(file, 'utf8')
    const objs = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

    let title
    let createdAt = null
    const turns = []
    let cur = null
    const pendingTools = new Map() // tool_use_id -> tool entry（跨 assistant 行配对）

    function ensureTurn() {
      if (!cur) { cur = { user: undefined, assistant: undefined, tools: [] }; turns.push(cur) }
      return cur
    }

    for (const o of objs) {
      if (o.type === 'summary' && typeof o.summary === 'string' && !title) { title = o.summary; continue }
      if (typeof o.timestamp === 'string' && !createdAt) createdAt = Date.parse(o.timestamp)
      // sidechain 行是子代理内部轨迹，导入主会话时视为噪声跳过
      if (o.isSidechain === true) continue
      if (o.type === 'user') {
        const content = o.message?.content
        const items = Array.isArray(content) ? content : [{ type: 'text', text: typeof content === 'string' ? content : '' }]
        // tool_result 行：挂到对应工具，不开新轮
        const trItems = items.filter(b => b?.type === 'tool_result')
        if (trItems.length) {
          for (const tr of trItems) {
            const tool = pendingTools.get(tr.tool_use_id)
            const text = typeof tr.content === 'string' ? tr.content
              : Array.isArray(tr.content) ? tr.content.filter(x => x?.type === 'text').map(x => x.text).join('\n') : ''
            if (tool) { tool.resultText = text; tool.isError = !!tr.is_error; pendingTools.delete(tr.tool_use_id) }
          }
          continue
        }
        const texts = items.filter(b => b?.type === 'text' && b.text && !b.text.trimStart().startsWith('<'))
        if (!texts.length) continue
        cur = null // 新用户文本开新轮
        ensureTurn().user = texts.map(b => b.text).join('\n')
        continue
      }
      if (o.type === 'assistant') {
        const content = o.message?.content
        if (!Array.isArray(content)) continue
        const t = ensureTurn()
        for (const b of content) {
          if (b?.type === 'text' && b.text) {
            t.assistant = (t.assistant ? t.assistant + '\n' : '') + b.text
          } else if (b?.type === 'tool_use' && b.id) {
            const entry = { name: String(b.name || 'unknown'), args: b.input ?? {}, resultText: '', isError: false }
            t.tools.push(entry)
            pendingTools.set(b.id, entry)
          }
          // thinking 块跳过（DSH 侧以 reasoning delta 呈现，导入 v1 不还原）
        }
      }
    }
    return { title, createdAt, cwd: undefined, turns }
  }

  return defineProviderShim({
    id: 'claude',
    label: 'Claude Code',
    detect,
    dispatch,
    listSessions,
    readSession,
    exportSession,
  })
}