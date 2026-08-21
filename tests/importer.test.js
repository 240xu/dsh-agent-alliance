import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadLedger, saveLedger, importOne } from '../src/importer/persist.js'
import { createRegistry } from '../src/provider/types.js'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aa-home-'))
}

function makeCtx(home) {
  const created = []
  const ctx = {
    __created: created,
    get(name) {
      if (name === 'agents') {
        return { create: async (spec) => { created.push(spec); return { id: spec.sessionId } } }
      }
      return undefined
    },
  }
  ctx.__home = home
  return ctx
}

const extProvider = {
  id: 'ext',
  label: 'Ext',
  dispatch: async () => ({ text: '' }),
  exportSession: async (id) => ({
    title: '外部标题',
    createdAt: 1700000000000,
    cwd: '/ext/w',
    turns: [
      { user: '问1', assistant: '答1' },
      { user: '问2', assistant: '答2' },
    ],
  }),
}

test('importOne：走 agents.create 落库，meta 带 cwd、seed 为合法事件流', async () => {
  const home = tmpHome()
  const ctx = makeCtx(home)
  const reg = createRegistry([extProvider])
  const r = await importOne(ctx, { registry: reg, provider: extProvider.id, externalId: 'e1', home })
  assert.equal(r.status, 'imported')
  assert.ok(r.dshSessionId)
  assert.equal(ctx.__created.length, 1)
  const spec = ctx.__created[0]
  assert.equal(spec.sessionId, r.dshSessionId)
  assert.ok(Array.isArray(spec.seed) && spec.seed.length > 5)
  assert.equal(spec.seed[0].type, 'turn/start')
  assert.equal(spec.meta.cwd, '/ext/w')
  // 幂等：重复导入跳过
  const r2 = await importOne(ctx, { registry: reg, provider: extProvider.id, externalId: 'e1', home })
  assert.equal(r2.status, 'already-imported')
  assert.equal(ctx.__created.length, 1)
})

test('ledger 持久化与读取', async () => {
  const home = tmpHome()
  saveLedger(home, { 'ext:e9': { dshSessionId: 's9', importedAt: 1 } })
  const led = loadLedger(home)
  assert.equal(led['ext:e9'].dshSessionId, 's9')
})

test('agents 服务缺失时回退 sessionPersistence', async () => {
  const home = tmpHome()
  const calls = []
  const ctx = {
    get(name) {
      if (name === 'sessionPersistence') {
        return {
          create: async (meta) => { calls.push(['create', meta]); },
          append: async (id, events) => { calls.push(['append', id, events.length]) },
        }
      }
      return undefined
    },
  }
  const reg = createRegistry([extProvider])
  const r = await importOne(ctx, { registry: reg, provider: 'ext', externalId: 'e2', home })
  assert.equal(r.status, 'imported')
  assert.deepEqual(calls.map(c => c[0]), ['create', 'append'])
})
