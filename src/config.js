// src/config.js — ~/.dsh/dsh-agent-alliance.json 读取与默认值合并。
// 先例：dsh-ssh 的 ~/.dsh/dsh-ssh.json。坏 JSON 大声抛错（带文件名），缺文件给默认。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function defaultConfig() {
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
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function deepMerge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v
  }
  return out
}

export function configPath(explicit) {
  return explicit || join(homedir(), '.dsh', 'dsh-agent-alliance.json')
}

export function loadConfig(explicit) {
  const file = configPath(explicit)
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return defaultConfig()
    throw new Error('读取配置失败 ' + file + ': ' + String(err?.message || err))
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error('配置不是合法 JSON: ' + file + ' (' + String(err?.message || err) + ')')
  }
  if (!isPlainObject(parsed)) throw new Error('配置顶层必须是对象: ' + file)
  return deepMerge(defaultConfig(), parsed)
}
