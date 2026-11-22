/**
 * Host-service access shared by every module of the plugin.
 *
 * `ctx.get(name)` answers for a registered service, but it throws for a name
 * outside this plugin's injected set, and a bare `ctx[name]` read throws for an
 * uninjected service too ("cannot get property ... without inject"). Both are
 * expected while the composition is still assembling, so every optional service
 * goes through this one resolver instead of seven hand-rolled copies.
 * @module dsh-agent-alliance/host
 */

/**
 * Read one optional service without letting its absence fail the caller.
 *
 * Returns whatever the context produced — a service, `undefined`, or `null` —
 * because callers already branch on presence with `=== undefined || === null`,
 * `!isObject(...)`, or `?? fallback`. Normalizing null to undefined here would
 * change nothing observable and would hide which of the two the host answered,
 * so the raw value is preserved.
 * @param {object} ctx plugin context
 * @param {string} name service name (`jobs`, `subagents`, `sessionPersistence`, …)
 * @returns {unknown} the service when present, otherwise `undefined`/`null`
 */
export function serviceOf(ctx, name) {
  if (ctx === null || typeof ctx !== 'object') return undefined
  if (typeof ctx.get === 'function') {
    try {
      const resolved = ctx.get(name)
      if (resolved !== undefined) return resolved
    } catch {
      // `get` throws for a service outside the injected set: treat as absent.
    }
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}
