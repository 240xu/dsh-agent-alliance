// Tests for src/config.js: defaults, layer precedence, and loud validation.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { defaultConfig, loadConfig, configPath } from '../src/config.js'

/**
 * Create a fresh temporary directory for one test.
 * @returns {string} absolute directory path
 */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aa-config-'))
}

/**
 * Write one legacy configuration file and return its path.
 * @param {object} value JSON-serializable content
 * @returns {string} absolute file path
 */
function writeFile(value) {
  const file = path.join(tmpDir(), 'dsh-agent-alliance.json')
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  return file
}

test('defaults match the spec', () => {
  const config = defaultConfig()
  // No default subagentProvider: DSH already ships the official delegation
  // tools, so binding our own tool to the same providers by default would
  // duplicate them. Opting in stays possible through config.
  assert.deepEqual(config.providers.claude, { enabled: true })
  assert.deepEqual(config.providers.codex, { enabled: true })
  assert.equal(config.providers.claude.subagentProvider, undefined)
  assert.deepEqual(config.providers.opencode, { enabled: true })
  assert.deepEqual(config.providers.zcode, { enabled: false, commandTemplate: '', resumeTemplate: '' })
  assert.deepEqual(config.defaults, { timeoutMs: 300000, maxConcurrent: 3, defaultCwd: '' })
  assert.deepEqual(config.panel, { enabled: true })
  assert.equal(config.legacyConfigFile, true)
})

test('defaultConfig returns a fresh object every call', () => {
  const first = defaultConfig()
  first.defaults.timeoutMs = 1
  first.providers.claude.enabled = false
  assert.equal(defaultConfig().defaults.timeoutMs, 300000)
  assert.equal(defaultConfig().providers.claude.enabled, true)
})

test('missing legacy file falls back to defaults', () => {
  const file = path.join(tmpDir(), 'absent.json')
  const config = loadConfig(undefined, { file })
  assert.deepEqual(config, defaultConfig())
})

test('empty row config ({}, null, undefined) is a valid empty layer', () => {
  const file = path.join(tmpDir(), 'absent.json')
  for (const row of [{}, null, undefined]) {
    const config = loadConfig(row, { file })
    assert.equal(config.defaults.timeoutMs, 300000)
    assert.equal(config.providers.claude.enabled, true)
  }
})

test('precedence: defaults < legacy file < row config', () => {
  const file = writeFile({
    defaults: { timeoutMs: 111111, maxConcurrent: 2 },
    providers: { claude: { enabled: false }, zcode: { enabled: true } },
  })
  const config = loadConfig({
    defaults: { timeoutMs: 222222 },
    providers: { claude: { enabled: true, subagentProvider: 'my-claude' } },
  }, { file })
  // Row config wins.
  assert.equal(config.defaults.timeoutMs, 222222)
  assert.equal(config.providers.claude.enabled, true)
  assert.equal(config.providers.claude.subagentProvider, 'my-claude')
  // Legacy file wins over built-in defaults.
  assert.equal(config.defaults.maxConcurrent, 2)
  assert.equal(config.providers.zcode.enabled, true)
  // Untouched defaults survive both layers.
  assert.equal(config.defaults.defaultCwd, '')
  assert.equal(config.panel.enabled, true)
})

test('deep merge keeps sibling keys at every level', () => {
  const file = writeFile({ providers: { zcode: { commandTemplate: 'zcode -p {prompt}' } } })
  const config = loadConfig({ providers: { zcode: { resumeTemplate: 'zcode -r {id}' } } }, { file })
  assert.deepEqual(config.providers.zcode, {
    enabled: false,
    commandTemplate: 'zcode -p {prompt}',
    resumeTemplate: 'zcode -r {id}',
  })
})

test('legacyConfigFile: false in the row config skips the legacy file', () => {
  const file = writeFile({ defaults: { timeoutMs: 111111 } })
  const config = loadConfig({ legacyConfigFile: false }, { file })
  assert.equal(config.defaults.timeoutMs, 300000)
})

test('legacyConfigFile: false in options skips the legacy file', () => {
  const file = writeFile({ defaults: { timeoutMs: 111111 } })
  const config = loadConfig({}, { file, legacyConfigFile: false })
  assert.equal(config.defaults.timeoutMs, 300000)
})

test('malformed JSON fails loudly and names the file', () => {
  const file = writeFile('{ oops')
  assert.throws(() => loadConfig({}, { file }), (error) => {
    assert.match(String(error.message), /not valid JSON/)
    assert.ok(String(error.message).includes(file), 'message must name the file: ' + error.message)
    return true
  })
})

