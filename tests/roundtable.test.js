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

test('round 2 keeps the question as a strict prefix and withholds the member own answer', async () => {
  const seen = []
  const makeMember = (id) => ({
    id,
    label: id,
    async dispatch({ prompt }) {
      seen.push({ id, prompt })
      return { text: id + '-answer' }
    },
  })
  const members = new Map([['a', makeMember('a')], ['b', makeMember('b')]])
  const registry = { list: () => [...members.values()], get: (id) => members.get(id) }

  const question = 'Explain the tradeoff between latency and cost.'
  await runRoundtable({ registry, prompt: question, rounds: 2 })

  const second = seen.filter((entry) => entry.prompt !== question)
  assert.equal(second.length, 2, 'each member runs once in round 2')
  for (const { id, prompt } of second) {
    // Prefix preservation is what lets a provider cache reuse round 1's work.
    assert.ok(prompt.startsWith(question), 'round 2 must open with the verbatim question')
    assert.ok(prompt.includes('第2轮'), 'round 2 still announces the debate round')
    // A member is not one of "other agents".
    assert.ok(!prompt.includes(id + '-answer'), 'a member must not be shown its own answer as a peer claim')
    const other = id === 'a' ? 'b' : 'a'
    assert.ok(prompt.includes(other + '-answer'), 'the other member answer must be present')
  }
})

test('every round reports whether its prompt strictly extends the question', async () => {
  const { runRoundtable } = await import('../src/roundtable.js')
  const sent = []
  const provider = (id) => ({
    id,
    async dispatch({ prompt }) { sent.push({ id, prompt }); return { text: 'answer from ' + id } },
  })
  const registry = { list: () => [{ id: 'a' }, { id: 'b' }], get: (id) => provider(id) }
  const result = await runRoundtable({ registry, prompt: 'Q', rounds: 3 })

  for (const round of result.debate) {
    // The invariant that makes prompt-cache reuse possible: round 2 onward must
    // begin with the untouched question, not a rewritten header.
    assert.equal(round.strictPrefix, true, `round ${round.round} broke the strict prefix`)
    assert.equal(round.basePromptChars, 1)
    for (const prefix of round.prefixes) {
      assert.equal(prefix.strictPrefix, true)
      // Round 1 sends the bare question, so the shared region is all of it.
      if (round.round === 1) assert.equal(prefix.sharedPrefixChars, 1)
    }
  }
  // Round 2 must actually start with 'Q' — verified from the prompt we sent,
  // not from the builder's source.
  const round2 = sent.filter((entry) => entry.prompt.startsWith('Q') && entry.prompt !== 'Q')
  assert.ok(round2.length > 0, 'round 2 prompts must extend the question')
})

test('the round marker sits after the peer block so round N+1 reuses it', async () => {
  const { runRoundtable } = await import('../src/roundtable.js')
  const sent = []
  const provider = {
    id: 'a',
    async dispatch({ prompt }) {
      sent.push(prompt)
      return { text: 'answer for this round ' + 'x'.repeat(1200) }
    },
  }
  // TWO members: `buildDebatePrompt` excludes a member's own answer, so a
  // single provider yields an empty peer block and this test would compare the
  // question against itself — passing without exercising the layout at all.
  const registry = { list: () => [{ id: 'a' }, { id: 'b' }], get: (id) => ({ ...provider, id }) }
  await runRoundtable({ registry, prompt: 'Q'.repeat(400), rounds: 3 })

  // Round 2 and round 3 differ only in the trailing round marker and the
  // (changed) peer answer. The round marker must NOT precede the peer block:
  // putting it first diverges ~400 chars in and re-bills the whole block.
  const [r1] = sent
  const r2 = sent.find((p, i) => i > 0 && p.startsWith('Q'.repeat(400) + '\n\n---'))
  const r3s = sent.filter((p, i) => i > 0 && p.startsWith('Q'.repeat(400) + '\n\n---'))
  const r3 = r3s[r3s.length - 1]
  assert.ok(r2 !== undefined && r3 !== undefined, 'later rounds must carry a peer block')
  const commonR2R3 = (() => {
    let i = 0
    while (i < Math.min(r2.length, r3.length) && r2[i] === r3[i]) i += 1
    return i
  })()
  // The round marker must not appear before the peer block: if it did, r2 and
  // r3 would diverge at ~400 chars (the question) instead of inside the peer
  // answers, and the whole peer block would be re-billed.
  // Locate the peer answer text and the round marker; the answer must come
  // first. Comparing marker position against the question length alone would
  // still pass when the marker sits just after `---`, which is exactly the bug.
  const markerAtR2 = r2.indexOf('【第2轮辩论】')
  const peerTextAtR2 = r2.indexOf('answer for this round')
  assert.ok(peerTextAtR2 > 0, 'round 2 must contain a peer answer')
  assert.ok(peerTextAtR2 < markerAtR2,
    'the peer answer must precede the round marker, or every round re-bills the peer block')
  assert.ok(commonR2R3 > 400, `round 3 reused only ${commonR2R3} chars of round 2`)
  // Both rounds still start with the untouched question.
  assert.ok(r2.startsWith('Q'.repeat(400)) && r3.startsWith('Q'.repeat(400)))
  assert.ok(r1 === 'Q'.repeat(400), 'round 1 is the bare question')
})

test('a failed member does not falsify the round-level prefix verdict', async () => {
  const { runRoundtable } = await import('../src/roundtable.js')
  const registry = {
    list: () => [{ id: 'ok' }, { id: 'bad' }],
    get: (id) => ({
      id,
      async dispatch({ prompt }) {
        if (id === 'bad') throw new Error('this member is down')
        return { text: 'fine' }
      },
    }),
  }
  const result = await runRoundtable({ registry, prompt: 'Q', rounds: 2 })
  const round2 = result.debate[1]
  // Only members that actually received a prompt can testify. Including the
  // failed one would report strictPrefix=false and hide whether the layout is
  // sound, conflating "layout broke" with "a provider failed".
  assert.equal(round2.strictPrefix, true)
  assert.deepEqual(round2.prefixes.map((entry) => entry.provider), ['ok'])
  assert.equal(round2.vsPreviousRound[0].comparable, true)
})
