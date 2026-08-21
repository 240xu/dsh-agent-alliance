
import { loadConfig } from '../src/config.js'
import { buildProviders } from '../src/providers.js'
const config = loadConfig()
const reg = buildProviders({ config })
const states = await reg.detectAll()
for (const s of states) console.log(s.id.padEnd(10), s.available ? 'OK ' + (s.version || '') : 'NO (' + (s.detail || '').slice(0, 140) + ')')
