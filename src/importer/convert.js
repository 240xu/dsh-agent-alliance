// src/importer/convert.js — 外部会话 → DSH 会话事件流（纯函数，不含 session 头）。
// 宿主 seed 契约（packages/core/session/src/index.ts）：
//   信封七键 type/seq/time/data/surfaceOp/sourceEventSeqs/ignorable；
//   seq === 数组下标（从 0 连续）；lossless JSON；surfaceManager 逐事件状态机校验。

import { randomUUID } from 'node:crypto'

export function convertToDshEvents({ createdAt = Date.now(), title, turns }) {
  const events = []
  let seq = 0
  const push = (time, type, data, extra) => {
    const ev = Object.assign({ type, seq: seq++, time, data }, extra || {})
    events.push(ev)
    return ev
  }
  const userMessageSeqs = []

  const list = Array.isArray(turns) ? turns : []
  for (let i = 0; i < list.length; i++) {
    const turn = i + 1
    const base = createdAt + i * 1000

    push(base, 'turn/start', { turn })
    push(base + 1, 'step/start', { turn, step: 1 })

    if (list[i].user !== undefined && list[i].user !== null) {
      const um = push(base + 2, 'user/message', {
        content: [{ type: 'text', text: String(list[i].user) }],
        source: { kind: 'user' },
        role: 'user',
        id: randomUUID(),
      }, { surfaceOp: 'append' })
      userMessageSeqs.push(um.seq)
    }

    const tools = Array.isArray(list[i].tools) ? list[i].tools : []
    for (const tl of tools) {
      const callId = 'call_' + randomUUID().replace(/-/g, '').slice(0, 24)
      const call = push(base + 3, 'tool/call', {
        turn, step: 1, callId,
        name: String(tl.name || 'unknown'),
        arguments: JSON.stringify(tl.args ?? {}),
      })
      push(base + 4, 'tool/result', {
        turn, step: 1,
        message: {
          source: { kind: 'tool', callId },
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            content: [{ type: 'text', text: String(tl.resultText ?? '') }],
            isError: !!tl.isError,
          }],
          role: 'user',
          id: randomUUID(),
        },
      }, { sourceEventSeqs: [call.seq], surfaceOp: 'append' })
    }

    push(base + 5, 'step/end', { turn, step: 1 })

    if (list[i].assistant !== undefined && list[i].assistant !== null) {
      push(base + 6, 'step/start', { turn, step: 2 })
      const text = String(list[i].assistant)
      push(base + 7, 'assistant/chunk', { turn, step: 2, chunk: { type: 'block-start', index: 0, blockType: 'text' } })
      push(base + 8, 'assistant/chunk', { turn, step: 2, chunk: { type: 'text-delta', index: 0, text } })
      push(base + 9, 'assistant/chunk', { turn, step: 2, chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } })
      push(base + 10, 'step/end', { turn, step: 2 })
    }

    push(base + 11, 'turn/end', { turn })
  }

  push(createdAt + list.length * 1000 + 12, 'session/title', {
    title: String(title || '导入会话'),
    messageSeqs: userMessageSeqs,
    source: { kind: 'fallback' },
  })
  return events
}
