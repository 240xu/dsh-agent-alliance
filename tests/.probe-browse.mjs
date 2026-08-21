
import { loadConfig } from '../src/config.js'
import { buildProviders } from '../src/providers.js'
const reg = buildProviders({ config: loadConfig() })
for (const id of ['claude', 'codex', 'opencode']) {
  try {
    const p = reg.get(id)
    const list = await p.listSessions({ limit: 5 })
    console.log('[' + id + '] 会话数(前5):', list.length)
    for (const s of list.slice(0, 3)) {
      console.log('  -', s.id.slice(0, 18) + '…', '|', (s.title || '(无标题)').slice(0, 40), '|', s.cwd ? String(s.cwd).slice(0, 30) : '')
    }
    if (list[0]) {
      const r = await p.readSession(list[0].id, { maxChars: 300 })
      console.log('  readSession 首条:', JSON.stringify(r.messages?.[0]).slice(0, 120))
    }
  } catch (e) {
    console.log('[' + id + '] 失败:', String(e.message).slice(0, 160))
  }
}
