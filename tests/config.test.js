import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, defaultConfig } from '../src/config.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('缺文件返回内建默认', () => {
  const cfg = loadConfig(path.join(os.tmpdir(), 'aa-nonexistent-' + Date.now() + '.json'))
  assert.equal(cfg.providers.claude.enabled, true)
  assert.equal(cfg.providers.codex.enabled, true)
  assert.equal(cfg.providers.opencode.enabled, true)
  assert.equal(cfg.providers.zcode.enabled, false)
  assert.equal(cfg.defaults.timeoutMs, 300000)
  assert.equal(cfg.defaults.maxConcurrent, 3)
})

test('用户配置深合并覆盖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cfg-'))
  const file = path.join(dir, 'cfg.json')
  fs.writeFileSync(file, JSON.stringify({
    providers: { zcode: { enabled: true, commandTemplate: 'zcode -p {prompt}' } },
    defaults: { timeoutMs: 5000 },
  }))
  const cfg = loadConfig(file)
  assert.equal(cfg.providers.zcode.enabled, true)
  assert.equal(cfg.providers.zcode.commandTemplate, 'zcode -p {prompt}')
  // 未覆盖项保留默认
  assert.equal(cfg.providers.claude.enabled, true)
  assert.equal(cfg.defaults.maxConcurrent, 3)
  assert.equal(cfg.defaults.timeoutMs, 5000)
})

test('坏 JSON 大声报错并带文件名', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cfg-'))
  const file = path.join(dir, 'bad.json')
  fs.writeFileSync(file, '{oops')
  assert.throws(() => loadConfig(file), /bad\.json/)
})

test('defaultConfig 是全新对象（调用方可自由改写）', () => {
  const a = defaultConfig()
  a.defaults.timeoutMs = 1
  assert.equal(defaultConfig().defaults.timeoutMs, 300000)
})
