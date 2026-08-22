// dsh-agent-alliance: Host 半边入口。
// apply(ctx)：config → providers → registry → 注册工具。
// 防御性容错：任何初始化失败只记日志，绝不拖垮宿主启动（session-delete 先例）。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { buildProviders } from './providers.js'
import { registerTools } from './tools.js'
import { registerHttp } from './http.js'

const name = 'agent-alliance'
// home 用于导入台账（~/.dsh/agent-alliance/imports.json）
const inject = ['tools', 'jobs']

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
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const registry = buildProviders({ config })
    const opts = { registry, config, home, ctx }
    registerTools(ctx, opts)

    // 面板端点（可选 webServer）：终端 profile 不挂；web 面出现时经 inject 兜底注册
    const jobsSvc = ctx.get('jobs')
    if (jobsSvc && typeof jobsSvc.start === 'function') {
      opts.startJob = (spec) => jobsSvc.start(spec)
    }

    const ws = ctx.get('webServer')
    if (ws !== undefined && typeof ws.register === 'function') {
      registerHttp(ws, opts)
      console.log('[agent-alliance] panel endpoints registered under /__agent-alliance/')
    } else if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (sub) => {
        try {
          registerHttp(sub.webServer, opts)
          console.log('[agent-alliance] panel endpoints registered (late webServer)')
        } catch (err) {
          console.error('[agent-alliance] http registration failed:', err?.message || err)
        }
      })
    }
    console.log('[agent-alliance] tools registered: dispatch / roundtable / sessions / session_read / import_scan / import')
  } catch (err) {
    console.error('[agent-alliance] init failed (plugin disabled this boot):', err?.message || err)
  }
}

export { apply, inject, name }
