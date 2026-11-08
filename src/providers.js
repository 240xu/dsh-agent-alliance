// src/providers.js — config + 可注入 deps → 四家 Provider 实例 → registry。
// deps 形状：{ spawnCli?, paths?: { claude?, codex?, opencode?, zcode? }, openDb?: { opencode?, zcode? } }

import { createRegistry } from './provider/types.js'
import { makeClaudeProvider } from './provider/claude.js'
import { makeCodexProvider } from './provider/codex.js'
import { makeOpencodeProvider } from './provider/opencode.js'
import { makeZcodeProvider } from './provider/zcode.js'

/**
 * Merge one provider's configured path overrides with test-injected ones.
 *
 * The CLI providers accept path overrides through `deps.paths`, which the
 * production entry never passed — only tests did. Reading the `paths` key from
 * the row config here makes a user-supplied executable path actually take
 * effect on an ordinary Linux host, without removing the test injection seam.
 * Explicit injected paths win over config when both exist.
 * @param {object} entry the provider's config entry
 * @param {object|undefined} injected test-injected paths
 * @returns {object|undefined} merged path overrides, when any
 */
function pathsFor(entry, injected) {
  const configured = entry !== null && typeof entry === 'object' && entry.paths !== undefined
    ? entry.paths
    : undefined
  if (configured === undefined) return injected
  if (configured === null || typeof configured !== 'object' || Array.isArray(configured)) {
    throw new Error('providers: `paths` must be an object of path overrides')
  }
  return { ...configured, ...(injected || {}) }
}

export function buildProviders({ config, deps = {} } = {}) {
  const cfg = config || {}
  const pc = cfg.providers || {}
  const spawnCli = deps.spawnCli
  const paths = deps.paths || {}
  const openDb = deps.openDb || {}

  const claude = makeClaudeProvider({ config: pc.claude || {}, deps: { ...(spawnCli ? { spawnCli } : {}), paths: pathsFor(pc.claude, paths.claude) } })
  const codex = makeCodexProvider({ config: pc.codex || {}, deps: { ...(spawnCli ? { spawnCli } : {}), paths: pathsFor(pc.codex, paths.codex) } })
  const opencode = makeOpencodeProvider({
    config: pc.opencode || {},
    deps: { ...(spawnCli ? { spawnCli } : {}), paths: pathsFor(pc.opencode, paths.opencode), ...(openDb.opencode ? { openDb: openDb.opencode } : {}) },
  })
  const zcode = makeZcodeProvider({
    config: pc.zcode || {},
    deps: { ...(spawnCli ? { spawnCli } : {}), paths: pathsFor(pc.zcode, paths.zcode) },
    ...(openDb.zcode ? { openDb: openDb.zcode } : {}),
  })

  return createRegistry([claude, codex, opencode, zcode])
}
