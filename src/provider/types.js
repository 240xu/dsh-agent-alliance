// src/provider/types.js — Provider 统一接口与注册表。
// Provider 契约见 docs/SPEC.md：detect/dispatch/listSessions/readSession。

export function defineProvider(spec) {
  if (!spec || typeof spec.id !== 'string' || !spec.id) {
    throw new Error('defineProvider: id 必填（字符串）')
  }
  if (typeof spec.label !== 'string' || !spec.label) {
    throw new Error('defineProvider(' + spec.id + '): label 必填')
  }
  if (typeof spec.dispatch !== 'function') {
    throw new Error('defineProvider(' + spec.id + '): dispatch 必须是函数')
  }
  return { listSessions: async () => [], readSession: async () => ({ messages: [] }), ...spec }
}

export function createRegistry(providers) {
  const byId = new Map()
  for (const p of providers || []) byId.set(p.id, p)
  return {
    list() { return [...byId.values()] },
    get(id) {
      const p = byId.get(id)
      if (!p) throw new Error('unknown provider: ' + String(id))
      return p
    },
    has(id) { return byId.has(id) },
    /**
     * Probe every provider in parallel and settle within `budgetMs`.
     *
     * Probing serially would let one slow CLI stall the whole answer: the
     * per-provider timeouts reach 15-20s each, so four of them held /state for
     * up to a minute. A provider that has not answered inside the budget is
     * reported as not-yet-known rather than blocking the response.
     * @param {{ budgetMs?: number }} [options] overall probe budget
     * @returns {Promise<Array<{ id: string, label: string, available: boolean, detail?: string }>>} one row per provider
     */
    async detectAll({ budgetMs = 2500 } = {}) {
      const rows = await Promise.all([...byId.values()].map(async (p) => {
        if (typeof p.detect !== 'function') {
          return { id: p.id, label: p.label, available: false, detail: 'no detect()' }
        }
        let timer
        const timeout = new Promise((resolve) => {
          // Keep this timer REFERENCED. `unref()` was tried: when a provider's
          // detect() never settles and no other ref'd handle remains, the event
          // loop drains and the whole detectAll() promise hangs instead of
          // resolving with "probe timed out" after budgetMs.
          timer = setTimeout(() => resolve({ available: false, detail: 'probe timed out' }), budgetMs)
        })
        try {
          const d = await Promise.race([p.detect(), timeout])
          return { id: p.id, label: p.label, ...d }
        } catch (err) {
          return { id: p.id, label: p.label, available: false, detail: String(err?.message || err) }
        } finally {
          // A slow detect() may still be running after the race. Its promise is
          // detached here; a real spawnCli owns its own timeout and reaps its
          // child, so no reference is retained by this registry.
          if (timer !== undefined) clearTimeout(timer)
        }
      }))
      return rows
    },
  }
}
