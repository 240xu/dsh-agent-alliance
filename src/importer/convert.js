// src/importer/convert.js — 外部会话 → DSH 会话事件流（纯函数，不含 session 头）。
// 事件形状严格对齐宿主落盘契约（2026-08-21 从真实 session.jsonl.zstd 采样固化）：
//   turn/start{turn} / step/start{turn,step} / user/message{content,source,role,id}+surfaceOp
//   assistant/chunk{turn,step,chunk:{block-start|text-delta|block-end}}
//   tool/call{callId,name,arguments} / tool/result{message{source.callId,content[tool-result]}}+sourceEventSeqs
//   step/end / turn/end / session/title{title,messageSeqs,source}

import { randomUUID } from 'node:crypto'

export function convertToDshEvents({ id, cwd, createdAt = Date.now(), title, turns }) {
  // 注意：seed 里不含 session 头——宿主 agents.create/sessionPersistence 从 meta 自己写头，
  // 且信封白名单只允许 type/seq/time/data/surfaceOp/sourceEventSeqs/ignorable 七键。
  const events = []
  void id
  let seq = 0
  const next = (time) => ({ seq: ++seq, time })
  const userMessageIds = []

  const list = Array.isArray(turns) ? turns : []
  for (let i = 0; i < list.length; i++) {
    const turn = i + 1
    const base = createdAt + i * 1000

    events.push({ ...next(base), type: 'turn/start', data: { turn } })

    // --- 用户侧 step ---
    events.push({ ...next(base + 1), type: 'step/start', data: { turn, step: 1 } })
    if (list[i].user !== undefined && list[i].user !== null) {
      const umId = randomUUID()
      userMessageIds.push(seq + 1)
      events.push({
        ...next(base + 2),
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: String(list[i].user) }],
          source: { kind: 'user' },
          role: 'user',
          id: umId,
        },
        surfaceOp: 'append',
      })
    }

    // --- 工具调用（属于用户侧 step，与宿主一致：tool 事件带 turn/step） ---
    const tools = Array.isArray(list[i].tools) ? list[i].tools : []
    for (const t of tools) {
      const callSeq = seq + 1
      const callId = 'call_' + randomUUID().replace(/-/g, '').slice(0, 24)
      events.push({
        ...next(base + 3),
        type: 'tool/call',
        data: { turn, step: 1, callId, name: String(t.name || 'unknown'), arguments: JSON.stringify(t.args ?? {}) },
      })
      events.push({
        ...next(base + 4),
        type: 'tool/result',
        data: {
          turn,
          step: 1,
          message: {
            source: { kind: 'tool', callId },
            content: [{
              type: 'tool-result',
              toolCallId: callId,
              content: [{ type: 'text', text: String(t.resultText ?? '') }],
              isError: !!t.isError,
            }],
            role: 'user',
            id: randomUUID(),
          },
        },
        sourceEventSeqs: [callSeq],
        surfaceOp: 'append',
      })
    }
    events.push({ ...next(base + 5), type: 'step/end', data: { turn, step: 1 } })

    // --- 助手侧 step ---
    if (list[i].assistant !== undefined && list[i].assistant !== null) {
      events.push({ ...next(base + 6), type: 'step/start', data: { turn, step: 2 } })
      const text = String(list[i].assistant)
      events.push({
        ...next(base + 7), type: 'assistant/chunk',
        data: { turn, step: 2, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      })
      events.push({
        ...next(base + 8), type: 'assistant/chunk',
        data: { turn, step: 2, chunk: { type: 'text-delta', index: 0, text } },
      })
      events.push({
        ...next(base + 9), type: 'assistant/chunk',
        data: { turn, step: 2, chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } },
      })
      events.push({ ...next(base + 10), type: 'step/end', data: { turn, step: 2 } })
    }

    events.push({ ...next(base + 11), type: 'turn/end', data: { turn } })
  }

  events.push({
    ...next(createdAt + list.length * 1000 + 12),
    type: 'session/title',
    data: { title: String(title || '导入会话'), messageSeqs: userMessageIds, source: { kind: 'fallback' } },
  })
  return events
}
