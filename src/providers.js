// src/providers.js — config + 可注入 deps → 四家 Provider 实例 → registry。
// deps 形状：{ spawnCli?, paths?: { claude?, codex?, opencode?, zcode? }, openDb?: { opencode?, zcode? } }

import { createRegistry } from './provider/types.js'
import { makeClaudeProvider } from './provider/claude.js'
import { makeCodexProvider } from './provider/codex.js'
import { makeOpencodeProvider } from './provider/opencode.js'
import { makeZcodeProvider } from './provider/zcode.js'

export function buildProviders({ config, deps = {} } = {}) {
  const cfg = config || {}
  const pc = cfg.providers || {}
  const spawnCli = deps.spawnCli
  const paths = deps.paths || {}
  const openDb = deps.openDb || {}

  const claude = makeClaudeProvider({ deps: { ...(spawnCli ? { spawnCli } : {}), paths: paths.claude } })
  const codex = makeCodexProvider({ deps: { ...(spawnCli ? { spawnCli } : {}), paths: paths.codex } })
  const opencode = makeOpencodeProvider({
    deps: { ...(spawnCli ? { spawnCli } : {}), paths: paths.opencode, ...(openDb.opencode ? { openDb: openDb.opencode } : {}) },
  })
  const zcode = makeZcodeProvider({
    config: pc.zcode || {},
    deps: { ...(spawnCli ? { spawnCli } : {}), paths: paths.zcode },
    ...(openDb.zcode ? { openDb: openDb.zcode } : {}),
  })

  return createRegistry([claude, codex, opencode, zcode])
}
