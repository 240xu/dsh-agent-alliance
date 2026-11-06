// Tests for the host entry point: apply wires config → providers → backend
// resolver → tools, registers the panel only through ctx.inject, and disposes
// everything with the fiber.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, name, inject } from '../index.js'

/**
 * Fake Cordis context with the pieces the plugin touches.
 *
 * `effects` records every `ctx.effect()` label so disposal can be asserted;
 * `injects` records every `ctx.inject()` callback so the panel route can be
 * mounted on demand.
 * @param {object} [options] fake service switches
 * @returns {object} fake context with its record arrays
 */
function fakeCtx(options = {}) {
  const registrations = []
  const effects = []
  const injects = []
  const routes = []
  const warnings = []
  const ctx = {
    registrations,
    effects,
    injects,
    routes,
    warnings,
    logger: {
      warn(message) { warnings.push(['warn', message]) },
      error(message) { warnings.push(['error', message]) },
    },
    tools: {
      register(definition) {
        registrations.push(definition)
        return () => {
          const index = registrations.indexOf(definition)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    },
    effect(body, label) {
      effects.push(label)
      const disposer = body()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    inject(services, callback) {
      injects.push(services)
      if (options.withWebServer === true) {
        const webCtx = {
          webServer: {
            register(route) {
              routes.push(route)
              return () => {
                const index = routes.indexOf(route)
                if (index >= 0) routes.splice(index, 1)
              }
            },
          },
          effect(body, label) {
            effects.push(label)
            const disposer = body()
            return typeof disposer === 'function' ? disposer : () => {}
          },
        }
        callback(webCtx)
      }
    },
    get(service) {
      if (options.services !== undefined && service in options.services) return options.services[service]
      return undefined
    },
  }
  return ctx
}

/** A directory holding no legacy configuration file. */
function emptyHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aa-apply-'))
}

/** Run `apply` with a temp DSH_HOME so the real user config is never read. */
function applyWith(rowConfig, ctx) {
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = emptyHome()
  try {
    apply(ctx, rowConfig)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
}

test('the module exports the plugin identity', () => {
  assert.equal(name, 'agent-alliance')
  assert.deepEqual(inject, ['tools'])
})

test('apply registers the six tools inside one effect', () => {
  const ctx = fakeCtx()
  applyWith({}, ctx)
  assert.equal(ctx.registrations.length, 6)
  assert.deepEqual(ctx.registrations.map((tool) => tool.name).sort(), [
    'agent_dispatch',
    'agent_import',
    'agent_import_scan',
    'agent_roundtable',
    'agent_session_read',
    'agent_sessions',
  ])
  assert.ok(ctx.effects.some((label) => /tools/.test(String(label))), 'tool registration must be an effect')
})

test('apply disposes every tool registration with its effect', () => {
  const ctx = fakeCtx()
  let disposeTools
  const originalEffect = ctx.effect
  ctx.effect = (body, label) => {
    const disposer = originalEffect(body, label)
    if (/tools/.test(String(label))) disposeTools = disposer
    return disposer
  }
  applyWith({}, ctx)
  assert.equal(ctx.registrations.length, 6)
  assert.equal(typeof disposeTools, 'function')
  disposeTools()
  assert.equal(ctx.registrations.length, 0)
})

test('apply accepts an empty, null, and undefined row config', () => {
  for (const rowConfig of [{}, undefined, null]) {
    const ctx = fakeCtx()
    applyWith(rowConfig, ctx)
    assert.equal(ctx.registrations.length, 6)
  }
})

test('apply registers the panel through ctx.inject(["webServer"])', () => {
  const ctx = fakeCtx({ withWebServer: true })
  applyWith({}, ctx)
  assert.deepEqual(ctx.injects, [['webServer']])
  assert.equal(ctx.routes.length, 1)
  assert.equal(ctx.routes[0].kind, 'prefix')
  assert.equal(ctx.routes[0].path, '/__agent-alliance')
})

test('apply does not mount the panel when panel.enabled is false', () => {
  const ctx = fakeCtx({ withWebServer: true })
  applyWith({ panel: { enabled: false } }, ctx)
  assert.equal(ctx.registrations.length, 6)
  assert.equal(ctx.injects.length, 0)
  assert.equal(ctx.routes.length, 0)
})

test('apply leaves the panel unmounted instead of failing when no web server appears', () => {
  const ctx = fakeCtx({ withWebServer: false })
  applyWith({}, ctx)
  assert.equal(ctx.injects.length, 1)
  assert.equal(ctx.routes.length, 0)
  assert.equal(ctx.registrations.length, 6)
})

test('an invalid row config fails loudly and registers nothing', () => {
  const ctx = fakeCtx()
  assert.throws(() => applyWith({ defaults: { timeoutMs: 'soon' } }, ctx), /defaults\.timeoutMs/)
  assert.equal(ctx.registrations.length, 0)
  assert.equal(ctx.warnings.length, 1)
  assert.equal(ctx.warnings[0][0], 'error')
  assert.match(ctx.warnings[0][1], /agent-alliance: configuration is invalid/)
})

test('a malformed legacy config file fails loudly and names the file', () => {
  const home = emptyHome()
  const file = path.join(home, 'dsh-agent-alliance.json')
  fs.writeFileSync(file, '{ not json')
  const ctx = fakeCtx()
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    assert.throws(() => apply(ctx, {}), (error) => {
      assert.ok(String(error.message).includes(file), 'error must name the file: ' + error.message)
      return true
    })
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
  assert.equal(ctx.registrations.length, 0)
})

test('apply reads a legacy file and lets the row config win', () => {
  const home = emptyHome()
  fs.writeFileSync(path.join(home, 'dsh-agent-alliance.json'), JSON.stringify({
    defaults: { defaultCwd: '/from/legacy' },
    providers: { zcode: { enabled: true } },
  }))
  const ctx = fakeCtx()
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    apply(ctx, { providers: { zcode: { enabled: false } } })
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
  assert.equal(ctx.registrations.length, 6)
  assert.equal(ctx.warnings.length, 0, 'a valid merged configuration must not warn')
})

test('opting out of the legacy file makes the row config authoritative', () => {
  const home = emptyHome()
  fs.writeFileSync(path.join(home, 'dsh-agent-alliance.json'), '{ this would fail to parse')
  const ctx = fakeCtx()
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    apply(ctx, { legacyConfigFile: false })
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
  assert.equal(ctx.registrations.length, 6)
})
