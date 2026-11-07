// src/backend.js — 后端解析：官方 subagent provider 优先，CLI provider 兜底。
// 规格：docs/SPEC-v2.md「Backend resolution (the alignment with official subagents)」。

const OFFICIAL_DETAIL = 'official subagent provider'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Cordis 服务既可能经 ctx.get(name) 取，也可能直接挂在 ctx 上；两者都缺失即视为没有。
// 直接属性访问在 Cordis 里会抛 `cannot get property ... without inject`，必须包住。
function serviceOf(ctx, name) {
  if (!isObject(ctx)) return undefined
  if (typeof ctx.get === 'function') {
    try {
      const service = ctx.get(name)
      if (service !== undefined) return service
    } catch (err) {
      // ctx.get 对未挂载的服务可能抛错；按“服务缺失”处理，绝不让插件启动失败。
    }
  }
  try {
    return ctx[name]
  } catch (err) {
    return undefined
  }
}

// 活体 Agent 的最低判定：有 id，且宿主 agents 服务能按 id 取回同一个对象。
// 没有 agents 服务（headless / CLI-only 装配）时只做结构判定，交给 startActivation 自己校验。
function isLiveAgent(ctx, parent) {
  if (!isObject(parent)) return false
  if (typeof parent.id !== 'string' || parent.id === '') return false
  const agents = serviceOf(ctx, 'agents')
  if (agents !== undefined && typeof agents.get === 'function') {
    try {
      return agents.get(parent.id) === parent
    } catch (err) {
      // agents 服务查询失败时按非活体处理，安全回退 CLI 路径。
      return false
    }
  }
  return true
}

function configuredSubagentName(config, providerId) {
  if (!isObject(config) || !isObject(config.providers)) return undefined
  const entry = config.providers[providerId]
  if (!isObject(entry)) return undefined
  const name = entry.subagentProvider
  return typeof name === 'string' && name !== '' ? name : undefined
}

// 只做注册表查询（list / getProvider），绝不启动任何任务。
function usableSubagentService(ctx, name) {
  const service = serviceOf(ctx, 'subagents')
  if (!isObject(service)) return undefined
  if (typeof service.list !== 'function' || typeof service.getProvider !== 'function') return undefined
  let registered
  try {
    registered = service.list()
  } catch (err) {
    return undefined
  }
  if (!Array.isArray(registered) || !registered.includes(name)) return undefined
  let provider
  try {
    provider = service.getProvider(name)
  } catch (err) {
    return undefined
  }
  return provider === undefined || provider === null ? undefined : service
}

/**
 * Names registered on the subagent service, or an empty list when it is absent.
 * @param {object} ctx plugin context
 * @returns {string[]} registered provider names
 */
function registeredSubagentNames(ctx) {
  const service = serviceOf(ctx, 'subagents')
  if (!isObject(service) || typeof service.list !== 'function') return []
  try {
    const names = service.list()
    return Array.isArray(names) ? names.map(String) : []
  } catch (err) {
    return []
  }
}

function subagentRoute(ctx, config, providerId, parent) {
  const name = configuredSubagentName(config, providerId)
  if (name === undefined) return undefined
  if (!isLiveAgent(ctx, parent)) return undefined
  const service = usableSubagentService(ctx, name)
  if (service === undefined) return undefined
  return { name, service }
}

// list() 用：缺 CLI 后端时返回 undefined，而不是抛错。
function cliLookup(registry, providerId) {
  if (!isObject(registry) || typeof registry.get !== 'function') return { found: false }
  if (typeof registry.has === 'function') {
    let has
    try {
      has = registry.has(providerId)
    } catch (err) {
      has = false
    }
    if (!has) return { found: false }
  } else if (typeof registry.list === 'function') {
    let listed
    try {
      listed = registry.list()
    } catch (err) {
      return { found: false }
    }
    if (!Array.isArray(listed) || !listed.some(provider => isObject(provider) && provider.id === providerId)) {
      return { found: false }
    }
  }
  try {
    return { found: true, provider: registry.get(providerId) }
  } catch (err) {
    return { found: false }
  }
}

