// dsh-agent-alliance: Host entry point.
//
// apply(ctx, config) resolves configuration, builds the CLI provider registry
// and the backend resolver, then registers the model tools and (when the
// composition mounts a web server) the panel's HTTP surface.
//
// Every registration goes through ctx.effect() so an unload disposes it, and no
// failure is swallowed: a misconfiguration logs and rethrows, so the fiber fails
// visibly instead of leaving a half-registered plugin behind.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './src/config.js'
import { buildProviders } from './src/providers.js'
import { createBackendResolver } from './src/backend.js'
import { registerTools } from './src/tools.js'
import { registerHttp } from './src/http.js'

/** Cordis function-plugin name. */
export const name = 'agent-alliance'

/**
 * Services the plugin requires. Every other service (`jobs`, `webServer`,
 * `connection`, `sessionPersistence`, …) is optional and read through
 * `ctx.get(name)`; a bare property read of a non-injected service throws.
 */
export const inject = ['tools']

/**
 * Filesystem root for plugin state: the import ledger lives under
 * `<home>/agent-alliance/imports.json`.
 * @returns {string} absolute DSH home directory
 */
function resolveHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * Read one optional Cordis service without declaring it in `inject`.
 *
 * `ctx.get(name)` returns undefined for a service this plugin did not inject; a
 * bare property read would throw "cannot get property ... without inject", so it
 * is only attempted as a fallback for plain-object contexts.
 * @param {object} ctx plugin context
 * @param {string} service service name
 * @returns {object|undefined} the service, or undefined when absent
 */
function serviceOf(ctx, service) {
  if (typeof ctx?.get === 'function') {
    try {
      const resolved = ctx.get(service)
      if (resolved !== undefined) return resolved
    } catch {
      // `get` threw for a service outside this plugin's injected set.
    }
  }
  try {
    return ctx?.[service] ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Build the persistence-facing context handed to the importer.
 *
 * The importer reads `sessionPersistence`, `sessionProjectionCache`, and
 * `workspaceRegistry` as properties; those are optional here and must never be
 * read bare from the plugin context, so this facade resolves each one through
 * `ctx.get()`.
 * @param {object} ctx plugin context
 * @returns {object} facade with `get` and lazily resolved optional services
 */
function importContext(ctx) {
  return {
    get(service) {
      return serviceOf(ctx, service)
    },
    get sessionPersistence() {
      return serviceOf(ctx, 'sessionPersistence')
    },
    get sessionProjectionCache() {
      return serviceOf(ctx, 'sessionProjectionCache')
    },
    get workspaceRegistry() {
      return serviceOf(ctx, 'workspaceRegistry')
    },
  }
}

/**
 * Report one failure through the plugin logger when the context offers one.
 * @param {object} ctx plugin context
 * @param {string} level logger severity (`warn` or `error`)
 * @param {string} message human-readable message
 * @param {unknown} error failure detail
 * @returns {void}
 */
function logFailure(ctx, level, message, error) {
  const write = ctx.logger?.[level]
  if (typeof write !== 'function') return
  write.call(ctx.logger, 'agent-alliance: ' + message + ': ' + String(error?.message || error))
}

/**
 * Register the panel routes once a `webServer` service exists.
 *
 * The whole registration is one effect, so the route disposer is owned by the
 * plugin fiber. A composition without a web server (a terminal preset) simply
 * never runs the callback; that is not an error.
 * @param {object} ctx plugin context
 * @param {object} options shared dependencies for the router
 * @returns {void}
 */
function registerPanel(ctx, options) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => registerHttp(webCtx.webServer, options), 'agent-alliance: panel routes')
  })
}

/**
 * Plugin entry point.
 * @param {object} ctx plugin context; `ctx.tools` is required
 * @param {object} [rowConfig] the `config` block of the cordis.patch.yml row
 * @returns {void}
 * @throws {Error} when the configuration is invalid or a registration fails
 */
export function apply(ctx, rowConfig = {}) {
  let config
  try {
    config = loadConfig(rowConfig)
  } catch (error) {
    logFailure(ctx, 'error', 'configuration is invalid', error)
    throw error
  }

  const home = resolveHome()
  const registry = buildProviders({ config })
  const resolver = createBackendResolver({ ctx, registry, config })
  const options = { ctx, io: importContext(ctx), resolver, registry, config, home }

  ctx.effect(() => registerTools(ctx, options), 'agent-alliance: tools')

  if (config.panel?.enabled !== false) registerPanel(ctx, options)
}
