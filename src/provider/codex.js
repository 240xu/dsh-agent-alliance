// src/provider/codex.js — Codex CLI Provider。
// 本机形态：node 入口脚本（usr/bin/codex 符号链接在部分环境下解析失败），
// 因此用绝对 node + codex.js 调用。
// dispatch: node <codex.js> exec [--skip-git-repo-check] [-C cwd] [-m model] <prompt>
// resume:   node <codex.js> exec resume <id|last> [-C cwd] <prompt>
// 会话存储：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawnCli as defaultSpawnCli } from '../runner.js'
import { parseCodexOutput } from '../parse.js'
import { defineProvider } from './types.js'

function prefix() {
  return process.env.PREFIX || '/data/data/com.termux/files/usr'
}

export function codexDefaultPaths() {
  return {
    codexJs: prefix() + '/lib/node_modules/@openai/codex/bin/codex.js',
    sessionsRoot: join(homedir(), '.codex', 'sessions'),
  }
}

export function makeCodexProvider({ deps = {}, config = {} } = {}) {
  const spawnCli = deps.spawnCli || defaultSpawnCli
  const paths = { ...codexDefaultPaths(), ...(deps.paths || {}) }

  async function detect() {
    try {
      const r = await spawnCli({ argv: [process.execPath, paths.codexJs, '--version'], timeoutMs: 20000 })
      if (r.code !== 0) return { available: false, detail: (r.stderr || r.stdout).slice(-200) }
      const m = r.stdout.match(/codex-cli\s+(\S+)/i)
      return { available: true, version: m ? m[1] : r.stdout.trim().split('\n')[0] }
    } catch (err) {
      return { available: false, detail: String(err?.message || err) }
    }
  }

  async function dispatch({ prompt, cwd, resumeSessionId, model, timeoutMs = 300000, signal }) {
    const base = [process.execPath, paths.codexJs, 'exec', '--skip-git-repo-check']
    if (cwd) base.push('-C', String(cwd))
    if (model) base.push('-m', String(model))
    let argv
    if (resumeSessionId) {
      argv = [...base, 'resume', String(resumeSessionId), String(prompt)]
    } else {
      argv = [...base, String(prompt)]
    }
    const r = await spawnCli({ argv, timeoutMs, signal })
    const parsed = parseCodexOutput(r.stdout)
    if (r.code !== 0 && !parsed.text) {
      throw new Error('codex dispatch 失败 (exit ' + r.code + '): ' + (r.stderr || r.stdout).slice(-400))
    }
    return { text: parsed.text, externalSessionId: parsed.sessionId, raw: r }
  }

  // --- 会话浏览：rollout-*.jsonl -------------------------------------------
  // session_meta 行带 id/cwd；首条 user message 作标题。只读头部。

  function* rolloutFiles(root) {
    let stack = [root]
    while (stack.length) {
      const dir = stack.pop()
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        const full = join(dir, e.name)
        if (e.isDirectory()) stack.push(full)
        else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) yield full
      }
    }
  }

  function headObjs(file, bytes = 65536) {
    try {
      const head = readFileSync(file).subarray(0, bytes).toString('utf8')
      return head.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } catch { return [] }
  }

  function metaOf(objs) {
    for (const o of objs) {
      if (o.type === 'session_meta') {
        const p = o.payload || {}
        return { id: p.id || o.id, cwd: p.cwd, timestamp: p.timestamp }
      }
    }
    return {}
  }

  function firstUserText(objs) {
    for (const o of objs) {
      const p = o.payload || {}
      if ((o.type === 'response_item' || p.type === 'message') && p.role === 'user' && Array.isArray(p.content)) {
        const t = p.content.find(b => b?.type === 'input_text' && b.text)
        // 跳过注入类首条（<environment_context>、<skills_instructions> 等尖括号开头）
        if (t && !t.text.trimStart().startsWith('<')) return t.text.slice(0, 120)
      }
    }
    return undefined
  }

  async function listSessions({ query, limit = 20 } = {}) {
    const out = []
    for (const file of rolloutFiles(paths.sessionsRoot)) {
      const objs = headObjs(file)
      const meta = metaOf(objs)
      out.push({
        id: meta.id || file,
        title: firstUserText(objs),
        cwd: meta.cwd,
        createdAt: meta.timestamp ? Date.parse(meta.timestamp) : null,
        messageCount: null,
        sourcePath: file,
      })
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    const filtered = query
      ? out.filter(s => (s.title || '').includes(query) || (s.cwd || '').includes(query) || String(s.id).includes(query))
      : out
    return filtered.slice(0, limit)
  }

  async function readSession(id, { maxChars = 8000 } = {}) {
    for (const file of rolloutFiles(paths.sessionsRoot)) {
      const objs = headObjs(file)
      if (metaOf(objs).id !== id) continue
      let raw
      try { raw = readFileSync(file, 'utf8') } catch { break }
      const messages = []
      for (const line of raw.split('\n')) {
        let o
        try { o = JSON.parse(line) } catch { continue }
        const p = o.payload || {}
        if ((o.type === 'response_item') && p.type === 'message' && Array.isArray(p.content)) {
          const text = p.content.filter(b => typeof b?.text === 'string').map(b => b.text).join('\n')
          if (text.trim()) messages.push({ role: p.role === 'assistant' ? 'assistant' : 'user', text })
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
      return { title: firstUserText(objs), messages: capped }
    }
    throw new Error('codex session not found: ' + id)
  }

  // 完整导出（导入器用）
  async function exportSession(id) {
    for (const file of rolloutFiles(paths.sessionsRoot)) {
      const objs = headObjs(file)
      if (metaOf(objs).id !== id) continue
      let raw
      try { raw = readFileSync(file, 'utf8') } catch { break }
      const all = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      let createdAt = null
      const meta = metaOf(all)
      if (meta.timestamp) createdAt = Date.parse(meta.timestamp)
      const turns = []
      let cur = null
      for (const o of all) {
        const p = o.payload || {}
        if (o.type !== 'response_item' || p.type !== 'message') continue
        const text = Array.isArray(p.content)
          ? p.content.filter(b => typeof b?.text === 'string').map(b => b.text).join('\n')
          : ''
        if (!text.trim()) continue
        if (p.role === 'user') {
          if (text.trimStart().startsWith('<')) continue // 注入跳过
          cur = { user: text, assistant: undefined, tools: [] }
          turns.push(cur)
        } else if (p.role === 'assistant') {
          if (!cur) { cur = { user: '(无前导用户消息)', assistant: undefined, tools: [] }; turns.push(cur) }
          cur.assistant = (cur.assistant ? cur.assistant + '\n' : '') + text
        }
      }
      return { title: firstUserText(all), createdAt, cwd: meta.cwd, turns }
    }
    throw new Error('codex session not found: ' + id)
  }

  return defineProvider({
    id: 'codex',
    label: 'Codex CLI',
    detect,
    dispatch,
    listSessions,
    readSession,
    exportSession,
  })
}
