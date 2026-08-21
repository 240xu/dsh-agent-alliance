// src/parse.js — 三家外部 CLI 输出解析。
// 原则：容错优先（行解析失败跳过），真实输出若有出入在 P1 Task 13 现场校验后只改这里+fixture。

function safeJson(line) {
  try { return JSON.parse(line) } catch { return undefined }
}

// claude -p --output-format stream-json：NDJSON。
// 最终 result 行带 .result 全文与 session_id；缺失时回退拼接 assistant 的 text 块。
export function parseClaudeStreamJson(text) {
  let sessionId
  const assistantText = []
  let resultText
  for (const line of String(text || '').split('\n')) {
    const obj = safeJson(line.trim())
    if (!obj) continue
    if (typeof obj.session_id === 'string' && !sessionId) sessionId = obj.session_id
    if (obj.type === 'result') {
      if (typeof obj.result === 'string') resultText = obj.result
      if (typeof obj.session_id === 'string') sessionId = obj.session_id
    } else if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
      for (const block of obj.message.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') assistantText.push(block.text)
      }
    }
  }
  return { text: (resultText ?? assistantText.join('')).trim(), sessionId }
}

// opencode run --format json：NDJSON 事件流。text part 形如 {type:'message',part:{type:'text',text}}；
// 会话 id 字段名可能是 sessionID/session_id/sessionId。非 JSON 行忽略。
export function parseOpencodeEvents(text) {
  let sessionId
  const parts = []
  for (const line of String(text || '').split('\n')) {
    const obj = safeJson(line.trim())
    if (!obj) continue
    const sid = obj.sessionID || obj.session_id || obj.sessionId
    if (typeof sid === 'string' && !sessionId) sessionId = sid
    const part = obj.part ?? obj
    if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return { text: parts.join('\n').trim(), sessionId }
}

// codex exec（人类可读输出）：session id 行正则提取；回答取最后一个分隔块，
// 剔除尾部 tokens used 等元信息行。无分隔块时回退全文。
export function parseCodexOutput(text) {
  const s = String(text || '')
  let sessionId
  const m = s.match(/session\s*id[:\s]+([0-9a-f][0-9a-f-]{20,})/i)
  if (m) sessionId = m[1]
  // codex 用 "--------" 分隔 header/指令/回答；取最后一段
  const blocks = s.split(/\n-{8,}\n/)
  let body = blocks.length >= 2 ? blocks[blocks.length - 1] : s
  body = body.replace(/^Codex\s*\n/, '')
  // 剔除尾部元信息（tokens used / 警告行）
  const metaIdx = body.search(/\ntokens used:/i)
  if (metaIdx >= 0) body = body.slice(0, metaIdx)
  return { text: body.trim(), sessionId }
}
