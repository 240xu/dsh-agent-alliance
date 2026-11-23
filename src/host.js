/**
 * Host-service access shared by every module of the plugin.
 *
 * Both access forms are expected to answer `undefined` for an absent service —
 * measured on 0.2.2-rc.5: `ctx.get('nonexistent')` returns undefined, and so
 * does a bare `ctx.nonexistent` read. The "cannot get property ... without
 * inject" error in `cordis/lib/index.js` fires only when the name IS in a fiber's
 * `inject` list and that fiber is not yet active, which is a load-ordering
 * fault rather than an optional-service probe. Treating both forms as throwing
 * would invite a future editor to keep a catch that can never run — the exact
 * mistake this resolver's earlier copy made.
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
      // `cordis` throws "cannot get required service ... in inactive context"
      // when the name IS in a fiber's inject list but that fiber has not
      // activated yet (`lib/index.js:1269-1271`). That is a load-ordering fault,
      // not an absent optional service, but a caller probing an optional
      // service should still not fail on it — hence the guard rather than a
      // deleted catch.
    }
  }
  try {
    return ctx[name]
  } catch {
    // Same inactive-context case, reached through the bare-property form.
    return undefined
  }
}
