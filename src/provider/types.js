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
    async detectAll() {
      const out = []
      for (const p of byId.values()) {
        if (typeof p.detect !== 'function') {
          out.push({ id: p.id, label: p.label, available: false, detail: 'no detect()' })
          continue
        }
        try {
          const d = await p.detect()
          out.push({ id: p.id, label: p.label, ...d })
        } catch (err) {
          out.push({ id: p.id, label: p.label, available: false, detail: String(err?.message || err) })
        }
      }
      return out
    },
  }
}
