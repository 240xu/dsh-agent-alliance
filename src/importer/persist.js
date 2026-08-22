// src/importer/persist.js — 导入落库与幂等台账。
// 落库优先 agents.create（宿主完整会话服务），回退 sessionPersistence.create+append。
// 台账 ~/.dsh/agent-alliance/imports.json：sourceKey -> {dshSessionId,...}，重复导入幂等跳过。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { convertToDshEvents } from './convert.js'

function isHomePath(p) {
  const h = homedir()
  return p === h || p === h + '/'
}

export function ledgerPath(home) {
  return join(home || (process.env.DSH_HOME || join(homedir(), '.dsh')), 'agent-alliance', 'imports.json')
}

export function loadLedger(home) {
  try {
    return JSON.parse(readFileSync(ledgerPath(home), 'utf8'))
  } catch {
    return {}
  }
}

export function saveLedger(home, ledger) {
  const p = ledgerPath(home)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, JSON.stringify(ledger, null, 2))
}

export function sourceKey(provider, externalId) {
  return provider + ':' + externalId
}

export async function importOne(ctx, { registry, provider: providerId, externalId, home }) {
  const key = sourceKey(providerId, externalId)
  const ledger = loadLedger(home)
  if (ledger[key]?.dshSessionId) {
    return { status: 'already-imported', dshSessionId: ledger[key].dshSessionId }
  }
  const provider = registry.get(providerId)
  if (typeof provider.exportSession !== 'function') {
    throw new Error('provider ' + providerId + ' 不支持 exportSession')
  }
  const ext = await provider.exportSession(String(externalId))
  if (!ext || !Array.isArray(ext.turns) || ext.turns.length === 0) {
    return { status: 'skipped', reason: '无可导入内容' }
  }
  const dshSessionId = randomUUID()
  const cwd = ext.cwd || process.env.HOME || homedir()
  const events = convertToDshEvents({
    id: dshSessionId,
    cwd,
    createdAt: ext.createdAt || Date.now(),
    title: ext.title || providerId + ':' + externalId,
    turns: ext.turns,
  })

  // 直写持久化优先：导入是历史还原，不需要 agent 生命周期（其策略注入路径
  // 在本部署会追加不可序列化的 sandbox/mode）。写完预热投影缓存让 GUI 列表可见。
  const sp = ctx.get('sessionPersistence')
  let created = false
  if (sp && typeof sp.create === 'function' && typeof sp.append === 'function') {
    await sp.create({ id: dshSessionId, version: 0, cwd, createdAt: ext.createdAt || Date.now() })
    await sp.append(dshSessionId, events)
    const proj = ctx.get('sessionProjectionCache')
    if (proj && typeof proj.coldSnapshot === 'function') {
      try { await proj.coldSnapshot(dshSessionId) } catch { /* 预热失败不影响落盘 */ }
    }
    // 工作区归组（对齐 chat-import REQ-39/70）：真实 cwd 才解析；主目录跳过
    if (cwd && !isHomePath(cwd)) {
      try {
        const wr = ctx.get('workspaceRegistry')
        if (wr && typeof wr.resolveByPath === 'function') {
          let ws = await wr.resolveByPath(cwd)
          if (!ws && typeof wr.create === 'function') ws = await wr.create(cwd)
          if (ws && typeof ws.attachSession === 'function') await ws.attachSession(dshSessionId)
        }
      } catch { /* 归组失败不影响导入 */ }
    }
  } else {
    const agents = ctx.get('agents')
    if (!agents || typeof agents.create !== 'function') {
      throw new Error('宿主既无 sessionPersistence 也无 agents 服务，无法落库')
    }
    await agents.create({ sessionId: dshSessionId, meta: { id: dshSessionId, cwd, createdAt: ext.createdAt || Date.now() }, seed: events })
    created = true
  }

  ledger[key] = {
    dshSessionId,
    provider: providerId,
    externalId: String(externalId),
    importedAt: Date.now(),
    turns: ext.turns.length,
    via: created ? 'agents.create' : 'sessionPersistence.direct',
  }
  saveLedger(home, ledger)
  return { status: 'imported', dshSessionId, turns: ext.turns.length, title: ext.title ?? null }
}
