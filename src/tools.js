// src/tools.js — 面向 DSH 模型的三个工具：agent_dispatch / agent_sessions / agent_session_read。
// 安全提示写进 description：真实消耗外部 agent 的 API 额度、可能在其 cwd 内改文件。
// 后台模式走 ctx.jobs（kind 'agent-alliance'），取消经自有 AbortController。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { runRoundtable, formatRoundtableText } from './roundtable.js'
import { loadLedger, importOne, sourceKey } from './importer/persist.js'

// 宿主要求工具输出为无损 JSON：剔除 undefined / 函数等非法值
function lossless(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

// 并发信号量：限制同时派发到外部 agent 的在飞数量（maxConcurrent）。
// 排队期间 signal 中止会立即以错误出队，不会占位死等。
function createSemaphore(limit) {
  let active = 0
  const queue = []
  return {
    run(signal, fn) {
      return new Promise((resolveRun, rejectRun) => {
        let started = false
        const entry = {
          begin() {
            if (started) return
            started = true
            if (signal && onAbort) signal.removeEventListener('abort', onAbort)
            // 同步启动 fn：若调用方在 run() 返回后立即 cancel，abort 必须能被 fn 看到
            let fp
            try { fp = Promise.resolve(fn()) } catch (err) { fp = Promise.reject(err) }
            fp.then(resolveRun, rejectRun).finally(() => {
              active--
              if (queue.length) queue.shift().begin()
            })
          },
        }
        function onAbort() {
          const i = queue.indexOf(entry)
          if (i >= 0) queue.splice(i, 1)
          if (signal) signal.removeEventListener('abort', onAbort)
          rejectRun(new Error('aborted while queued (maxConcurrent=' + limit + ')'))
        }
        entry.onAbort = onAbort
        if (active < limit) { active++; entry.begin(); return }
        queue.push(entry)
        if (signal) {
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
      })
    },
  }
}

function labelOf(prompt) {
  const s = String(prompt || '').replace(/\s+/g, ' ').trim()
  return s.length > 60 ? s.slice(0, 60) + '…' : s
}

export function registerTools(ctx, { registry, config, home }) {
  const defaults = config?.defaults || {}
  const defaultTimeout = defaults.timeoutMs || 300000
  const sem = createSemaphore(Math.max(1, Number(defaults.maxConcurrent) || 3))

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
    presentCall(args) {
      const label = labelOf(args.prompt)
      if (args.background === true) {
        return {
          card: 'generic',
          title: args.provider + ': ' + label,
          kind: 'execute',
          rawInput: String(args.prompt || ''),
          content: [{ type: 'text', text: '后台派发给 ' + args.provider + '，用 job_output 取结果' }],
        }
      }
      return {
        card: 'terminal',
        title: args.provider + ': ' + label,
        description: '外部 agent 子代理派发' + (args.resumeSessionId ? '（续聊 ' + args.resumeSessionId + '）' : ''),
        ...(args.cwd ? { cwd: args.cwd } : {}),
      }
    },
    presentResult(args, result) {
      const block = result.content.length === 1 ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      return {
        card: 'terminal',
        output: block.text,
        ...(result.isError ? {} : { exitCode: 0 }),
      }
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
            sem.run(ac.signal, () => provider.dispatch({
              prompt: String(args.prompt),
              cwd: args.cwd || defaults.defaultCwd || undefined,
              resumeSessionId: args.resumeSessionId || undefined,
              model: args.model || undefined,
              timeoutMs: defaultTimeout,
              signal: ac.signal,
            })).then((out) => {
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
      // 前台：与 exec.signal 耦合；排队等待同样可被取消
      const t0 = Date.now()
      const out = await sem.run(signal, () => provider.dispatch({
        prompt: String(args.prompt),
        cwd: args.cwd || defaults.defaultCwd || undefined,
        resumeSessionId: args.resumeSessionId || undefined,
        model: args.model || undefined,
        timeoutMs: Math.min(Number(args.timeoutMs) || defaultTimeout, defaultTimeout * 4),
        signal,
      }))
      return lossless({
        provider: provider.id,
        text: out.text,
        externalSessionId: out.externalSessionId ?? null,
        durationMs: Date.now() - t0,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_roundtable',
    description: [
      '圆桌讨论：把同一问题并发派发给多个外部 agent（claude/codex/opencode/zcode），收集各自观点后输出对比文本（综合分析由你完成）。',
      '注意：会真实消耗各家 API 额度，各家可能在其 cwd 内读写文件——重要操作先征得用户同意。',
      '默认后台运行返回 jobId；providers 缺省为全部已配置成员。',
    ].join('\n'),
    parameters: {
      prompt: { type: 'string', required: true, description: '发给所有参与 agent 的同一问题' },
      providers: { type: 'array', description: '参与的 provider id 列表（缺省全部）', items: { type: 'string' } },
      cwd: { type: 'string', description: '工作目录' },
      background: { type: 'boolean', description: '默认 true；false 时前台等待全部返回' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        if (value && value.kind === 'background') {
          return [{ type: 'text', text: 'started background job ' + value.jobId }]
        }
        if (value && typeof value.text === 'string') return [{ type: 'text', text: value.text }]
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: 'roundtable: ' + labelOf(args.prompt),
        kind: 'execute',
        rawInput: String(args.prompt || ''),
        content: [{ type: 'text', text: '并发派发给全部可用 agent，完成后输出对比文本' }],
      }
    },
    async execute(args, exec) {
      const signal = exec?.signal
      if (args.background !== false) {
        let doneResolve
        const done = new Promise((res) => { doneResolve = res })
        const ac = new AbortController()
        const handle = ctx.jobs.start({
          kind: 'agent-alliance',
          label: 'roundtable: ' + labelOf(args.prompt),
          owner: exec?.agent,
          outputLimitBytes: 262144,
          run() {
            runRoundtable({
              registry, prompt: String(args.prompt),
              providerIds: Array.isArray(args.providers) ? args.providers.map(String) : undefined,
              cwd: args.cwd || defaults.defaultCwd || undefined,
              timeoutMs: defaultTimeout * 2,
              signal: ac.signal,
            }).then((r) => {
              doneResolve({ status: 'completed', output: formatRoundtableText(r) })
            }, (err) => {
              doneResolve({ status: 'failed', detail: String(err?.message || err).slice(-500) })
            })
            return { cancel(reason) { ac.abort(new Error(reason || 'cancelled')) }, done }
          },
        })
        return { kind: 'background', jobId: handle.id }
      }
      const r = await runRoundtable({
        registry, prompt: String(args.prompt),
        providerIds: Array.isArray(args.providers) ? args.providers.map(String) : undefined,
        cwd: args.cwd || defaults.defaultCwd || undefined,
        timeoutMs: defaultTimeout * 2,
        signal,
      })
      return lossless({ text: formatRoundtableText(r), rounds: r.rounds })
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
      return lossless({ sessions })
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
      return lossless(await provider.readSession(String(args.sessionId), { maxChars: Number(args.maxChars) || 8000 }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_import_scan',
    description: '只读扫描本插件支持的外部 agent（claude/codex/opencode/zcode）本地历史会话，返回可导入清单与导入状态。不写任何数据。',
    parameters: {
      provider: { type: 'string', description: '只扫指定 provider；缺省扫全部' },
      query: { type: 'string', description: '按标题/目录/id 子串过滤' },
      limit: { type: 'number', description: '每家返回上限（默认 20）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const rows = (value.sessions || []).map(s =>
          '- [' + s.provider + '/' + s.id + '] ' + (s.title || '(无标题)') + (s.imported ? ' ✅已导入' : '') + (s.cwd ? ' @' + s.cwd : '')
        )
        return [{ type: 'text', text: (rows.join('\n') || '(无会话)') + '\n共 ' + value.total + ' 条' }]
      },
    },
    async execute(args) {
      const ledger = loadLedger(home)
      const wanted = args.provider ? [String(args.provider)] : registry.list().map(p => p.id)
      const sessions = []
      for (const id of wanted) {
        try {
          const p = registry.get(id)
          const list = await p.listSessions({ query: args.query || undefined, limit: Number(args.limit) || 20 })
          for (const s of list) {
            sessions.push({
              provider: id,
              id: String(s.id),
              title: s.title ?? null,
              cwd: s.cwd ?? null,
              createdAt: s.createdAt ?? null,
              imported: !!ledger[sourceKey(id, String(s.id))]?.dshSessionId,
            })
          }
        } catch { /* 单家失败不影响整体 */ }
      }
      return lossless({ total: sessions.length, sessions })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_import',
    description: '把一个外部 agent 历史会话导入为可继续的 DSH 会话（事件级还原，幂等：重复导入跳过）。先用 agent_import_scan 找 sessionId。',
    parameters: {
      provider: { type: 'string', required: true, description: 'claude | codex | opencode | zcode' },
      sessionId: { type: 'string', required: true, description: '外部会话 id' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        if (value.status === 'imported') return [{ type: 'text', text: '已导入为 DSH 会话 ' + value.dshSessionId + '（' + value.turns + ' 轮）' }]
        if (value.status === 'already-imported') return [{ type: 'text', text: '已导入过：' + value.dshSessionId + '（幂等跳过）' }]
        if (value.status === 'skipped') return [{ type: 'text', text: '跳过：' + (value.reason || '') }]
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: '导入 ' + args.provider + '/' + args.sessionId,
        kind: 'execute',
        rawInput: JSON.stringify(args),
        content: [{ type: 'text', text: '把外部会话事件级还原为 DSH 会话（幂等）' }],
      }
    },
    async execute(args) {
      const r = await importOne(ctx, {
        registry,
        provider: String(args.provider),
        externalId: String(args.sessionId),
        home,
      })
      return lossless(r)
    },
  }))
}