test('a non-object legacy document fails loudly and names the file', () => {
  const file = writeFile('[1, 2, 3]')
  assert.throws(() => loadConfig({}, { file }), (error) => {
    assert.ok(String(error.message).includes(file), 'message must name the file: ' + error.message)
    assert.match(String(error.message), /JSON object/)
    return true
  })
})

test('wrong value types are rejected with the offending key', () => {
  const file = path.join(tmpDir(), 'absent.json')
  assert.throws(() => loadConfig({ defaults: { timeoutMs: 'soon' } }, { file }), /defaults\.timeoutMs/)
  assert.throws(() => loadConfig({ defaults: { maxConcurrent: 0 } }, { file }), /defaults\.maxConcurrent/)
  assert.throws(() => loadConfig({ providers: { claude: { enabled: 'yes' } } }, { file }), /providers\.claude\.enabled/)
  assert.throws(() => loadConfig({ providers: { claude: { subagentProvider: 7 } } }, { file }), /subagentProvider/)
  assert.throws(() => loadConfig({ panel: { enabled: 'on' } }, { file }), /panel\.enabled/)
  assert.throws(() => loadConfig({ legacyConfigFile: 'no' }, { file }), /legacyConfigFile/)
  assert.throws(() => loadConfig({ providers: [] }, { file }), /providers/)
})

test('wrong value types in the legacy file name the file', () => {
  const file = writeFile({ defaults: { maxConcurrent: 'many' } })
  assert.throws(() => loadConfig({}, { file }), (error) => {
    assert.ok(String(error.message).includes(file), 'message must name the file: ' + error.message)
    assert.match(String(error.message), /defaults\.maxConcurrent/)
    return true
  })
})

test('a failing layer is never hidden by a good higher layer', () => {
  const file = writeFile({ defaults: { timeoutMs: -1 } })
  assert.throws(() => loadConfig({ defaults: { timeoutMs: 5000 } }, { file }), /defaults\.timeoutMs/)
})

test('configPath resolves against $DSH_HOME or an explicit home', () => {
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/tmp/dsh-home-probe'
    assert.equal(configPath(), '/tmp/dsh-home-probe/dsh-agent-alliance.json')
    assert.equal(configPath('/home/custom'), '/home/custom/dsh-agent-alliance.json')
    delete process.env.DSH_HOME
    assert.match(configPath('/home/custom'), /\/home\/custom\/dsh-agent-alliance\.json$/)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

test('a configured subagentProvider still opts into the official backend', async () => {
  const { loadConfig } = await import('../src/config.js')
  const { mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const file = join(mkdtempSync(join(tmpdir(), 'alliance-cfg-')), 'none.json')
  const config = loadConfig({ providers: { codex: { subagentProvider: 'codex' } } }, { file })
  // Opting in must work; only the DEFAULT is absent.
  assert.equal(config.providers.codex.subagentProvider, 'codex')
  assert.equal(config.providers.claude.subagentProvider, undefined)
})

test('unknown config keys fail loudly instead of silently doing nothing', async () => {
  const { loadConfig } = await import('../src/config.js')
  const file = '/tmp/alliance-no-such-file.json'
  // A typo used to leave the effective value at its default with no error.
  assert.throws(() => loadConfig({ defaults: { maxConcurrents: 5 } }, { file }), /known defaults key/)
  assert.throws(() => loadConfig({ paneel: { enabled: true } }, { file }), /known config key/)
  assert.throws(() => loadConfig({ panel: { enbled: true } }, { file }), /known panel key/)
})

test('the exported Config is a valid official StandardSchemaV1 validator', async () => {
  const { Config } = await import('../index.js')
  // Cordis resolveConfig calls `Config['~standard'].validate(config)` and
  // throws a ValidationError when the result has `issues`. A zero-dependency
  // bundle can still participate in fail-at-load validation.
  assert.equal(Config['~standard'].version, 1)
  assert.equal(typeof Config['~standard'].validate, 'function')

  const bad = Config['~standard'].validate({ defaults: { maxConcurrents: 5 } })
  assert.ok(Array.isArray(bad.issues) && bad.issues.length > 0, 'a typo must fail at load')

  const row = { providers: { claude: { enabled: true } } }
  const good = Config['~standard'].validate(row)
  assert.ok(good.value && !('issues' in good), 'a valid row must resolve')
  // resolveConfig REPLACES the row config with this value. Returning a fully
  // resolved config here would make apply's second loadConfig() merge defaults
  // over the legacy file and silently discard user settings (reproduced on the
  // live Host: providers.zcode.enabled from the legacy file was ignored).
  assert.deepEqual(good.value, row, 'validate must return the row untouched')
  assert.equal('defaults' in good.value, false, 'must not inject defaults into the row')
})
