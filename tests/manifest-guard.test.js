import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(root + '/package.json', 'utf8'))

test('崩溃向量守卫：声明 client 面则必须有完整 client 入口', () => {
  const declaresClient = !!(pkg.exports?.['./client'] || pkg.dsh?.client)
  if (!declaresClient) {
    assert.ok(true, '当前为 host-only 形态（P1-P3），无 client 声明 —— 通过')
    return
  }
  // 一旦未来（P4）重新声明 client 面，必须同时满足：
  const entry = root + '/client/index.js'
  assert.ok(existsSync(entry), 'declared ./client but client/index.js missing — 这会让 dsh web 启动即崩（见 2026-08-21 事故报告）')
  const src = readFileSync(entry, 'utf8')
  assert.match(src, /__ModuleLoader__\.load/, 'client 入口缺 __ModuleLoader__.load 注册')
  assert.match(src, /apply/, 'client factory 必须导出带 apply 的插件对象')
})