// resolve() 用：未知 id 必须抛与 registry.get 相同的 `unknown provider: <id>`。
function cliOrThrow(registry, providerId) {
  const lookup = cliLookup(registry, providerId)
  if (lookup.found) return lookup.provider
  throw new Error('unknown provider: ' + providerId)
}

function backendLabel(provider, providerId) {
  if (isObject(provider) && typeof provider.label === 'string' && provider.label !== '') return provider.label
  return providerId
}

// 官方 subagent 结果是 ContentBlock[]：只取 text 块，按宿主既有约定拼接（同
// workflow-ptc 的 outputText：块文本直接相连，不插入分隔符）。
function blocksText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (isObject(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

function toPromptText(prompt) {
  if (typeof prompt === 'string') return prompt
  if (Array.isArray(prompt)) return blocksText(prompt)
  return prompt === undefined || prompt === null ? '' : String(prompt)
}

function promptLabel(providerId, text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (flat === '') return 'agent-alliance ' + providerId
  return flat.length > 60 ? flat.slice(0, 60) + '…' : flat
}

function hasResumeId(value) {
  return value !== undefined && value !== null && value !== ''
}

function resumeRejection(providerId, providerName) {
  // The two paths expose DIFFERENT things under `externalSessionId`: an official
  // run returns a DSH-minted id for one ephemeral thread (never resumable),
  // while a CLI run returns that vendor's own session id (resumable). Telling
  // the caller to "use the CLI provider" without saying the ids are not
  // interchangeable would send it looking for an official id that no CLI can
  // resume.
  return new Error(
    'resumeSessionId is not supported on the official subagent path for provider "' + providerId + '"'
    + ' (official provider "' + providerName + '" is one-shot and mints a fresh id per run).'
    + ' Those ids are not resumable and are not the same as the CLI provider\'s external session ids:'
    + ' to continue an external session, call the CLI provider with that provider\'s own session id'
    + ' (find them with agent_sessions)',
  )
}

/**
 * Rewrite a subagent pool rejection so the caller knows whose limit it hit.
 * @param {unknown} error original failure
 * @returns {unknown} the error, annotated when it is a pool rejection
 */
function annotatePoolRejection(error) {
  const code = isObject(error) ? error.code : undefined
  const message = String(error?.message || '')
  if (code !== 'ACTIVATION_LIMIT_REACHED' && !/ACTIVATION_LIMIT|active subagents/i.test(message)) return error
  const annotated = new Error(
    message + ' — the subagent service pool is full; another delegation (possibly the official'
    + ' subagent tool invoked directly by the model) holds it, not this plugin',
  )
  if (code !== undefined) annotated.code = code
  return annotated
}

function stopFailure(providerName, result) {
  const diagnostic = isObject(result) && typeof result.diagnostic === 'string' ? result.diagnostic : ''
  const stopReason = isObject(result) ? result.stopReason : undefined
  const error = new Error(
    diagnostic !== ''
      ? diagnostic
      : 'official subagent provider "' + providerName + '" stopped with stopReason "' + String(stopReason) + '"',
  )
  if (diagnostic !== '') error.diagnostic = diagnostic
  if (stopReason !== undefined) error.stopReason = stopReason
  return error
}

function cliBackend(providerId, provider) {
  return {
    id: providerId,
    label: backendLabel(provider, providerId),
    kind: 'cli',
    available: true,
    /**
     * Dispatch through the CLI provider. Delegates argument defaults and argv work
     * to the provider implementation; only measures duration and tags the backend.
     * @param {object} request dispatch request (`prompt` required)
     * @returns {Promise<{ text: string, stopReason?: string, externalSessionId: string|null,
     *                     durationMs: number, backend: 'cli' }>} normalized CLI result
     */
    async dispatch(request = {}) {
      const started = Date.now()
      const result = await provider.dispatch({
        prompt: request.prompt,
        cwd: request.cwd,
        resumeSessionId: request.resumeSessionId,
        model: request.model,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      })
      return {
        text: typeof result?.text === 'string' ? result.text : String(result?.text ?? ''),
        ...(result?.stopReason === undefined ? {} : { stopReason: result.stopReason }),
        externalSessionId: result?.externalSessionId ?? null,
        durationMs: Date.now() - started,
        backend: 'cli',
      }
    },
  }
}

function subagentBackend({ ctx, config, providerId, providerName, label, parent }) {
  return {
    id: providerId,
    label,
    kind: 'subagent',
    available: true,
    detail: OFFICIAL_DETAIL + ' "' + providerName + '"',
    /**
     * Run one delegation through the official subagent service.
     * The activation is always disposed exactly once. `resumeSessionId` is rejected
     * on this path because official providers are one-shot. `model` and `timeoutMs`
     * do not apply: official providers own their route and limits, and passing them
     * as start capabilities would be rejected by the seam.
     * @param {{ prompt: string|object[], cwd?: string, model?: string, signal?: AbortSignal,
     *           timeoutMs?: number, resumeSessionId?: string|null }} request dispatch request
     * @returns {Promise<{ text: string, stopReason: string, externalSessionId: string|null,
     *                     durationMs: number, backend: 'subagent' }>} normalized result
     */
    async dispatch(request = {}) {
      const started = Date.now()
      const text = toPromptText(request.prompt)
      const signal = request.signal ?? new AbortController().signal
      const route = subagentRoute(ctx, config, providerId, parent)
      if (route === undefined) {
        throw new Error(OFFICIAL_DETAIL + ' "' + providerName + '" is no longer registered')
      }
      // Reject a resume request before starting anything: official providers are
      // one-shot, and startActivation spawns a billed child plus a protocol
      // handshake. Guarding after it would charge the caller for an error that
      // was knowable up front, and a missing payload would mask the real reason.
      // Ordered after the route check so a provider that is no longer registered
      // is reported as such rather than as a resume problem.
      if (hasResumeId(request.resumeSessionId)) throw resumeRejection(providerId, providerName)
      let activation
      try {
        activation = await route.service.startActivation({
          provider: providerName,
          label: promptLabel(providerId, text),
          request: {
            prompt: [{ type: 'text', text }],
            parent,
            ...(typeof request.cwd === 'string' && request.cwd !== '' ? { cwd: request.cwd } : {}),
          },
          signal,
          delivery: 'caller',
        })
      } catch (error) {
        throw annotatePoolRejection(error)
      }
      let primary
      try {
        const result = await activation.result
        const outputText = isObject(result) ? blocksText(result.output) : ''
        const stopReason = isObject(result) ? result.stopReason : undefined
        if (stopReason !== 'completed' && outputText === '') throw stopFailure(providerName, result)
        return {
          text: outputText,
          stopReason,
          externalSessionId: activation.childId ?? null,
          durationMs: Date.now() - started,
          backend: 'subagent',
        }
      } catch (error) {
        primary = error
        throw error
      } finally {
        try {
          await activation.dispose()
        } catch (disposeError) {
          // 收尾失败不能顶替真正的派发失败：保留主错误，把收尾细节附在其上。
          if (primary === undefined) throw disposeError
          primary.disposeError = disposeError
        }
      }
    },
  }
}

/**
 * Create the backend resolver used by tools, roundtable, and HTTP dispatch.
 * Resolution prefers the official subagent backend named by
 * `config.providers[<id>].subagentProvider` when that provider is registered on
 * `ctx.subagents` and a live parent Agent is supplied; otherwise it returns the
 * CLI backend from `registry`. A missing `ctx.subagents` service keeps every
 * resolution on the CLI path and never throws for that reason.
 * @param {object} [options] resolver dependencies
 * @param {object} [options.ctx] plugin context; may lack `ctx.subagents`
 * @param {object} [options.registry] CLI provider registry (`list()` / `get(id)`)
 * @param {object} [options.config] resolved plugin config (`providers` map)
 * @returns {{ resolve(request: { provider: string, parent?: object }): object,
 *             list(parent?: object): object[] }} resolver with:
 *   `resolve` returns a backend `{ id, label, kind, available, detail?, dispatch(request) }`;
 *   `list` returns one backend info `{ id, label, kind, available, detail? }` per provider.
 */
export function createBackendResolver({ ctx, registry, config } = {}) {
  // 枚举顺序：CLI registry 顺序优先，其次补上仅出现在 config.providers 的 id。
  function providerIds() {
    const ids = []
    const seen = new Set()
    const add = (id) => {
      if (typeof id === 'string' && id !== '' && !seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
    if (isObject(registry) && typeof registry.list === 'function') {
      try {
        const listed = registry.list()
        if (Array.isArray(listed)) for (const provider of listed) add(provider?.id)
      } catch (err) {
        // CLI registry 列举失败时仍可用 config.providers 提供信息。
      }
    }
    if (isObject(config) && isObject(config.providers)) {
      for (const id of Object.keys(config.providers)) add(id)
    }
    return ids
  }

  /**
   * Resolve one backend for a model/user-supplied provider id.
   * @param {{ provider: string, parent?: object }} [request] provider id and the live Agent
   *   authorizing official delegation (absent for HTTP callers)
   * @returns {object} backend bound to `parent` for the official path
   * @throws {Error} `unknown provider: <id>` when neither path can serve the id
   */
  function resolve(request = {}) {
    const providerId = String(request.provider)
    const route = subagentRoute(ctx, config, providerId, request.parent)
    if (route !== undefined) {
      const cli = cliLookup(registry, providerId)
      return subagentBackend({
        ctx,
        config,
        providerId,
        providerName: route.name,
        label: backendLabel(cli.found ? cli.provider : undefined, providerId),
        parent: request.parent,
      })
    }
    return cliBackend(providerId, cliOrThrow(registry, providerId))
  }

  /**
   * List what `resolve` would pick for every configured provider.
   * Availability comes only from registry lookups; this never starts a run.
   * @param {object} [parent] live Agent used to evaluate the official path
   * @returns {Array<{ id: string, label: string, kind: 'subagent'|'cli',
   *                   available: boolean, detail?: string }>} backend info per provider
   */
  function list(parent) {
    const infos = []
    for (const providerId of providerIds()) {
      const route = subagentRoute(ctx, config, providerId, parent)
      if (route !== undefined) {
        const cli = cliLookup(registry, providerId)
        infos.push({
          id: providerId,
          label: backendLabel(cli.found ? cli.provider : undefined, providerId),
          kind: 'subagent',
          available: true,
          detail: OFFICIAL_DETAIL + ' "' + route.name + '"',
        })
        continue
      }
      const cli = cliLookup(registry, providerId)
      if (cli.found) {
        // The official provider is configured but unusable. Saying only "CLI"
        // would hide the common trap where a bundle's providerName differs from
        // the configured subagentProvider, so the official path silently never
        // activates.
        const wanted = configuredSubagentName(config, providerId)
        const registered = registeredSubagentNames(ctx)
        const reason = wanted === undefined
          ? undefined
          : registered.includes(wanted)
            ? 'registered but this call has no live parent Agent'
            : 'configured but not registered on ctx.subagents (is the bundle enabled, and does its'
              + ' providerName match "' + wanted + '"? registered: '
              + (registered.length > 0 ? registered.join(', ') : 'none') + ')'
        infos.push({
          id: providerId,
          label: backendLabel(cli.provider, providerId),
          kind: 'cli',
          available: true,
          ...(reason === undefined ? {} : { detail: OFFICIAL_DETAIL + ' "' + String(wanted) + '" ' + reason }),
        })
        continue
      }
      const name = configuredSubagentName(config, providerId)
      infos.push({
        id: providerId,
        label: providerId,
        kind: 'cli',
        available: false,
        detail: name === undefined
          ? 'no CLI provider registered'
          : 'no CLI provider registered; ' + OFFICIAL_DETAIL + ' "' + name + '" needs a live parent agent',
      })
    }
    return infos
  }

  return { resolve, list }
}
