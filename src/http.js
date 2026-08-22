// src/http.js — 面板数据端点（webServer 可选注册）。
// GET  /__agent-alliance/state    provider 探测 + 概要
// GET  /__agent-alliance/sessions?provider=&query=&limit=
// GET  /__agent-alliance/jobs     最近派发记录（进程内）
// POST /__agent-alliance/dispatch {provider,prompt,cwd?,resumeSessionId?,model?}（前台等待）

import { loadLedger, sourceKey } from './importer/persist.js'
import { importOne } from './importer/persist.js'
import { runRoundtable, formatRoundtableText } from './roundtable.js'

export function registerHttp(host, { registry, config, home, ctx, getAgents, startJob }) {
  const roundtables = new Map() // id -> {output?|running}
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
        if (!startJob) { sendJson(res, 501, { error: 'roundtable 需要 jobs 服务（宿主未提供）' }); return }
        try {
          const prompt = String(args.prompt || '')
          const providerIds = Array.isArray(args.providers) ? args.providers.map(String) : undefined
          const ac = new AbortController()
          let doneResolve
          const done = new Promise((r) => { doneResolve = r })
          const handle = startJob({
            kind: 'agent-alliance',
            label: 'roundtable: ' + prompt.replace(/\s+/g, ' ').trim().slice(0, 60),
            run() {
              runRoundtable({ registry, prompt, providerIds, cwd: args.cwd || config?.defaults?.defaultCwd || undefined, timeoutMs: (config?.defaults?.timeoutMs || 300000) * 2, signal: ac.signal })
                .then((r) => { doneResolve({ status: 'completed', output: formatRoundtableText(r) }) },
                      (err) => { doneResolve({ status: 'failed', detail: String(err?.message || err).slice(-400) }) })
              return { cancel(reason) { ac.abort(new Error(reason || 'cancelled')) }, done }
            },
          })
          const entry = { running: true, output: null, detail: null }
          roundtables.set(handle.id, entry)
          done.then((outcome) => {
            entry.running = false
            entry.output = outcome.output ?? null
            entry.detail = outcome.detail ?? null
          })
          sendJson(res, 200, { jobId: handle.id })
        } catch (err) {
          sendJson(res, 500, { error: String(err?.message || err).slice(-300) })
        }
        return
      }
      // GET 轮询
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return }
      const url = new URL(req.url ?? '/', 'http://local')
      const id = String(url.searchParams.get('id') || '')
      const entry = roundtables.get(id)
      if (!entry) { sendJson(res, 404, { error: 'unknown roundtable job' }); return }
      if (entry.running) sendJson(res, 200, { running: true })
      else sendJson(res, 200, { running: false, output: entry.output, detail: entry.detail ?? null })
    },
  })

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
