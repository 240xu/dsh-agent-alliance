// src/tools.js — 面向 DSH 模型的三个工具：agent_dispatch / agent_sessions / agent_session_read。
// 安全提示写进 description：真实消耗外部 agent 的 API 额度、可能在其 cwd 内改文件。
// 后台模式走 ctx.jobs（kind 'agent-alliance'），取消经自有 AbortController。

import { defineTool } from '@deepseek-ai/dsh-tools'

function labelOf(prompt) {
  const s = String(prompt || '').replace(/\s+/g, ' ').trim()
  return s.length > 60 ? s.slice(0, 60) + '…' : s
}

export function registerTools(ctx, { registry, config }) {
  const defaults = config?.defaults || {}
  const defaultTimeout = defaults.timeoutMs || 300000

  ctx.tools.register(defineTool({
    name: 'agent_dispatch',
    description: [
      '把一个任务无头派发给外部编码 agent（provider: claude | codex | opencode | zcode）当子代理，等待并取回其回答。',
      '注意：会真实消耗该 agent 的 API 额度，且它可能在目标目录内读写文件——重要操作先征得用户同意。',
      'background:true 时立即返回后台 job 句柄（用 job_output/job_kill 控制）；默认前台等待。',
      'resumeSessionId 可续聊该 agent 的既有会话（可用 agent_sessions 查询后传入）。',
    ].join('\n'),
    parameters: {
      provider: { type: 'string', required: true, description: '目标 agent：claude | codex | opencode | zcode' },
      prompt: { type: 'string', required: true, description: '派给它的任务描述' },
      cwd: { type: 'string', description: '工作目录（缺省用配置的 defaultCwd 或当前工作区）' },
      resumeSessionId: { type: 'string', description: '续聊的外部会话 id' },
      model: { type: 'string', description: '覆盖模型（可选）' },
      background: { type: 'boolean', description: 'true=后台运行返回 jobId；缺省前台等待' },
      timeoutMs: { type: 'number', description: '前台超时毫秒（默认 ' + defaultTimeout + '）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        if (value && value.kind === 'background') {
          return [{ type: 'text', text: 'started background job ' + value.jobId }]
        }
        if (value && typeof value.text === 'string') {
          const head = value.text.length > 4000 ? value.text.slice(0, 4000) + '\n…(截断)' : value.text
          return [{ type: 'text', text: '[' + value.provider + (value.externalSessionId ? ' 会话 ' + value.externalSessionId : '') + ']\n' + head }]
        }
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      const provider = registry.get(String(args.provider || '').trim())
      const signal = exec?.signal
      if (args.background === true) {
        let doneResolve, doneReject
        const done = new Promise((res, rej) => { doneResolve = res; doneReject = rej })
        const ac = new AbortController()
        const handle = ctx.jobs.start({
          kind: 'agent-alliance',
          label: args.provider + ': ' + labelOf(args.prompt),
          owner: exec?.agent,
          outputLimitBytes: 65536,
          run() {
            const t0 = Date.now()
            provider.dispatch({
              prompt: String(args.prompt),
              cwd: args.cwd || defaults.defaultCwd || undefined,
              resumeSessionId: args.resumeSessionId || undefined,
              model: args.model || undefined,
              timeoutMs: defaultTimeout,
              signal: ac.signal,
            }).then((out) => {
              doneResolve({ status: 'completed', output: '[' + args.provider + (out.externalSessionId ? ' 会话 ' + out.externalSessionId : '') + ' 用时 ' + (Date.now() - t0) + 'ms]\n' + out.text })
            }, (err) => {
              doneResolve({ status: 'failed', detail: String(err?.message || err).slice(-500) })
            })
            return {
              cancel(reason) { ac.abort(new Error(reason || 'cancelled')) },
              done,
            }
          },
        })
        return { kind: 'background', jobId: handle.id }
      }
      // 前台：与 exec.signal 耦合
      const t0 = Date.now()
      const out = await provider.dispatch({
        prompt: String(args.prompt),
        cwd: args.cwd || defaults.defaultCwd || undefined,
        resumeSessionId: args.resumeSessionId || undefined,
        model: args.model || undefined,
        timeoutMs: Math.min(Number(args.timeoutMs) || defaultTimeout, defaultTimeout * 4),
        signal,
      })
      return {
        provider: provider.id,
        text: out.text,
        externalSessionId: out.externalSessionId ?? null,
        durationMs: Date.now() - t0,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_sessions',
    description: '列出某外部 agent（claude|codex|opencode|zcode）本机的历史会话（标题/时间/工作目录），可搜索。用于找到要续聊或导入的会话 id。',
    parameters: {
      provider: { type: 'string', required: true, description: 'claude | codex | opencode | zcode' },
      query: { type: 'string', description: '按标题/目录/id 子串过滤' },
      limit: { type: 'number', description: '返回上限（默认 20）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const rows = (value.sessions || []).map(s =>
          '- [' + s.id + '] ' + (s.title || '(无标题)') + (s.cwd ? ' @' + s.cwd : '') + (s.createdAt ? ' ' + new Date(s.createdAt).toISOString().slice(0, 16) : '')
        )
        return [{ type: 'text', text: rows.join('\n') || '(无会话)' }]
      },
    },
    async execute(args) {
      const provider = registry.get(String(args.provider || '').trim())
      const sessions = await provider.listSessions({ query: args.query || undefined, limit: Number(args.limit) || 20 })
      return { sessions }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_session_read',
    description: '读取某外部 agent 历史会话的对话内容（截断到 maxChars），供继续追问前了解上下文。只读操作。',
    parameters: {
      provider: { type: 'string', required: true, description: 'claude | codex | opencode | zcode' },
      sessionId: { type: 'string', required: true, description: '外部会话 id（agent_sessions 返回的 id）' },
      maxChars: { type: 'number', description: '内容字符上限（默认 8000）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const lines = (value.messages || []).map(m => (m.role === 'user' ? '[user] ' : '[assistant] ') + m.text)
        return [{ type: 'text', text: lines.join('\n\n') || '(空会话)' }]
      },
    },
    async execute(args) {
      const provider = registry.get(String(args.provider || '').trim())
      return provider.readSession(String(args.sessionId), { maxChars: Number(args.maxChars) || 8000 })
    },
  }))
}
