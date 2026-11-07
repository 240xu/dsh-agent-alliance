// src/importer/persist.js — 外部会话落库 + 幂等台账。
//
// 落库走 DSH 0.2.x 的当前接口：`ctx.sessionPersistence.create(header)` 返回
// SessionHandle，append/flush/close 都在 handle 上（服务级 `append(id, events)`
// 已不存在）。create 成功后无论 append/flush 成败都必须 close，否则写锁泄漏。
//
// 台账 ~/.dsh/agent-alliance/imports.json：`provider:externalId -> 记录`，
// 用「临时文件 + rename」原子替换，重复导入按台账幂等跳过。

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { convertToDshEvents } from './convert.js'

const SESSION_FORMAT_VERSION = 4

/** 台账键：provider 与外部会话 id 的组合。 */
export function sourceKey(provider, externalId) {
  return provider + ':' + externalId
}

/** 台账文件路径；home 缺省时依次退回 DSH_HOME、~/.dsh。 */
export function ledgerPath(home) {
  const root = home || process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(root, 'agent-alliance', 'imports.json')
}

/** 读取台账；文件缺失或损坏时返回空台账（导入仍可进行）。 */
export function loadLedger(home) {
  let text
  try {
    text = readFileSync(ledgerPath(home), 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 原子写台账：先写同目录临时文件再 rename，读者不会看到半截 JSON。 */
export function saveLedger(home, ledger) {
  const path = ledgerPath(home)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.' + process.pid + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch { /* 清理失败不改变原始错误 */ }
    throw error
  }
}

/**
 * Per-ledger-path serialisation of the read-modify-write that records an
 * import. `saveLedger` is atomic per write, but two concurrent importers that
 * both read the ledger before either writes will each persist only their own
 * entry, so the other import is forgotten. A forgotten entry defeats the
 * idempotency check and the same external session is imported twice.
 *
 * Writes are keyed by absolute ledger path, so imports into different DSH homes
 * stay independent.
 * @type {Map<string, Promise<unknown>>}
 */
const ledgerWrites = new Map()

/**
 * Imports currently running, keyed by ledger path and external session key.
 *
 * Two concurrent imports of the SAME external session must not both reach
 * `sessionPersistence.create`: the loser would write a duplicate DSH session
 * before the ledger recorded the winner. The second caller instead waits for
 * the first and then reports `already-imported`.
 * @type {Map<string, Promise<unknown>>}
 */
const inflightImports = new Map()

/**
 * Apply one mutation to the ledger under an exclusive per-path lock.
 *
 * The ledger is re-read inside the lock immediately before writing, so a
 * mutation always lands on the newest committed state rather than on a snapshot
 * taken before a long import. `mutate` returns the value to record, or
 * `undefined` to leave the ledger untouched.
 * @param {string} home DSH home directory
 * @param {(ledger: object) => { key: string, value: object } | undefined} mutate
 *   pure mutation describing the entry to store
 * @returns {Promise<object|undefined>} the value recorded, when any
 */
export async function recordLedgerEntry(home, mutate) {
  const path = ledgerPath(home)
  const previous = ledgerWrites.get(path) ?? Promise.resolve()
  const next = previous.then(() => {
    const ledger = loadLedger(home)
    const change = mutate(ledger)
    if (change === undefined) return undefined
    ledger[change.key] = change.value
    saveLedger(home, ledger)
    return change.value
  })
  // Queue a settled-always tail so one rejected write cannot break the chain
  // for later callers, and so the map entry identity stays comparable.
  const tail = next.then(() => undefined, () => undefined)
  ledgerWrites.set(path, tail)
  try {
    return await next
  } finally {
    // Drop the map entry once this was the last write queued for the path.
    if (ledgerWrites.get(path) === tail) ledgerWrites.delete(path)
  }
}

/**
 * Resolve one optional Cordis service.
 *
 * `ctx.get(name)` is the portable read: a plugin that does not declare the
 * service in `inject` gets `undefined` from it, while a bare `ctx[name]`
 * property read throws `cannot get property "…" without inject`. Both forms are
 * tried so the module works under a real context and a lightweight fake alike.
 * @param {object} ctx host context
 * @param {string} name service name
 * @returns {unknown} the service, or undefined when absent
 */
function serviceOf(ctx, name) {
  if (ctx === null || typeof ctx !== 'object') return undefined
  if (typeof ctx.get === 'function') {
    try {
      const service = ctx.get(name)
      if (service !== undefined) return service
    } catch { /* unmounted service: treat as absent */ }
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/** 真实存在且是目录的绝对路径才算可归组的工作目录。 */
function existingDirectory(value) {
  if (typeof value !== 'string' || value === '' || !isAbsolute(value)) return undefined
  try {
    return statSync(value).isDirectory() ? value : undefined
  } catch {
    return undefined
  }
}

/** 主目录（含尾部斜杠写法）不参与工作区归组。 */
function isHomeDirectory(value) {
  const home = homedir()
  return resolve(value) === resolve(home)
}

/**
 * 预热投影缓存；这是纯优化，任何失败都不影响已落盘的导入。
 * @param {object} ctx 宿主 context
 * @param {string} sessionId 会话 id
 * @returns {Promise<void>}
 */
async function warmProjection(ctx, sessionId) {
  try {
    const cache = serviceOf(ctx, 'sessionProjectionCache')
    if (cache !== undefined && cache !== null && typeof cache.coldSnapshot === 'function') {
      await cache.coldSnapshot(sessionId)
    }
  } catch { /* 预热失败不影响导入结果 */ }
}

/**
 * 把导入会话挂到 cwd 对应的工作区；仅当 cwd 是真实非主目录目录时执行。
 * @param {object} ctx 宿主 context
 * @param {string} sessionId 会话 id
 * @param {string} cwd 会话工作目录
 * @returns {Promise<void>}
 */
async function attachWorkspace(ctx, sessionId, cwd) {
  const directory = existingDirectory(cwd)
  if (directory === undefined || isHomeDirectory(directory)) return
  try {
    const registry = serviceOf(ctx, 'workspaceRegistry')
    if (registry === undefined || registry === null || typeof registry.resolveByPath !== 'function') return
    const workspace = await registry.resolveByPath(directory)
    if (workspace === undefined || workspace === null) return
    // insertSessionBefore 只接受已在该工作区名下的会话，所以先 attach 再排序；
    // attachSession 把新会话放在首位，锚定 attach 前的首位即可保持该顺序。
    const anchor = Array.isArray(workspace.sessionIds) ? workspace.sessionIds[0] : undefined
    if (typeof workspace.attachSession === 'function') await workspace.attachSession(sessionId)
    if (typeof workspace.insertSessionBefore === 'function' && anchor !== undefined && anchor !== sessionId) {
      await workspace.insertSessionBefore(sessionId, anchor)
    }
  } catch { /* 归组失败不影响导入结果 */ }
}

/**
 * 导入一个外部会话为 DSH v4 会话。
 * @param {object} ctx 宿主 context（需提供 sessionPersistence）
 * @param {object} options
 * @param {{get(id: string): object}} options.registry 外部 provider 注册表
 * @param {string} options.provider provider id
 * @param {string} options.externalId 外部会话 id
 * @param {string} [options.home] 台账根目录
 * @returns {Promise<{status: 'imported'|'already-imported'|'skipped', dshSessionId?: string, turns?: number, title?: string|null, reason?: string}>}
 */
async function importOneUnlocked(ctx, { registry, provider: providerId, externalId, home }) {
  if (ctx === undefined || ctx === null) throw new Error('importOne 需要宿主 context')
  const provider = registry.get(providerId)
  if (provider === undefined || provider === null || typeof provider.exportSession !== 'function') {
    throw new Error('provider ' + String(providerId) + ' 不支持 exportSession')
  }
  const externalKey = sourceKey(providerId, String(externalId))
  const ledger = loadLedger(home)
  const known = ledger[externalKey]
  if (known !== undefined && known !== null && typeof known.dshSessionId === 'string' && known.dshSessionId !== '') {
    return { status: 'already-imported', dshSessionId: known.dshSessionId }
  }

  const exported = await provider.exportSession(String(externalId))
  if (exported === undefined || exported === null || !Array.isArray(exported.turns) || exported.turns.length === 0) {
    return { status: 'skipped', reason: '无可导入内容' }
  }

  const persistence = serviceOf(ctx, 'sessionPersistence')
  if (persistence === undefined || persistence === null || typeof persistence.create !== 'function') {
    throw new Error('宿主缺少 sessionPersistence.create，无法落库')
  }

  const dshSessionId = randomUUID()
  const createdAt = Number.isSafeInteger(exported.createdAt) && exported.createdAt >= 0
    ? exported.createdAt
    : Date.now()
  const cwd = existingDirectory(exported.cwd)
  const events = convertToDshEvents({
    id: dshSessionId,
    cwd,
    createdAt,
    title: exported.title,
    turns: exported.turns,
  })

  const header = { version: SESSION_FORMAT_VERSION, id: dshSessionId, createdAt, isSeeded: false }
  if (cwd !== undefined) header.cwd = cwd

  let handle
  try {
    handle = await persistence.create(header)
    await handle.append(events)
    await handle.flush()
  } finally {
    if (handle !== undefined && handle !== null && typeof handle.close === 'function') await handle.close()
  }

  await warmProjection(ctx, dshSessionId)
  await attachWorkspace(ctx, dshSessionId, cwd)

  // Record under the ledger lock so a concurrent import cannot overwrite this
  // entry with a snapshot it read before the session above was written.
  await recordLedgerEntry(home, (latest) => {
    const existing = latest[externalKey]
    if (existing !== undefined && existing !== null && typeof existing.dshSessionId === 'string') {
      return undefined
    }
    return {
      key: externalKey,
      value: {
        dshSessionId,
        provider: String(providerId),
        externalId: String(externalId),
        importedAt: Date.now(),
        turns: exported.turns.length,
        title: typeof exported.title === 'string' ? exported.title : null,
      },
    }
  })

  return {
    status: 'imported',
    dshSessionId,
    turns: exported.turns.length,
    title: typeof exported.title === 'string' ? exported.title : null,
  }
}

/**
 * Import one external session, serialised per external key.
 *
 * The wrapper exists so two concurrent imports of the same external session
 * cannot both create a DSH session: the second waits for the first, then reads
 * the ledger and reports the winner's id. Distinct sessions still import in
 * parallel, and their ledger writes are merged under {@link recordLedgerEntry}.
 * @param {object} ctx host context
 * @param {object} options registry, provider id, external id, and ledger home
 * @returns {Promise<{status: 'imported'|'already-imported'|'skipped', dshSessionId?: string, turns?: number, title?: string|null, reason?: string}>} import outcome
 */
export async function importOne(ctx, options) {
  const home = options.home
  const key = ledgerPath(home) + '|' + sourceKey(options.provider, String(options.externalId))
  const running = inflightImports.get(key)
  if (running !== undefined) {
    // Another import of this exact session is already writing it.
    try {
      await running
    } catch { /* the winner failed; fall through and retry ourselves */ }
    const settled = loadLedger(home)[sourceKey(options.provider, String(options.externalId))]
    if (settled !== undefined && settled !== null && typeof settled.dshSessionId === 'string' && settled.dshSessionId !== '') {
      return { status: 'already-imported', dshSessionId: settled.dshSessionId }
    }
  }
  const work = importOneUnlocked(ctx, options)
  const tail = work.then(() => undefined, () => undefined)
  inflightImports.set(key, tail)
  try {
    return await work
  } finally {
    if (inflightImports.get(key) === tail) inflightImports.delete(key)
  }
}
