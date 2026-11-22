/**
 * Code shared by the external-CLI providers.
 *
 * Each provider keeps its own argv assembly, stream parsing, and session-store
 * enumeration — those differ per vendor and merging them would be a false
 * abstraction. What does NOT differ is where the vendor binaries live and how a
 * read-only SQLite handle must be released, so those live here instead of being
 * copied per file.
 * @module dsh-agent-alliance/provider/shared
 */

/**
 * Termux's `$PREFIX`, or the conventional Termux location when unset.
 *
 * This is a 0.1.0-era default: the plugin was written for Termux-on-ARM, and
 * every provider still falls back to it. It is kept as the last-resort default
 * because a real host configures `providers.<id>.paths` explicitly (see README),
 * but it must be one definition so a future fix cannot land in three files out
 * of four.
 * @returns {string} the prefix directory without a trailing slash
 */
export function termuxPrefix() {
  return process.env.PREFIX || '/data/data/com.termux/files/usr'
}

/**
 * Run one read against a read-only `node:sqlite` handle, closing it afterwards.
 *
 * The handle must be closed by the caller: `node:sqlite` keeps the descriptor
 * open until the object is collected, and GC is not driven by this workload, so
 * leaking one handle per read exhausts the process descriptor budget and the
 * provider then fails outright instead of degrading.
 *
 * An injected `open` is owned by the test that supplied it and is left open;
 * only handles this module opened are closed here.
 * @template T
 * @param {() => Promise<object>} open opens the handle for one operation
 * @param {boolean} injected whether the handle came from an injected opener
 * @param {(database: object) => T} run read to perform while the handle is open
 * @returns {Promise<T>} the read result
 */
export async function withReadOnlyDb(open, injected, run) {
  const database = await open()
  try {
    return await run(database)
  } finally {
    if (!injected && typeof database?.close === 'function') {
      try { database.close() } catch { /* already closed by the driver */ }
    }
  }
}
