// src/http.js — 面板数据端点（webServer 可选注册）。
// GET  /__agent-alliance/state    provider 探测 + 概要
// GET  /__agent-alliance/sessions?provider=&query=&limit=
// GET  /__agent-alliance/jobs     最近派发记录（进程内）
// POST /__agent-alliance/dispatch {provider,prompt,cwd?,resumeSessionId?,model?}（前台等待）

import { loadLedger, sourceKey } from './importer/persist.js'
import { importOne } from './importer/persist.js'
import { runRoundtable, formatRoundtableText } from './roundtable.js'

export function registerHttp(host, { registry, config, home, ctx, getAgents, startJob }) {
  const batches = new Map() // batchId -> { kind:'broadcast'|'roundtable', label, startedAt, done, output }
  let batchSeq = 0
  function newBatch(kind, label) {
    const id = 'batch-' + (++batchSeq)
    const b = { id, kind, label, startedAt: Date.now(), done: false, output: '' }
    batches.set(id, b)
    return b
  }
  // getAgents（可选，测试注入）：返回宿主 agents 服务；缺省走 ctx 之外无法拿到——
  // 生产路径由 index.js 闭包提供 ctx.get('agents')。
  const recent = []

  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (d) => { data += d; if (data.length > 1e6) req.destroy() })
      req.on('end', () => resolve(data))
      req.on('error', reject)
    })
  }

  host.register({
    kind: 'exact',
    path: '/__agent-alliance/state',
    handler: async (req, res) => {
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return }
      const providers = await registry.detectAll()
      sendJson(res, 200, { providers, recentDispatches: recent.slice(-20) })
    },
  })

  host.register({
    kind: 'exact',
    path: '/__agent-alliance/sessions',
    handler: async (req, res) => {
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return }
      const url = new URL(req.url ?? '/', 'http://local')
      const provider = url.searchParams.get('provider')
      const query = url.searchParams.get('query') || undefined
      const limit = Number(url.searchParams.get('limit')) || 20
      const ledger = loadLedger(home)
      const sessions = []
      for (const p of provider ? [registry.get(provider)] : registry.list()) {
        try {
          for (const s of await p.listSessions({ query, limit })) {
            sessions.push({
              provider: p.id,
              id: String(s.id),
              title: s.title ?? null,
              cwd: s.cwd ?? null,
              createdAt: s.createdAt ?? null,
              imported: !!ledger[sourceKey(p.id, String(s.id))]?.dshSessionId,
            })
          }
        } catch { /* 单家失败不影响 */ }
      }
      sendJson(res, 200, { total: sessions.length, sessions })
    },
  })

  host.register({
    kind: 'exact',
    path: '/__agent-alliance/jobs',
    handler: async (req, res) => {
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return }
      sendJson(res, 200, { recentDispatches: recent.slice(-50) })
    },
  })

  // ---- 后台任务中心：列出 / 读输出 / 取消（kind=agent-alliance）----
  function jobsSvc() {
    if (!ctx || !ctx.jobs) return null
    return ctx.jobs
  }
  host.register({
    kind: 'exact',
    path: '/__agent-alliance/tasks',
    handler: async (req, res) => {
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return }
      const jobs = jobsSvc() // 可为 null：批次不依赖宿主 jobs
      const items = []
      for (const b of batches.values()) {
        items.push({ id: b.id, label: '[' + b.kind + '] ' + b.label, status: b.done ? 'completed' : 'running', batch: true })
      }
      if (jobs) {
        for (const s of jobs.list().filter(s => s.kind === 'agent-alliance').slice(-100)) {
          items.push({ id: s.id, label: s.label, status: s.status, batch: false })
        }
      }
      sendJson(res, 200, { tasks: items.slice(-120) })
    },
  })

  host.register({
    kind: 'exact',
    path: '/__agent-alliance/task-output',
    handler: async (req, res) => {
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return }
      const url = new URL(req.url ?? '/', 'http://local')
      const id = String(url.searchParams.get('id') || '')
      // 批次优先（不依赖宿主 jobs）
      const bb = batches.get(id)
      if (bb) { sendJson(res, 200, { id, status: bb.done ? 'completed' : 'running', text: bb.done ? bb.output : '' }); return }
      const jobs = jobsSvc()
      if (!jobs) { sendJson(res, 501, { error: 'jobs service unavailable' }); return }
      try {
        const rd = jobs.read(id)
        sendJson(res, 200, { id, status: rd.snapshot?.status ?? null, text: String(rd.text || '') })
      } catch (err) { sendJson(res, 403, { error: String(err?.message || err).slice(-160) }) }
    },
  })

  host.register({
    kind: 'exact',
    path: '/__agent-alliance/task-kill',
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return }
      const args = await readBody(req)
      const bk = batches.get(String(args.id || ''))
      if (bk) { sendJson(res, 200, { outcome: bk.done ? 'already-finished' : 'unsupported-for-batch' }); return }
      const jobs = jobsSvc()
      if (!jobs) { sendJson(res, 501, { error: 'jobs service unavailable' }); return }
      try {
        const outcome = jobs.kill(String(args.id || ''), undefined, String(args.reason || 'panel'))
        sendJson(res, 200, { outcome })
      } catch (err) { sendJson(res, 403, { error: String(err?.message || err).slice(-160) }) }
    },
  })

  host.register({
    kind: 'exact',
    path: '/__agent-alliance/session-content',
    handler: async (req, res) => {
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return }
      const url = new URL(req.url ?? '/', 'http://local')
      try {
        const p = registry.get(String(url.searchParams.get('provider') || ''))
        const content = await p.readSession(String(url.searchParams.get('id') || ''), {
          maxChars: Number(url.searchParams.get('maxChars')) || 12000,
        })
        sendJson(res, 200, JSON.parse(JSON.stringify(content ?? null)))
      } catch (err) {
        sendJson(res, 500, { error: String(err?.message || err).slice(-300) })
      }
    },
  })

  host.register({
    kind: 'exact',
    path: '/__agent-alliance/import',
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return }
      let args = {}
      try { args = JSON.parse((await readBody(req)) || '{}') } catch { sendJson(res, 400, { error: 'bad json body' }); return }
      try {
        // 面板导入必须拿到宿主真实服务（sessionPersistence/agents）——
        // 用调用方传入的 ctx；getAgents 仅作测试注入口
        const ioCtx = ctx ?? { get: (name) => name === 'agents' && getAgents ? getAgents() : undefined }
        const r = await importOne(ioCtx, {
          registry,
          provider: String(args.provider || ''),
          externalId: String(args.sessionId || ''),
          home,
        })
        sendJson(res, 200, r)
      } catch (err) {
        sendJson(res, 500, { error: String(err?.message || err).slice(-400) })
      }
    },
  })

  host.register({
    kind: 'exact',
    path: '/__agent-alliance/roundtable',
    handler: async (req, res) => {
      if (req.method === 'POST') {
        let args = {}
        try { args = JSON.parse((await readBody(req)) || '{}') } catch { sendJson(res, 400, { error: 'bad json body' }); return }
        // 面板路径：进程内批次执行（不依赖宿主 job controller——HTTP 组合无 agent 身份）
        const prompt = String(args.prompt || '')
        const providerIds = Array.isArray(args.providers) ? args.providers.map(String) : undefined
        if (!prompt.trim()) { sendJson(res, 400, { error: 'prompt required' }); return }
        const ac = new AbortController()
        const b = newBatch('roundtable', 'roundtable: ' + prompt.replace(/\s+/g, ' ').trim().slice(0, 60))
        sendJson(res, 200, { batchId: b.id })
        runRoundtable({
          registry, prompt, providerIds,
          cwd: args.cwd || config?.defaults?.defaultCwd || undefined,
          rounds: Number(args.rounds) || 1,
          timeoutMs: (config?.defaults?.timeoutMs || 300000) * 2,
          signal: ac.signal,
        }).then((r) => { b.done = true; b.output = formatRoundtableText(r) },
              (err) => { b.done = true; b.output = '失败：' + String(err?.message || err).slice(-400) })
        return
      }
      // GET ?id=batch-x 查询批次结果（兼容旧 jobId 参数名）
      const url = new URL(req.url ?? '/', 'http://local')
      const id = String(url.searchParams.get('id') || url.searchParams.get('batchId') || '')
      const b = batches.get(id)
      if (!b) { sendJson(res, 404, { error: 'unknown roundtable batch' }); return }
      sendJson(res, 200, b.done
        ? { running: false, output: b.output }
        : { running: true, output: null })
    },
  });

  host.register({
    kind: 'exact',
    path: '/__agent-alliance/dispatch',
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return }
      let args = {}
      try { args = JSON.parse((await readBody(req)) || '{}') } catch { sendJson(res, 400, { error: 'bad json body' }); return }
      try {
        const provider = registry.get(String(args.provider || ''))
        const t0 = Date.now()
        const out = await provider.dispatch({
          prompt: String(args.prompt || ''),
          cwd: args.cwd || config?.defaults?.defaultCwd || undefined,
          resumeSessionId: args.resumeSessionId || undefined,
          model: args.model || undefined,
          timeoutMs: Number(args.timeoutMs) || config?.defaults?.timeoutMs || 300000,
          signal: new AbortController().signal,
        })
        recent.push({ at: Date.now(), provider: provider.id, prompt: String(args.prompt || '').slice(0, 80), ms: Date.now() - t0, ok: true })
        sendJson(res, 200, {
          provider: provider.id,
          text: out.text,
          externalSessionId: out.externalSessionId ?? null,
          durationMs: Date.now() - t0,
        })
      } catch (err) {
        recent.push({ at: Date.now(), provider: String(args.provider || ''), prompt: String(args.prompt || '').slice(0, 80), ok: false, error: String(err?.message || err).slice(0, 200) })
        sendJson(res, 500, { error: String(err?.message || err).slice(-500) })
      }
    },
  })
}
