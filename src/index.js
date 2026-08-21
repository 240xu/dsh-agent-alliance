// dsh-agent-alliance: Host 半边入口。
// apply(ctx)：config → providers → registry → 注册工具。
// 防御性容错：任何初始化失败只记日志，绝不拖垮宿主启动（session-delete 先例）。

import { loadConfig } from './config.js'
import { buildProviders } from './providers.js'
import { registerTools } from './tools.js'

const name = 'agent-alliance'
const inject = ['tools']

function apply(ctx, overrides = {}) {
  try {
    let config
    if (overrides.config) {
      config = overrides.config
    } else if (overrides.configError) {
      throw overrides.configError
    } else {
      config = loadConfig()
    }
    const registry = buildProviders({ config })
    registerTools(ctx, { registry, config })
    console.log('[agent-alliance] tools registered: agent_dispatch / agent_roundtable / agent_sessions / agent_session_read')
  } catch (err) {
    console.error('[agent-alliance] init failed (plugin disabled this boot):', err?.message || err)
  }
}

export { apply, inject, name }
