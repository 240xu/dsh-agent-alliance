// src/config.js — resolved plugin configuration.
// Precedence: built-in defaults < legacy file < cordis.patch.yml row config.
// Every layer deep-merges; invalid types and malformed JSON fail loudly with the
// origin so a broken deployment is never silently downgraded to defaults.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Built-in defaults for every configuration key. Returns a fresh object so a
 * caller may mutate it without affecting later calls.
 * @returns {object} default providers, defaults, and panel configuration
 */
export function defaultConfig() {
  // No `subagentProvider` by default. DSH already ships a first-class official
  // delegation path — the global `subagent` (spawn) and `subagent_fork` (fork,
  // which inherits the parent prefix and stays KV-cache eligible) tools from
  // dsh-base — and enabling a vendor bundle adds `subagent_codex` /
  // `subagent_claude_code`. Pointing our own tool at those same providers
  // duplicated them with opposite ergonomics (ours blocks, theirs returns an id)
  // and made two tools compete for one provider. They stay supported as an
  // opt-in for callers that specifically want this plugin to await the answer.
  return {
    providers: {
      claude: { enabled: true },
      codex: { enabled: true },
      opencode: { enabled: true },
      zcode: { enabled: false, commandTemplate: '', resumeTemplate: '' },
    },
    defaults: {
      timeoutMs: 300000,
      maxConcurrent: 3,
      defaultCwd: '',
    },
    panel: { enabled: true },
    legacyConfigFile: true,
  }
}

/**
 * Legacy configuration file location.
 * @param {string} [home] DSH home directory; falls back to `$DSH_HOME` and `~/.dsh`
 * @returns {string} absolute path of `dsh-agent-alliance.json`
 */
export function configPath(home) {
  const base = home || process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(base, 'dsh-agent-alliance.json')
}

/**
 * Whether a value is a plain JSON object (not null, not an array).
 * @param {unknown} value candidate value
 * @returns {boolean} true for plain objects
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Recursively merge one configuration layer over another; arrays and scalars
 * replace, plain objects merge key by key.
 * @param {object} base lower-precedence layer
 * @param {object} patch higher-precedence layer
 * @returns {object} merged copy
 */
function deepMerge(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch || {})) {
    out[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? deepMerge(base[key], value) : value
  }
  return out
}

/**
 * Raise a configuration error naming the offending key and its origin.
 * @param {string} key dotted configuration key
 * @param {string} expectation expected type
 * @param {string} origin layer the value came from
 * @returns {never} always throws
 */
function invalid(key, expectation, origin) {
  throw new Error('agent-alliance: ' + key + ' must be ' + expectation + ' (from ' + origin + ')')
}

/**
 * Validate one configuration layer before it is merged, so a bad value in a
 * lower layer cannot be hidden by a good value in a higher one.
 * @param {object} layer raw configuration layer
 * @param {string} origin human-readable source, including a file path when the
 *   layer came from disk
 * @returns {void}
 */
function validateLayer(layer, origin) {
  if (!isPlainObject(layer)) invalid('config', 'a JSON object', origin)
  const { providers, defaults, panel, legacyConfigFile } = layer
  if (providers !== undefined) {
    if (!isPlainObject(providers)) invalid('providers', 'an object keyed by provider id', origin)
    for (const [id, entry] of Object.entries(providers)) {
      const key = 'providers.' + id
      if (!isPlainObject(entry)) invalid(key, 'an object', origin)
      if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') invalid(key + '.enabled', 'a boolean', origin)
      if (entry.subagentProvider !== undefined && typeof entry.subagentProvider !== 'string') {
        invalid(key + '.subagentProvider', 'a string', origin)
      }
      if (entry.commandTemplate !== undefined && typeof entry.commandTemplate !== 'string') {
        invalid(key + '.commandTemplate', 'a string', origin)
      }
      if (entry.resumeTemplate !== undefined && typeof entry.resumeTemplate !== 'string') {
        invalid(key + '.resumeTemplate', 'a string', origin)
      }
      // Explicit executable/session-store path overrides. Validated here so a
      // malformed value fails at load instead of silently becoming a spread.
      if (entry.paths !== undefined) {
        if (!isPlainObject(entry.paths)) invalid(key + '.paths', 'an object', origin)
        for (const [pathKey, value] of Object.entries(entry.paths)) {
          if (typeof value !== 'string' || value === '') {
            invalid(key + '.paths.' + pathKey, 'a non-empty string', origin)
          }
        }
      }
    }
  }
  if (defaults !== undefined) {
    if (!isPlainObject(defaults)) invalid('defaults', 'an object', origin)
    if (defaults.timeoutMs !== undefined
      && (typeof defaults.timeoutMs !== 'number' || !Number.isFinite(defaults.timeoutMs) || defaults.timeoutMs <= 0)) {
      invalid('defaults.timeoutMs', 'a positive finite number', origin)
    }
    if (defaults.maxConcurrent !== undefined
      && (!Number.isInteger(defaults.maxConcurrent) || defaults.maxConcurrent < 1)) {
      invalid('defaults.maxConcurrent', 'a positive integer', origin)
    }
    if (defaults.defaultCwd !== undefined && typeof defaults.defaultCwd !== 'string') {
      invalid('defaults.defaultCwd', 'a string', origin)
    }
  }
  if (panel !== undefined) {
    if (!isPlainObject(panel)) invalid('panel', 'an object', origin)
    if (panel.enabled !== undefined && typeof panel.enabled !== 'boolean') invalid('panel.enabled', 'a boolean', origin)
  }
  if (legacyConfigFile !== undefined && typeof legacyConfigFile !== 'boolean') {
    invalid('legacyConfigFile', 'a boolean', origin)
  }
}

/**
 * Read and validate the legacy `~/.dsh/dsh-agent-alliance.json` layer.
 * @param {string} file absolute path
 * @returns {object|undefined} parsed layer, or undefined when the file is absent
 * @throws {Error} when the file cannot be read or is not a valid JSON object
 */
function readLegacyLayer(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw new Error('agent-alliance: cannot read config file ' + file + ': ' + String(error?.message || error))
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error('agent-alliance: config file is not valid JSON: ' + file + ' (' + String(error?.message || error) + ')')
  }
  validateLayer(parsed, file)
  return parsed
}

/**
 * Resolve the effective configuration.
 *
 * Precedence is the cordis.patch.yml row `config` over the legacy
 * `~/.dsh/dsh-agent-alliance.json` file over built-in defaults. The legacy file
 * is only read when `legacyConfigFile !== false` in the row config.
 * @param {object} [rowConfig] plugin config from the cordis.patch.yml row
 * @param {object} [options] test/deployment overrides
 * @param {string} [options.home] DSH home directory used to locate the legacy file
 * @param {string} [options.file] explicit legacy file path (overrides `home`)
 * @param {boolean} [options.legacyConfigFile] force the legacy layer on or off
 * @returns {object} fully merged configuration
 * @throws {Error} on a malformed legacy file or a value of the wrong type
 */
export function loadConfig(rowConfig, options = {}) {
  const row = rowConfig === undefined || rowConfig === null ? {} : rowConfig
  validateLayer(row, 'cordis.patch.yml row config')
  let resolved = defaultConfig()
  const readLegacy = row.legacyConfigFile !== false && options.legacyConfigFile !== false
  if (readLegacy) {
    const file = options.file || configPath(options.home)
    const legacy = readLegacyLayer(file)
    if (legacy !== undefined) resolved = deepMerge(resolved, legacy)
  }
  return deepMerge(resolved, row)
}
