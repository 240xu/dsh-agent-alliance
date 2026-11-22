// src/roundtable.js — 圆桌讨论编排：同一问题并发派发给多个外部 agent，收集结果；
// 支持多轮辩论（后续轮次可见其他 agent 的上一轮发言）。
// 综合分析交给调用方模型（DSH）完成——本模块只负责扇出、失败隔离与格式化。

/**
 * Build the prompt one member receives in a given round.
 *
 * Round 1 is the bare question. Later rounds keep that question as a **strict
 * prefix** and append the debate material after it, so a provider's prompt
 * cache can reuse the already-processed prefix. Opening with the round header
 * would diverge from round 1 at the first byte and forfeit that reuse.
 * @param {string} basePrompt the question every member receives
 * @param {number} round 1-based round number
 * @param {Array<{provider: string, text: string}>} history peers' previous answers
 * @param {string} [selfId] receiving member's id, whose own answer is withheld
 * @returns {string} the prompt for this member in this round
 */
function buildDebatePrompt(basePrompt, round, history, selfId) {
  const question = String(basePrompt)
  if (round <= 1 || !history.length) return question
  const peers = selfId === undefined ? history : history.filter((entry) => entry.provider !== selfId)
  if (peers.length === 0) return question
  const peer = peers
    .map(h => '【' + h.provider + '】\n' + String(h.text || '').slice(0, 2000))
    .join('\n\n')
  // The round number and instructions go AFTER the peer block, not before it.
  // Putting them first makes round N and round N+1 diverge at the round header
  // (~1,049 chars into a production-sized prompt), so the entire peer block
  // gets re-billed every round: measured reuse was 20.6% of round 2. With the
  // stable parts first, reuse rises to up to 99.7% when peer answers are
  // unchanged, and the remaining loss is only the answers that genuinely
  // changed — which no prompt layout can avoid.
  return [
    question,
    '',
    '---',
    '',
    peer,
    '',
    '【第' + round + '轮辩论】',
    '请针对上述观点进行回应、修正或补充你的结论（可以坚持原判，但需给出理由）。',
  ].join('\n')
}

