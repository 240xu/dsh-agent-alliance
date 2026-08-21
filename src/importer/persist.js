// src/importer/persist.js — 导入落库与幂等台账。
// 落库优先 agents.create（宿主完整会话服务），回退 sessionPersistence.create+append。
// 台账 ~/.dsh/agent-alliance/imports.json：sourceKey -> {dshSessionId,...}，重复导入幂等跳过。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { convertToDshEvents } from './convert.js'

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

  const agents = ctx.get('agents')
  let created = false
  if (agents && typeof agents.create === 'function') {
    await agents.create({ sessionId: dshSessionId, meta: { id: dshSessionId, cwd, createdAt: ext.createdAt || Date.now() }, seed: events })
    created = true
  } else {
    const sp = ctx.get('sessionPersistence')
    if (!sp) throw new Error('宿主既无 agents 也无 sessionPersistence 服务，无法落库')
    await sp.create({ id: dshSessionId, cwd, createdAt: ext.createdAt || Date.now() })
    await sp.append(dshSessionId, events)
  }

  ledger[key] = {
    dshSessionId,
    provider: providerId,
    externalId: String(externalId),
    importedAt: Date.now(),
    turns: ext.turns.length,
    via: created ? 'agents.create' : 'sessionPersistence',
  }
  saveLedger(home, ledger)
  return { status: 'imported', dshSessionId, turns: ext.turns.length, title: ext.title ?? null }
}
