// The coverage table is the one place that says which agents the official
// distribution already reaches. It must stay shaped like a fact table and must
// agree with what the resolver reports.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OFFICIAL_COVERAGE,
  hasOfficialPath,
  officialPreference,
  wrapperOnlyProviders,
} from '../src/official-coverage.js'
import { createBackendResolver } from '../src/backend.js'
import { createRegistry, defineProvider } from '../src/provider/types.js'

test('every known external agent has a coverage entry', () => {
  // A provider that gains a wrapper without a coverage entry would silently
  // reappear as a "official has nothing like this" claim, which is the exact
  // duplication this table exists to prevent.
  for (const id of ['codex', 'claude', 'opencode', 'zcode']) {
    assert.ok(OFFICIAL_COVERAGE[id] !== undefined, id + ' must be in the coverage table')
  }
})

test('coverage entries are internally consistent', () => {
  for (const [id, entry] of Object.entries(OFFICIAL_COVERAGE)) {
    // officialPath is null XOR the rest: "no official route" must carry no tool
    // or provider, and an official route must name at least one of them.
    if (entry.officialPath === null) {
      assert.equal(entry.officialTool, null, id + ': no official path implies no official tool')
      assert.equal(entry.officialProvider, null, id + ': no official path implies no official provider')
    } else {
      assert.ok(
        entry.officialTool !== null || entry.officialProvider !== null,
        id + ': an official path must name a tool or a provider',
      )
    }
  }
})

test('hasOfficialPath distinguishes covered agents from wrapper-only ones', () => {
  assert.equal(hasOfficialPath('codex'), true)
  assert.equal(hasOfficialPath('claude'), true)
  // opencode IS officially reachable — through the generic ACP provider rather
  // than a vendor bundle. Recording it as uncovered would push callers to the
  // wrapper for no reason.
  assert.equal(hasOfficialPath('opencode'), true)
  assert.equal(hasOfficialPath('zcode'), false)
  assert.equal(hasOfficialPath('nonexistent'), false)
})

test('wrapperOnlyProviders names exactly the uncovered agents', () => {
  assert.deepEqual(wrapperOnlyProviders(), ['zcode'])
})

test('officialPreference names the concrete tool a caller should prefer', () => {
  assert.match(officialPreference('codex'), /subagent_codex/)
  assert.match(officialPreference('claude'), /subagent_claude_code/)
  // opencode has no vendor tool, so the advice must point at the ACP bundle and
  // say how to wire it, not at a tool that does not exist.
  assert.match(officialPreference('opencode'), /subagent-acp/)
  assert.match(officialPreference('opencode'), /acp/)
  // The wrapper is the only route for zcode, so there is nothing to prefer.
  assert.equal(officialPreference('zcode'), undefined)
})

test('resolver.list() reports coverage alongside availability', async () => {
  const registry = createRegistry([defineProvider({
    id: 'codex',
    label: 'Codex CLI',
    async dispatch() { return { text: 'x' } },
  })])
  const resolver = createBackendResolver({
    ctx: { get: () => undefined },
    registry,
    config: { providers: { codex: { enabled: true } }, defaults: {} },
  })
  const row = resolver.list(undefined).find((info) => info.id === 'codex')
  // Without this the panel shows "CLI, available" for an agent the official
  // bundle already covers, which is the duplication users cannot see.
  assert.equal(row.official, true)
  assert.match(String(row.prefer), /subagent_codex/)
})