export async function runRoundtable({ registry, prompt, providerIds, cwd, model, timeoutMs = 300000, signal, rounds = 1 }) {
  const R = Math.max(1, Math.min(3, Number(rounds) || 1))
  const ids = (providerIds && providerIds.length ? providerIds : registry.list().map(p => p.id))
  let history = [] // {provider, text} — 仅收录成功回答，供后续轮引用
  // Per round, the prompt each member actually received. Cache reuse is a
  // round-over-round property, so the previous round's prompts must be kept.
  const promptsByRound = []
  const debate = []
  for (let rn = 1; rn <= R; rn++) {
    const activeIds = rn === 1 ? ids : history.map(h => h.provider)
    const tasks = activeIds.map(async (id) => {
      const t0 = Date.now()
      try {
        const provider = registry.get(id) // 未知 id 会 throw → 记为该家失败
        const promptSent = buildDebatePrompt(prompt, rn, history, id)
        const out = await provider.dispatch({
          prompt: promptSent, cwd, model, timeoutMs, signal,
        })
        return {
          provider: id, ok: true, text: out.text,
          externalSessionId: out.externalSessionId ?? null,
          durationMs: Date.now() - t0,
          // The exact prompt this member received, so the prefix invariant is
          // checkable from the result instead of trusted from the code.
          promptSent,
          ...(out.usage === undefined ? {} : { usage: out.usage }),
        }
      } catch (err) {
        return { provider: id, ok: false, error: String(err?.message || err), durationMs: Date.now() - t0 }
      }
    })
    const entries = await Promise.all(tasks)
    // Report the cache-relevant facts instead of asserting them in prose. A
    // strict prefix is what lets a provider's prompt cache reuse the already
    // processed region; the character count is how much of it is shared.
    const base = String(prompt)
    // Only members that actually received a prompt can testify about the
    // prefix. A failed member never sent anything, so including it would make
    // the round-level flag false and blur "the layout broke" into "someone
    // failed" — two problems with different fixes.
    const shared = entries
      .filter((entry) => typeof entry.promptSent === 'string')
      .map((entry) => {
        const sent = entry.promptSent
        const strictPrefix = rn === 1 ? sent === base : sent.startsWith(base)
        let common = 0
        const min = Math.min(sent.length, base.length)
        while (common < min && sent.charCodeAt(common) === base.charCodeAt(common)) common += 1
        return { provider: entry.provider, strictPrefix, sharedPrefixChars: common }
      })
    // What cache reuse actually depends on is round N vs round N-1, not round N
    // vs the original question.
    const previousPrompts = rn === 1 ? undefined : promptsByRound[rn - 2]
    const vsPrevious = rn === 1 || previousPrompts === undefined
      ? undefined
      : entries
        .filter((entry) => typeof entry.promptSent === 'string')
        .map((entry) => {
          const sent = entry.promptSent
          const prev = previousPrompts.find((item) => item.provider === entry.provider)
          if (prev === undefined) return { provider: entry.provider, strictPrefix: false, sharedPrefixChars: 0, comparable: false }
          let common = 0
          const min = Math.min(sent.length, prev.prompt.length)
          while (common < min && sent.charCodeAt(common) === prev.prompt.charCodeAt(common)) common += 1
          return {
            provider: entry.provider,
            strictPrefix: sent.startsWith(prev.prompt),
            sharedPrefixChars: common,
            comparable: true,
          }
        })
    promptsByRound.push(entries
      .filter((entry) => typeof entry.promptSent === 'string')
      .map((entry) => ({ provider: entry.provider, prompt: entry.promptSent })))
    debate.push({
      round: rn,
      entries,
      basePromptChars: base.length,
      ...(rn === 1 ? {} : { previousPromptChars: promptsByRound[rn - 2].map((item) => item.prompt.length) }),
      prefixes: shared,
      strictPrefix: shared.every((item) => item.strictPrefix),
      ...(vsPrevious === undefined ? {} : { vsPreviousRound: vsPrevious }),
    })
    for (const e of entries) {
      if (!e.ok) continue
      const prev = history.findIndex(h => h.provider === e.provider)
      const item = { provider: e.provider, text: e.text }
      if (prev >= 0) history[prev] = item
      else history.push(item)
    }
  }
  return { prompt: String(prompt), debate, rounds: debate[debate.length - 1].entries }
}

export function formatRoundtableText(result) {
  const debate = Array.isArray(result.debate) && result.debate.length
    ? result.debate
    : [{ round: 1, entries: result.rounds || [] }]
  const multi = debate.length > 1
  const lines = ['圆桌问题: ' + result.prompt, '']
  for (const rd of debate) {
    if (multi) lines.push('━━ 第 ' + rd.round + ' 轮 ━━', '')
    for (const r of rd.entries) {
      if (r.ok) {
        const head = '[' + r.provider + ']' + (r.externalSessionId ? ' (会话 ' + r.externalSessionId + ', ' + r.durationMs + 'ms)' : ' (' + r.durationMs + 'ms)')
        lines.push(head)
        const txt = String(r.text || '')
        lines.push(txt.length > 4000 ? txt.slice(0, 4000) + '\n…(截断)' : txt)
      } else {
        lines.push('[' + r.provider + '] 失败: ' + r.error)
      }
      lines.push('')
    }
  }
  const last = debate[debate.length - 1].entries
  const okCount = last.filter(r => r.ok).length
  lines.unshift(multi
    ? ('共 ' + debate.length + ' 轮 / 末轮参与 ' + last.length + ' 家 / 成功 ' + okCount + ' 家')
    : ('参与 ' + last.length + ' 家 / 成功 ' + okCount + ' 家'))
  return lines.join('\n')
}
