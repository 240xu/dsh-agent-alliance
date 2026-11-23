/**
 * Which external agents already have an OFFICIAL delegation path.
 *
 * This plugin exists for the agents the official seam cannot reach. Naming that
 * boundary in one place — rather than in prose scattered across README and tool
 * descriptions — lets the panel and the tool result tell a caller "prefer the
 * official tool" instead of silently offering a worse duplicate. It also makes
 * a future official bundle a one-line change here rather than an audit.
 *
 * `tool` is the global tool an enabled official bundle registers; `provider` is
 * the name an official provider registers on `ctx.subagents` (which is what this
 * plugin would bind to only when a user opts in).
 * `null` means the official distribution has no path for that agent yet.
 *
 * `ready` separates "an official route exists" from "an official route exists
 * with no extra wiring". Enabling a vendor bundle is one switch and the tool
 * appears; the ACP route additionally needs the CLI's absolute path and args
 * written into a patch row. That difference decides which default is least
 * surprising: a user with only opencode installed gets nothing from a route
 * they have not configured.
 * @module dsh-agent-alliance/official-coverage
 */

/**
 * Official coverage per external agent.
 *
 * `officialPath: null` is a positive statement — "no official route exists" —
 * not an unknown. Every entry must be verifiable against the installed
 * distribution; `tests/official-coverage.test.js` pins the shape.
 * @type {Readonly<Record<string, { officialPath: string|null, officialTool: string|null,
 *                                 officialProvider: string|null, note?: string }>>}
 */
export const OFFICIAL_COVERAGE = Object.freeze({
  codex: Object.freeze({
    officialPath: 'subagent-codex bundle',
    officialTool: 'subagent_codex',
    officialProvider: 'codex',
    ready: true,
  }),
  claude: Object.freeze({
    officialPath: 'subagent-claude-code bundle',
    officialTool: 'subagent_claude_code',
    officialProvider: 'claude-code',
    ready: true,
  }),
  opencode: Object.freeze({
    // The official seam reaches any ACP-compatible agent through subagent-acp,
    // and opencode ships an ACP server (proven for both 1.19.6 and 2.3.2). So an
    // official route DOES exist — just via a generic protocol provider rather
    // than a vendor-specific bundle.
    officialPath: 'subagent-acp bundle (opencode speaks ACP)',
    officialTool: null,
    officialProvider: 'acp',
    note: 'configure subagent-acp with this CLI as `command` and ["acp"] as `args`',
  }),
  zcode: Object.freeze({
    officialPath: null,
    officialTool: null,
    officialProvider: null,
    ready: false,
    note: 'no official bundle and no verified ACP mode; the CLI wrapper is the only route',
  }),
})

/**
 * Whether the official distribution already covers this agent.
 * @param {string} providerId external agent id
 * @returns {boolean} true when an official path exists
 */
/**
 * Whether the official route for an agent works with no extra configuration.
 *
 * `false` means an official route exists but the user must wire it (the ACP
 * case) — so this plugin's wrapper is not redundant for that user yet.
 * @param {string} providerId external agent id
 * @returns {boolean} true when enabling one bundle is enough
 */
export function officialPathIsReady(providerId) {
  const entry = OFFICIAL_COVERAGE[providerId]
  return entry !== undefined && entry.officialPath !== null && entry.ready === true
}

export function hasOfficialPath(providerId) {
  const entry = OFFICIAL_COVERAGE[providerId]
  return entry !== undefined && entry.officialPath !== null
}

/**
 * The sentence a caller should read before choosing this plugin's wrapper.
 *
 * Returned separately from any error so the tool result can carry it as advice
 * rather than as a failure, and so a caller that ignores it still gets the
 * answer it asked for.
 * @param {string} providerId external agent id
 * @returns {string|undefined} guidance, or undefined when the wrapper is the only route
 */
export function officialPreference(providerId) {
  const entry = OFFICIAL_COVERAGE[providerId]
  if (entry === undefined || entry.officialPath === null) return undefined
  if (entry.officialTool !== null) {
    return 'prefer the official `' + entry.officialTool + '` tool'
      + ' (the ' + entry.officialPath + ' provides it when enabled)'
  }
  return 'prefer the official ' + entry.officialPath
    + (entry.note === undefined ? '' : ' — ' + entry.note)
}

/**
 * Provider ids the official distribution does not cover.
 * @returns {string[]} ids whose only route is this plugin's wrapper
 */
export function wrapperOnlyProviders() {
  return Object.keys(OFFICIAL_COVERAGE).filter((id) => OFFICIAL_COVERAGE[id].officialPath === null)
}
