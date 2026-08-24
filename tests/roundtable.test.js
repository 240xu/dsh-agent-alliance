import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runRoundtable } from '../src/roundtable.js'
import { createRegistry } from '../src/provider/types.js'

function prov(id, text, ms = 10) {
  return {
    id, label: id,
    dispatch: async ({ prompt }) => {
      await new Promise(r => setTimeout(r, ms))
      if (text === null) throw new Error(id + ' 爆了')
      return { text: text + ':' + prompt, externalSessionId: 'ext-' + id }
    },
  }
}

test('并发派发多 provider，全部成功', async () => {
  const reg = createRegistry([prov('a', '答A'), prov('b', '答B')])
  const r = await runRoundtable({ registry: reg, prompt: '问题Q', providerIds: ['a', 'b'], timeoutMs: 5000 })
  assert.equal(r.rounds.length, 2)
  const a = r.rounds.find(x => x.provider === 'a')
  assert.equal(a.ok, true)
  assert.equal(a.text, '答A:问题Q')
  assert.equal(a.externalSessionId, 'ext-a')
  assert.ok(a.durationMs >= 0)
})

test('单家失败不拖垮全场（失败隔离）', async () => {
  const reg = createRegistry([prov('good', '好答案'), prov('bad', null)])
  const r = await runRoundtable({ registry: reg, prompt: 'q', providerIds: ['good', 'bad'] })
  assert.equal(r.rounds.find(x => x.provider === 'good').ok, true)
  const bad = r.rounds.find(x => x.provider === 'bad')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /爆了/)
})

test('未知 provider 记为失败而不是抛出', async () => {
  const reg = createRegistry([prov('a', 'x')])
  const r = await runRoundtable({ registry: reg, prompt: 'q', providerIds: ['a', 'ghost'] })
  assert.equal(r.rounds.length, 2)
  assert.equal(r.rounds.find(x => x.provider === 'ghost').ok, false)
})

test('缺省 providerIds = 全部可用成员', async () => {
  const reg = createRegistry([prov('a', '1'), prov('b', '2'), prov('c', '3')])
  const r = await runRoundtable({ registry: reg, prompt: 'q' })
  assert.deepEqual(r.rounds.map(x => x.provider).sort(), ['a', 'b', 'c'])
})

test('formatRoundtable 输出对比文本', async () => {
  const reg = createRegistry([prov('a', '答A'), prov('bad', null)])
  const r = await runRoundtable({ registry: reg, prompt: 'q', providerIds: ['a', 'bad'] })
  const text = formatRoundtableText(r)
  assert.match(text, /\[a\]/)
  assert.match(text, /答A:q/)
  assert.match(text, /\[bad\].*失败/s)
})
import { formatRoundtableText } from '../src/roundtable.js'


test('辩论轮数：第 2 轮 prompt 携带其他 agent 的上一轮发言', async () => {
  const seen = []
  const spy = (id, text) => ({
    id, label: id,
    dispatch: async ({ prompt }) => { seen.push({ id, prompt }); return { text: text + '<<<' + id } },
  })
  const reg = createRegistry([spy('a', '观点A'), spy('b', '观点B')])
  const r = await runRoundtable({ registry: reg, prompt: '问题Q', providerIds: ['a', 'b'], rounds: 2 })
  assert.equal(r.debate.length, 2)
  assert.equal(r.debate[0].round, 1)
  assert.equal(r.debate[1].round, 2)
  // 第 2 轮 a 收到的 prompt 应包含 b 的第 1 轮发言，反之亦然
  const pA = seen.filter(x => x.id === 'a')[1].prompt
  const pB = seen.filter(x => x.id === 'b')[1].prompt
  assert.match(pA, /【b】[\s\S]*观点B/)
  assert.match(pB, /【a】[\s\S]*观点A/)
  assert.match(pA, /第2轮辩论/)
})

test('失败隔离：失败者不进入下一轮历史，但仍参与下一轮提问？——不：仅成功者续轮', async () => {
  const seen = []
  const mk = (id) => ({
    id, label: id,
    dispatch: async ({ prompt }) => {
      seen.push(id)
      if (id === 'bad') throw new Error('x')
      return { text: 'ok-' + id }
    },
  })
  const reg = createRegistry([mk('good'), mk('bad')])
  const r = await runRoundtable({ registry: reg, prompt: 'q', providerIds: ['good', 'bad'], rounds: 2 })
  // 第 2 轮只有成功者 good 继续
  assert.equal(r.debate[1].entries.length, 1)
  assert.equal(r.debate[1].entries[0].provider, 'good')
})

test('rounds 越界钳制到 1..3', async () => {
  let calls = 0
  const counter = { id: 'c', label: 'c', dispatch: async () => { calls++; return { text: 't' } } }
  const reg = createRegistry([counter])
  await runRoundtable({ registry: reg, prompt: 'q', providerIds: ['c'], rounds: 99 })
  assert.equal(calls, 3)
})
