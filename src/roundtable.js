// src/roundtable.js — 圆桌讨论编排：同一问题并发派发给多个外部 agent，收集结果；
// 支持多轮辩论（后续轮次可见其他 agent 的上一轮发言）。
// 综合分析交给调用方模型（DSH）完成——本模块只负责扇出、失败隔离与格式化。

function buildDebatePrompt(basePrompt, round, history) {
  if (round <= 1 || !history.length) return String(basePrompt)
  const peer = history
    .map(h => '【' + h.provider + '】\n' + String(h.text || '').slice(0, 2000))
    .join('\n\n')
  return [
    '【第' + round + '轮辩论】',
    '原始问题：',
    String(basePrompt),
    '',
    '其他 agent 的上一轮发言：',
    peer,
    '',
    '请针对上述观点进行回应、修正或补充你的结论（可以坚持原判，但需给出理由）。',
  ].join('\n')
}

export async function runRoundtable({ registry, prompt, providerIds, cwd, model, timeoutMs = 300000, signal, rounds = 1 }) {
  const R = Math.max(1, Math.min(3, Number(rounds) || 1))
  const ids = (providerIds && providerIds.length ? providerIds : registry.list().map(p => p.id))
  let history = [] // {provider, text} — 仅收录成功回答，供后续轮引用
  const debate = []
  for (let rn = 1; rn <= R; rn++) {
    const activeIds = rn === 1 ? ids : history.map(h => h.provider)
    const tasks = activeIds.map(async (id) => {
      const t0 = Date.now()
      try {
        const provider = registry.get(id) // 未知 id 会 throw → 记为该家失败
        const out = await provider.dispatch({
          prompt: buildDebatePrompt(prompt, rn, history), cwd, model, timeoutMs, signal,
        })
        return {
          provider: id, ok: true, text: out.text,
          externalSessionId: out.externalSessionId ?? null,
          durationMs: Date.now() - t0,
        }
      } catch (err) {
        return { provider: id, ok: false, error: String(err?.message || err), durationMs: Date.now() - t0 }
      }
    })
    const entries = await Promise.all(tasks)
    debate.push({ round: rn, entries })
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
