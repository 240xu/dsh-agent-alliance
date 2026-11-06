// dsh-agent-alliance: Host entry point.
//
// apply(ctx, config) resolves configuration, builds the CLI provider registry
// and the backend resolver, then registers the model tools and (when the
// composition mounts a web server) the panel's HTTP surface.
//
// Every registration goes through ctx.effect()/ctx.on() so an unload disposes
// it, and no failure is swallowed: a misconfiguration logs and rethrows, so the
// fiber fails visibly instead of leaving a half-registered plugin.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { buildProviders } from './providers.js'
import { createBackendResolver } from './backend.js'
import { registerTools } from './tools.js'
import { registerHttp } from './http.js'

/** Cordis function-plugin name. */
export const name = 'agent-alliance'

/**
 * Services the plugin reads. Only `tools` is mandatory: the panel routes and
 * background jobs attach later when their services appear.
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
 * Report one failure through the plugin logger when the context offers one.
 * @param {object} ctx plugin context
 * @param {string} level logger severity
 * @param {string} message human-readable message
 * @param {unknown} error failure detail
 * @returns {void}
 */
function logFailure(ctx, level, message, error) {
  const logger = ctx.logger
  const write = logger?.[level]
  if (typeof write !== 'function') return
  write.call(logger, 'agent-alliance: ' + message + ': ' + String(error?.message || error))
}

/**
 * Register the panel routes once a `webServer` service exists.
 *
 * The whole registration is one effect: it disposes the route when the plugin
 * fiber unloads. A missing web server is not an error (terminal presets mount
 * none), so the `inject` callback simply never runs there.
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
 * @param {object} [rowConfig] resolved row config from cordis.patch.yml
 * @returns {void}
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
  const options = { ctx, resolver, registry, config, home }

  ctx.effect(() => registerTools(ctx, options), 'agent-alliance: tools')

  // Providers may be disabled by config; a disabled provider stays registered so
  // the resolver can report it as unavailable instead of failing to resolve.
  if (config.panel?.enabled !== false) {
    registerPanel(ctx, options)
  }
}
