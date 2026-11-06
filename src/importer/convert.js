// src/importer/convert.js — 外部会话 → DSH v4 会话事件流（纯函数，不含 session 头）。
// v4 信封只允许 type/seq/time/data/surfaceOp/sourceEventSeqs/ignorable；
// seq 等于数组下标（从 0 连续）；全部数据必须是 lossless JSON。
//
// 规范来源 docs/SPEC-v2.md「Importer (current session format)」，另按宿主 v4 校验器收紧三处：
//   1. tool/result 的 message 是一等 tool 角色消息：isError 在消息上，content 里只有
//      {type:'text'} 块，不能再包 v3 的 tool-result 外壳（assertV4ToolResultMessage 拒绝）。
//   2. tool/call 之前必须有一条 assistant/message 用 {type:'tool-call'} 块广告同一次调用，
//      且 tool/call 的 name/arguments 必须与广告逐字节一致，否则会话读回时报
//      "no advertised tool lifecycle"（assertReleasedV4Relationships）。
//   3. stream 里 text-chunks 的 dt 长度必须是 texts.length - 1，单片段即 dt: []。

/** @param {number} value @returns {boolean} */
function isTime(value) {
  return Number.isSafeInteger(value) && value >= 0
}

/** 把工具入参序列化成与上层完全一致的原始 JSON 字符串。 */
function argumentsText(value) {
  if (value === undefined) return '{}'
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    return 'null'
  }
  return text === undefined ? 'null' : text
}

/**
 * 把一个 provider 导出的会话转换成 v4 SessionEvent 数组。
 * @param {object} input
 * @param {string} [input.id] 目标 DSH 会话 id（消息 id 由它派生，保证确定性）
 * @param {string} [input.cwd] 只写进 session 头，不参与事件
 * @param {number} [input.createdAt] 会话创建时间（Unix 毫秒）
 * @param {string} [input.title] 会话标题
 * @param {Array<{user?: string, assistant?: string, tools?: Array<{name?: string, args?: unknown, resultText?: string, isError?: boolean}>}>} [input.turns] 外部轮次
 * @returns {Array<object>} 事件流：seq 从 0 起连续，session/title 恒为最后一条
 */
export function convertToDshEvents({ id, createdAt, title, turns } = {}) {
  const sessionKey = typeof id === 'string' && id.length > 0 ? id : 'import'
  const events = []
  let clock = isTime(createdAt) ? createdAt : Date.now()

  const push = (type, data, extra) => {
    const event = { type, seq: events.length, time: clock, data }
    clock += 1
    if (extra !== undefined) Object.assign(event, extra)
    events.push(event)
    return event
  }

  const userMessageSeqs = []
  const list = Array.isArray(turns) ? turns : []

  for (let index = 0; index < list.length; index += 1) {
    const turn = index + 1
    const source = list[index] ?? {}
    const tools = Array.isArray(source.tools) ? source.tools : []
    const userText = source.user === undefined || source.user === null ? '' : String(source.user)
    const assistantText = source.assistant === undefined || source.assistant === null
      ? ''
      : String(source.assistant)

    push('turn/start', { turn })
    push('step/start', { turn, step: 1 })

    if (userText !== '') {
      const message = push('user/message', {
        id: sessionKey + ':u' + turn,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: userText }],
      }, { surfaceOp: 'append' })
      userMessageSeqs.push(message.seq)
    }

    // 一次 assistant/message 同时承载工具调用广告与可见文本：工具调用必须先于 tool/call。
    if (tools.length > 0 || assistantText !== '') {
      const content = []
      const stream = []
      for (let toolIndex = 0; toolIndex < tools.length; toolIndex += 1) {
        const tool = tools[toolIndex] ?? {}
        const callId = 'call_' + turn + '_' + toolIndex
        const name = typeof tool.name === 'string' && tool.name.length > 0 ? tool.name : 'unknown'
        const args = argumentsText(tool.args)
        content.push({ type: 'tool-call', id: callId, name, arguments: args })
        stream.push({
          type: 'tool-call-chunks',
          time0: clock,
          index: toolIndex,
          dt: [],
          id: callId,
          name,
          args: [args],
        })
      }
      if (assistantText !== '') {
        content.push({ type: 'text', text: assistantText })
        stream.push({
          type: 'text-chunks',
          time0: clock,
          index: tools.length,
          dt: [],
          texts: [assistantText],
        })
      }
      push('assistant/message', {
        turn,
        step: 1,
        message: {
          id: sessionKey + ':a' + turn,
          role: 'assistant',
          source: { kind: 'model', provider: 'agent-alliance-import', model: 'external-session' },
          content,
        },
        stream,
      }, { surfaceOp: 'append' })
    }

    for (let toolIndex = 0; toolIndex < tools.length; toolIndex += 1) {
      const tool = tools[toolIndex] ?? {}
      const callId = 'call_' + turn + '_' + toolIndex
      const name = typeof tool.name === 'string' && tool.name.length > 0 ? tool.name : 'unknown'
      const args = argumentsText(tool.args)
      const call = push('tool/call', {
        turn,
        step: 1,
        callId,
        name,
        arguments: args,
      })
      push('tool/result', {
        turn,
        step: 1,
        message: {
          id: sessionKey + ':t' + turn + '_' + toolIndex,
          role: 'tool',
          source: { kind: 'tool', callId },
          toolCallId: callId,
          content: [{
            type: 'text',
            text: tool.resultText === undefined || tool.resultText === null ? '' : String(tool.resultText),
          }],
          isError: tool.isError === true,
        },
      }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    }

    push('step/end', { turn, step: 1 })
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }

  push('session/title', {
    title: typeof title === 'string' && title.trim().length > 0 ? title : '导入会话',
    messageSeqs: userMessageSeqs,
    source: { kind: 'fallback' },
  })

  return events
}
